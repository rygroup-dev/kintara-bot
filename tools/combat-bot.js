#!/usr/bin/env node
// ============ COMBAT BOT — Wilderness hunting (Path A, headless) ============
// Server-authoritative mobs: the hub broadcasts position and HP in snap.npcs.wildMobs.
// Flow: login -> bank all loot for safety -> queue + presence -> enter Wilderness
// through the north portal -> hunt the nearest zombie (walk adjacent -> wm_ev hit until dead).
// Combat XP is granted by the server through skill_xp pushes, daily zombie quest progress via wm_ev by=me.
//
// STRICT SURVIVAL:
//  - BANK-FIRST is mandatory to avoid carried-loot loss on death.
//  - Monitor HP (wild_mb_ack/pvit/snap). HP<=POTION_HP -> consumePotion health.
//    HP<=SHIELD_HP -> use potion_shield. HP<=RETREAT_HP or no potions left -> retreat
//    to the safe camp and exit to Mainland. The bot never sends wmb contact events,
//    so mobs should not damage us; the real risk is PvP. Retreat remains a safety net.
//
// Usage: node tools/combat-bot.js [shard=s2]
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { Presence } = require('../lib/presenceWs');
const { KintaraClient } = require('../lib/kintaraClient');
const { login, isWalletBannedError } = require('../lib/walletAuth');
const bank = require('../lib/bank');

const SHARD = process.argv[2] || config.shard || 's2';
const OUT = path.join(__dirname, '..', 'recon');
const PIDFILE = path.join(OUT, 'control', 'combatbot.pid');
const STATEFILE = path.join(OUT, 'combat-state.json');
const LOGFILE = path.join(OUT, 'combat.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); try { fs.appendFileSync(LOGFILE, s + '\n'); } catch {} };
const lt = {}; const logT = (k, m, ms = 30000) => { const n = Date.now(); if (!lt[k] || n - lt[k] > ms) { lt[k] = n; log(m); } };

// ---- coords ----
const MAIN_OFF = -30.5;                       // mainland world x=col-30.5
const NORTH_PORTAL = { x: 30 - 30.5, z: 0 - 30.5 }; // col30,row0 = (-0.5,-30.5)
const WILD_OFF = -24.5;                        // wild world x=col-24.5
const SAFE_CAMP = { col: 25, row: 47 };        // rows 45-49 = no mob spawn
const wildWorld = (col, row) => ({ x: col + WILD_OFF, z: row + WILD_OFF });

// ---- combat constants (from recon/re/constants.js) ----
const SWING_COOLDOWN_MS = 1500;   // WILD_SWORD_SWING_COOLDOWN_S
const ZOMBIE_LIVES = 5;
const HIT_MULT = 1;               // L1 wild_sword (no strength)

// ---- survival thresholds ----
const POTION_HP = 45;   // drink health potion at/below
const SHIELD_HP = 28;   // also pop shield
const RETREAT_HP = 22;  // bail to safe camp + Mainland
const MIN_GOLD = Math.max(0, Number(config.combatMinGold) || 20);
const TARGET_HEALTH_POTIONS = Math.max(0, Number(config.combatMinHealthPotions) || 6);
const TARGET_SHIELD_POTIONS = Math.max(0, Number(config.combatMinShieldPotions) || 2);
const POTION_COSTS = {
  potion_health: { wood: 6, stone: 0, coal: 0 },
  potion_shield: { wood: 0, stone: 5, coal: 0 },
};

const stats = {
  kills: 0, hits: 0, combatStart: null, combatNow: null, combatGain: 0,
  potionsHealth: 0, potionsShield: 0, retreats: 0, deaths: 0, reconnects: 0,
  hp: 100, region: 'world', phase: 'boot', queueAhead: null, started: Date.now(),
};
function saveState(extra = {}) {
  try { fs.writeFileSync(STATEFILE, JSON.stringify({ ...stats, ...extra, ageMin: Math.round((Date.now() - stats.started) / 60000) }, null, 2)); } catch {}
}

let cli;
let healthLeft = 0, shieldLeft = 0;   // Filled from the backpack at startup (server-authoritative).
let lastPotionAt = 0;
let mats = { gold: 0, wood: 0, stone: 0, coal: 0, metal: 0 };
const bankCount = (bp, type) => {
  const arr = Array.isArray(bp?.bankSlots) ? bp.bankSlots : [];
  const slot = arr.find((s) => s && s.t === type);
  return slot ? Number(slot.n) || 0 : 0;
};

// Health potion = HoT +20/tick x5 = +100 total, client-driven.
// consume-potion only decrements the potion, while healing is applied client-side through save-hp.
const HEALTH_POTION_TOTAL = 100;

async function refreshPotionCounts() {
  try {
    const me = await cli.me(); const bp = me.backpack || {};
    healthLeft = Number(bp.potion_health) || 0;
    shieldLeft = Number(bp.potion_shield) || 0;
    mats = {
      gold: Number(bp.gold) || 0,
      wood: (Number(bp.wood) || 0) + bankCount(bp, 'wood'),
      stone: (Number(bp.stone) || 0) + bankCount(bp, 'stone'),
      coal: (Number(bp.coal) || 0) + bankCount(bp, 'coal'),
      metal: Number(bp.metal) || 0,
    };
    saveState();
    return { ...mats, healthLeft, shieldLeft };
  } catch {}
  return { ...mats, healthLeft, shieldLeft };
}

async function ensureCombatSupplies() {
  await refreshPotionCounts();
  log(`🧪 initial stock: health=${healthLeft}/${TARGET_HEALTH_POTIONS} shield=${shieldLeft}/${TARGET_SHIELD_POTIONS} | wood=${mats.wood} stone=${mats.stone} coal=${mats.coal} gold=${mats.gold}`);

  const canAfford = (type) => {
    const cost = POTION_COSTS[type] || {};
    return Object.entries(cost).every(([k, v]) => (Number(mats[k]) || 0) >= v);
  };

  const buyUntilTarget = async (type, target) => {
    while (canAfford(type)) {
      const current = type === 'potion_health' ? healthLeft : shieldLeft;
      if (current >= target) break;
      const r = await cli.alchemistPotionBuy(type, 1).catch((e) => ({ ok: false, error: e.message }));
      if (r && r.ok !== false && !r.error) {
        await refreshPotionCounts();
        log(`🧪 buy ${type} ok -> health=${healthLeft} shield=${shieldLeft} | wood=${mats.wood} stone=${mats.stone} coal=${mats.coal} gold=${mats.gold}`);
        saveState();
        continue;
      }
      logT(`buy-${type}`, `🧪 buy ${type} stop: ${r?.error || 'rejected'}`, 5000);
      break;
    }
  };

  await buyUntilTarget('potion_health', TARGET_HEALTH_POTIONS);
  await buyUntilTarget('potion_shield', TARGET_SHIELD_POTIONS);

  if (mats.gold <= MIN_GOLD) {
    log(`💰 reserve guard active — keeping at least ${MIN_GOLD} gold`);
  }
  saveState();
  log(`🧪 final stock: health=${healthLeft} shield=${shieldLeft} | wood=${mats.wood} stone=${mats.stone} coal=${mats.coal} gold=${mats.gold}`);
}

async function tryPotion(p, type) {
  const now = Date.now();
  if (now - lastPotionAt < 2500) return false; // rate-limit guard
  if (type === 'potion_health' && healthLeft <= 0) return false;
  if (type === 'potion_shield' && shieldLeft <= 0) return false;
  lastPotionAt = now;
  try {
    const r = await cli.consumePotion(type);
    if (r && r.ok !== false && !r.error) {
      if (type === 'potion_health') {
        stats.potionsHealth++; healthLeft = Math.max(0, healthLeft - 1);
        // Drive the HoT effect and persist it through the combat save-hp path.
        p.hp = Math.min(100, (p.hp | 0) + HEALTH_POTION_TOTAL);
        try { await cli.saveHp(p.hp); } catch {}
      } else if (type === 'potion_shield') {
        stats.potionsShield++; shieldLeft = Math.max(0, shieldLeft - 1); p.shield = 5;
      }
      saveState();
      log(`🧪 drank ${type} -> hp=${p.hp} (health left=${healthLeft})`);
      return true;
    }
    logT('potfail', `potion ${type} rejected: ${r?.error || 'unknown'}`);
  } catch (e) { logT('poterr', `potion err: ${e.message.slice(0, 40)}`); }
  return false;
}

// HP-driven survival reaction. Returns 'retreat' if the bot must bail, or 'dead' when HP reaches zero.
async function survivalCheck(p) {
  const hp = p.hp | 0;
  stats.hp = hp;
  if (hp <= 0) { stats.deaths++; log('💀 HP 0 — died (loot already banked = safe)'); return 'dead'; }
  // Critical HP: retreat to the safe camp.
  if (hp <= RETREAT_HP) {
    if (healthLeft <= 0 && shieldLeft <= 0) { log(`🩸 HP ${hp} critical and no potions left — RETREAT+EXIT`); return 'retreat'; }
    log(`🩸 HP ${hp} <= ${RETREAT_HP} — RETREAT (heal at safe camp)`); return 'retreat';
  }
  // Low HP: use shield first when available, then heal.
  if (hp <= SHIELD_HP && shieldLeft > 0 && (p.shield | 0) <= 0) await tryPotion(p, 'potion_shield');
  if (hp <= POTION_HP && healthLeft > 0) await tryPotion(p, 'potion_health');
  return 'ok';
}

async function enterWild(p) {
  log('walking to Mainland north portal...');
  p.equip('wild_sword');
  await p.walkTo(NORTH_PORTAL.x, NORTH_PORTAL.z, { until: () => /^wild/.test(p.region), maxSec: 40 });
  await sleep(1500);
  if (!/^wild/.test(p.region)) {
    log('forcing wild region handoff at portal tile');
    const sp = wildWorld(25, 48); // WILD_SPAWN
    p.setRegion('wild', sp.x, sp.z);
    await sleep(3000);
  }
  if (!/^wild/.test(p.region)) return false;
  // Send the blocked-tile manifest. An empty manifest is enough to trigger mob hosting/spawn.
  p.sendWildManifest([]);
  stats.region = p.region;
  stats.phase = 'wild';
  stats.queueAhead = null;
  log(`✅ entered wild region=${p.region} tile=${JSON.stringify(p.wildTile())}`);
  // Baseline combat XP comes from playerStats.skillXp.combat, not me().
  try { const st = await cli.playerStats(p.myId); stats.combatStart = st?.skillXp?.combat ?? 0; stats.combatNow = stats.combatStart; log(`baseline combat XP=${stats.combatStart}`); } catch {}
  await refreshPotionCounts();
  saveState();
  log(`🧪 potions: health=${healthLeft} shield=${shieldLeft}`);
  return true;
}

async function retreatToSafe(p) {
  stats.retreats++;
  stats.phase = 'retreat';
  saveState();
  const sc = wildWorld(SAFE_CAMP.col, SAFE_CAMP.row);
  log(`🏃 retreating to safe camp (hp=${p.hp})...`);
  await p.walkTo(sc.x, sc.z, { maxSec: 30 });
  await sleep(1500);
  // Use health potions until HP is safe (>=80) or no potion remains.
  // tryPotion now drives +100 healing and save-hp, so one potion is usually enough.
  for (let i = 0; i < 8 && p.hp < 80 && healthLeft > 0; i++) {
    await tryPotion(p, 'potion_health');
    await sleep(2600); // Respect the potion rate limit.
  }
  if (healthLeft <= 0 && p.hp <= RETREAT_HP) {
    log('🚪 no potions left and HP is low — EXIT to Mainland safely');
    p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1);
    stats.region = 'world';
    stats.phase = 'exit';
    saveState();
    await sleep(3000);
    return 'exited';
  }
  log(`🛡️ recovered hp=${p.hp} (health left=${healthLeft}), resuming hunt`);
  stats.phase = 'hunt';
  saveState();
  return 'recovered';
}

async function huntLoop(p) {
  // Wait for the hub to spawn mobs from the wildMobs snapshot.
  log('waiting for wildMobs from hub...');
  for (let w = 0; w < 15 && !p.wildMobs.some((m) => m.alive); w++) {
    await sleep(2000);
    if (w % 3 === 0) logT('waitmob', `  waiting for mobs... ${w * 2}s (mobs=${p.wildMobs.length})`);
    if (w === 5) { p.sendWildManifest([]); } // re-send manifest
  }
  const aliveCount = p.wildMobs.filter((m) => m.alive).length;
  if (!aliveCount) { log('⚠️ hub did not send mobs after 30s — reconnecting'); return; }
  stats.phase = 'hunt';
  saveState();
  log(`🧟 detected ${aliveCount} live mobs. Starting hunt.`);

  while (p.ready && /^wild/.test(p.region)) {
    const sv = await survivalCheck(p);
    if (sv === 'dead') return;
    if (sv === 'retreat') { const r = await retreatToSafe(p); if (r === 'exited') return; continue; }

    const target = p.nearestMob();
    if (!target) { logT('nomob', 'no live mobs, waiting for respawn...'); await sleep(3000); continue; }

    // Walk adjacent (cheb<=1). Stand one tile south of the target, toward the spawn.
    if (target.cheb > 1) {
      const dest = wildWorld(target.col, target.row + 1); // Approach from the south, toward safety.
      await p.walkTo(dest.x, dest.z, { maxSec: 18, until: () => p.hp <= RETREAT_HP });
      await sleep(400);
      if (p.hp <= RETREAT_HP) continue;
    }

    // Re-resolve the mob index because snapshots can update.
    const tt = p.wildMobs[target.i];
    if (!tt || !tt.alive) { await sleep(300); continue; }
    const cheb = Math.max(Math.abs(tt.col - p.wildTile().col), Math.abs(tt.row - p.wildTile().row));
    if (cheb > 1) { logT('chase', `mob moved away (cheb=${cheb}), chasing...`); continue; }

    // HIT: swing until the mob dies (lv=0) or moves away.
    p.equip('wild_sword');
    const startKills = stats.kills;
    for (let swing = 0; swing < ZOMBIE_LIVES + 3; swing++) {
      const m = p.wildMobs[target.i];
      if (!m || !m.alive) break;
      const c = Math.max(Math.abs(m.col - p.wildTile().col), Math.abs(m.row - p.wildTile().row));
      if (c > 1) break; // Mob moved away, re-target.
      const ok = p.sendWildMobHit(target.i, HIT_MULT);
      if (ok) { stats.hits++; saveState(); logT('swing', `🗡️ hit mob[${target.i}] lv=${m.lv}`, 8000); }
      await sleep(SWING_COOLDOWN_MS);
      if (await survivalCheck(p) === 'retreat') break;
    }
    // Check whether the mob died after the next snapshot.
    await sleep(600);
    const after = p.wildMobs[target.i];
    if (after && !after.alive && stats.kills === startKills) { /* kill attribution is handled by wm_kill */ }
    saveState();
    await sleep(400);
  }
}

async function connectWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      const p = new Presence(SHARD);
      p.on('log', (m) => log('[ws] ' + m));
      p.on('queue', (d) => {
        stats.phase = 'queue';
        stats.queueAhead = Number.isFinite(Number(d?.ahead)) ? Number(d.ahead) : null;
        saveState();
        if (d.ahead % 5 === 0) log('queue ahead=' + d.ahead);
      });
      // kill attribution + XP
      p.on('wm_kill', (d) => {
        if (Number(d.zm) === 1 || Number(d.dr) === 1) {
          stats.kills++;
          stats.phase = 'hunt';
          saveState();
          log(`☠️ KILL #${stats.kills} (${d.zm ? 'zombie' : 'dragon'}) mob[${d.i}]`);
        }
      });
      p.on('skill_xp', (xp) => {
        if (xp && xp.combat != null) {
          stats.combatNow = xp.combat;
          if (stats.combatStart != null) stats.combatGain = xp.combat - stats.combatStart;
          saveState();
          logT('xp', `📈 combat XP=${xp.combat} (+${stats.combatGain})`, 10000);
        }
      });
      p.on('hp', (hp) => { stats.hp = hp; saveState(); });
      await p.connect();
      stats.phase = 'presence';
      stats.region = p.region;
      stats.queueAhead = null;
      saveState();
      log('✅ presence live region=' + p.region);
      return p;
    } catch (e) {
      if (isWalletBannedError(e)) throw e;
      log(`connect attempt ${attempt} failed: ${e.message.slice(0, 60)} — retry 15s`);
      await sleep(15000);
    }
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  try { fs.writeFileSync(LOGFILE, ''); } catch {}
  try { fs.mkdirSync(path.dirname(PIDFILE), { recursive: true }); fs.writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, started: Date.now() })); } catch {}
  process.on('exit', () => { try { fs.unlinkSync(PIDFILE); } catch {} });
  const a = await login();
  cli = new KintaraClient({ cookie: a.cookie });
  saveState();
  log('COMBAT BOT START pid=' + a.player?.id + ' shard=' + SHARD);

  for (;;) {
    const p = await connectWithRetry();
    p.on('close', () => { stats.reconnects++; stats.phase = 'reconnect'; saveState(); log('⚠️ presence closed -> reconnect'); });
    p.hp = 100; p.shield = 0;
    stats.phase = 'prep';
    stats.region = p.region;
    saveState();
    await sleep(2000);

    // === BANK-FIRST (safety), before entering Wilderness ===
    try {
      log('🏦 banking loot first for safety...');
      await p.walkTo(bank.BANK_WORLD.x, bank.BANK_WORLD.z, { maxSec: 30 });
      await sleep(1500);
      const r = await bank.depositAll(cli);
      log(r.moved.length ? `🏦 banked: ${r.moved.join(', ')}` : '🏦 no loot to bank; safe to continue');
    } catch (e) { log('bank error; continuing: ' + e.message.slice(0, 50)); }

    try {
      await ensureCombatSupplies();
    } catch (e) {
      log('alchemist error; continuing: ' + e.message.slice(0, 50));
    }

    // === ENTER WILD ===
    const entered = await enterWild(p);
    if (!entered) { log('🛑 failed to enter wild — reconnecting'); try { p.close(); } catch {} await sleep(5000); continue; }

    // === HUNT ===
    try { await huntLoop(p); }
    catch (e) { log('hunt err: ' + e.message.slice(0, 60)); }

    // Exit Wilderness before reconnecting.
    try { if (/^wild/.test(p.region)) { p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1); await sleep(2000); } } catch {}
    try { p.close(); } catch {}
    saveState();
    await sleep(4000);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
