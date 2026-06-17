#!/usr/bin/env node
// ============ COMBAT BOT — Wilderness hunting (Path A, headless) ============
// Server-authoritative mobs are broadcast by the hub in snap.npcs.wildMobs.
// Flow: login -> bank loot first for safety -> queue + presence -> enter Wilderness
// through the north portal -> hunt the nearest zombie -> send wm_ev hit until it dies.
// Combat XP is granted by the server through skill_xp pushes. Daily zombie quest progress
// is awarded through wm_ev kill attribution.
//
// Safety model:
//  - Bank loot before entering Wilderness to minimize death loss.
//  - Require at least one health potion before starting combat.
//  - Require a wild sword in inventory/hotbar before starting combat.
//  - Monitor HP from wild_mb_ack/pvit/snap self-entry.
//  - Drink health/shield potions at thresholds, and retreat to safe camp or Mainland
//    when HP is critical or health potions run out.
//
// Usage: node tools/combat-bot.js [shard=s2]
const fs = require('fs');
const path = require('path');
const { Presence } = require('../lib/presenceWs');
const { KintaraClient } = require('../lib/kintaraClient');
const { login } = require('../lib/walletAuth');
const bank = require('../lib/bank');
const { config } = require('../config');

const SHARD = process.argv[2] || config.shard;
const OUT = path.join(__dirname, '..', 'recon');
const PIDFILE = path.join(OUT, 'control', 'combatbot.pid');
const STATEFILE = path.join(OUT, 'combat-state.json');
const LOGFILE = path.join(OUT, 'combat.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); try { fs.appendFileSync(LOGFILE, s + '\n'); } catch {} };
const lt = {}; const logT = (k, m, ms = 30000) => { const n = Date.now(); if (!lt[k] || n - lt[k] > ms) { lt[k] = n; log(m); } };

// ---- coords ----
const MAIN_OFF = -30.5; // Mainland world x=col-30.5
const NORTH_PORTAL = { x: 30 + MAIN_OFF, z: 0 + MAIN_OFF }; // col30,row0 = (-0.5,-30.5)
const WILD_OFF = -24.5; // Wilderness world x=col-24.5
const SAFE_CAMP = { col: 25, row: 47 }; // rows 45-49 = safer spawn area
const wildWorld = (col, row) => ({ x: col + WILD_OFF, z: row + WILD_OFF });

// ---- combat constants ----
const SWING_COOLDOWN_MS = 1500;
const ZOMBIE_LIVES = 5;
const HIT_MULT = 1; // L1 wild_sword, no strength potion bonus

// ---- survival thresholds ----
const POTION_HP = 45; // drink health potion at/below this HP
const SHIELD_HP = 28; // also drink shield potion at/below this HP
const RETREAT_HP = 22; // bail to safe camp + Mainland at/below this HP

const stats = {
  kills: 0, hits: 0, combatStart: null, combatNow: null, combatGain: 0,
  potionsHealth: 0, potionsShield: 0, potionsHealthLeft: 0, potionsShieldLeft: 0,
  retreats: 0, deaths: 0, reconnects: 0,
  hp: 100, region: 'world', started: Date.now(),
};
function saveState(extra = {}) {
  try {
    fs.writeFileSync(STATEFILE, JSON.stringify({
      ...stats,
      potionsHealthLeft: healthLeft,
      potionsShieldLeft: shieldLeft,
      ...extra,
      ageMin: Math.round((Date.now() - stats.started) / 60000),
    }, null, 2));
  } catch {}
}

let cli;
let healthLeft = 0;
let shieldLeft = 0;
let lastPotionAt = 0;

function slotType(slot) {
  return String(slot?.t || slot?.type || slot?.itemType || slot?.id || '').toLowerCase();
}
function slotCount(slot) {
  if (!slot) return 0;
  const n = Number(slot.n ?? slot.count ?? slot.amount ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function countCarriedItem(bp, type) {
  const flat = Number(bp?.[type] || 0);
  if (Number.isFinite(flat) && flat > 0) return flat;
  const slots = [...(bp?.invSlots || []), ...(bp?.hotbar || [])];
  return slots.reduce((sum, slot) => sum + (slotType(slot) === type ? slotCount(slot) : 0), 0);
}
function hasWildSword(bp) {
  const slots = [...(bp?.invSlots || []), ...(bp?.hotbar || [])];
  return slots.some((slot) => /^wild_sword/.test(slotType(slot)));
}
function updatePotionCounts(bp = {}) {
  healthLeft = countCarriedItem(bp, 'potion_health');
  shieldLeft = countCarriedItem(bp, 'potion_shield');
  stats.potionsHealthLeft = healthLeft;
  stats.potionsShieldLeft = shieldLeft;
}

async function assertCombatReadiness() {
  const me = await cli.me();
  if (!me?.ok || !me.backpack) throw new Error('could not read backpack state');
  const bp = me.backpack;
  updatePotionCounts(bp);
  if (!hasWildSword(bp)) throw new Error('wild_sword not found in inventory/hotbar');
  if (healthLeft <= 0) throw new Error('no health potions available; combat aborted for safety');
  log(`✅ readiness ok: health potions=${healthLeft}, shield potions=${shieldLeft}, wild_sword=ready`);
  saveState();
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
      if (type === 'potion_health') { stats.potionsHealth++; healthLeft = Math.max(0, healthLeft - 1); }
      else if (type === 'potion_shield') { stats.potionsShield++; shieldLeft = Math.max(0, shieldLeft - 1); p.shield = 5; }
      if (r.backpack) updatePotionCounts(r.backpack);
      log(`🧪 drank ${type} (hp=${p.hp}, left=${healthLeft}H/${shieldLeft}S)`);
      saveState();
      return true;
    }
    logT('potfail', `potion ${type} rejected: ${r?.error || 'unknown'}`);
  } catch (e) { logT('poterr', `potion error: ${e.message.slice(0, 60)}`); }
  return false;
}

// HP-driven survival reaction. Returns 'retreat' if the bot must bail out.
async function survivalCheck(p) {
  const hp = p.hp | 0;
  stats.hp = hp;
  if (hp <= 0) { stats.deaths++; log('💀 HP 0 — died; banked loot should be safe'); return 'dead'; }
  if (hp <= RETREAT_HP) { log(`🩸 HP ${hp} <= ${RETREAT_HP} — RETREAT`); return 'retreat'; }
  if (hp <= SHIELD_HP && shieldLeft > 0) { await tryPotion(p, 'potion_shield'); await tryPotion(p, 'potion_health'); }
  else if (hp <= POTION_HP && healthLeft > 0) { await tryPotion(p, 'potion_health'); }
  else if (hp <= POTION_HP && healthLeft <= 0) { log(`⚠️ HP ${hp} is low and no health potions remain — RETREAT`); return 'retreat'; }
  return 'ok';
}

async function enterWild(p) {
  log('walking to Mainland north portal...');
  p.equip('wild_sword');
  await p.walkTo(NORTH_PORTAL.x, NORTH_PORTAL.z, { until: () => /^wild/.test(p.region), maxSec: 40 });
  await sleep(1500);
  if (!/^wild/.test(p.region)) {
    log('forcing wild region handoff at portal tile');
    const sp = wildWorld(25, 48); // Wilderness spawn
    p.setRegion('wild', sp.x, sp.z);
    await sleep(3000);
  }
  if (!/^wild/.test(p.region)) return false;
  // Send the blocked-tile manifest. An empty manifest is enough to trigger mob hosting/spawn.
  p.sendWildManifest([]);
  stats.region = p.region;
  log(`✅ entered wild region=${p.region} tile=${JSON.stringify(p.wildTile())}`);
  try {
    const st = await cli.playerStats(p.myId);
    stats.combatStart = st?.skillXp?.combat ?? 0;
    stats.combatNow = stats.combatStart;
    log(`baseline combat XP=${stats.combatStart}`);
  } catch {}
  return true;
}

async function retreatToSafe(p) {
  stats.retreats++;
  const sc = wildWorld(SAFE_CAMP.col, SAFE_CAMP.row);
  log('🏃 retreating to safe camp...');
  await p.walkTo(sc.x, sc.z, { maxSec: 30 });
  await sleep(2000);
  for (let i = 0; i < 5 && p.hp < 70 && healthLeft > 0; i++) { await tryPotion(p, 'potion_health'); await sleep(3000); }
  if (p.hp < RETREAT_HP + 10) {
    log('🚪 exiting to Mainland because HP is still unsafe');
    p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1);
    stats.region = 'world';
    await sleep(3000);
    return 'exited';
  }
  log(`🛡️ recovered hp=${p.hp}, resuming hunt`);
  return 'recovered';
}

async function huntLoop(p) {
  log('waiting for wildMobs from hub...');
  for (let w = 0; w < 15 && !p.wildMobs.some((m) => m.alive); w++) {
    await sleep(2000);
    if (w % 3 === 0) logT('waitmob', `  waiting for mobs... ${w * 2}s (mobs=${p.wildMobs.length})`);
    if (w === 5) p.sendWildManifest([]);
  }
  const aliveCount = p.wildMobs.filter((m) => m.alive).length;
  if (!aliveCount) { log('⚠️ hub did not send mobs after 30s — reconnecting'); return; }
  log(`🧟 detected ${aliveCount} live mobs. Starting hunt.`);

  while (p.ready && /^wild/.test(p.region)) {
    const sv = await survivalCheck(p);
    if (sv === 'dead') return;
    if (sv === 'retreat') { const r = await retreatToSafe(p); if (r === 'exited') return; continue; }

    const target = p.nearestMob();
    if (!target) { logT('nomob', 'no live mobs, waiting for respawn...'); await sleep(3000); continue; }

    if (target.cheb > 1) {
      const dest = wildWorld(target.col, target.row + 1); // approach from the south, toward the safe camp
      await p.walkTo(dest.x, dest.z, { maxSec: 18, until: () => p.hp <= RETREAT_HP });
      await sleep(400);
      if (p.hp <= RETREAT_HP) continue;
    }

    const tt = p.wildMobs[target.i];
    if (!tt || !tt.alive) { await sleep(300); continue; }
    const cheb = Math.max(Math.abs(tt.col - p.wildTile().col), Math.abs(tt.row - p.wildTile().row));
    if (cheb > 1) { logT('chase', `mob moved away (cheb=${cheb}), chasing...`); continue; }

    p.equip('wild_sword');
    const startKills = stats.kills;
    for (let swing = 0; swing < ZOMBIE_LIVES + 3; swing++) {
      const m = p.wildMobs[target.i];
      if (!m || !m.alive) break;
      const c = Math.max(Math.abs(m.col - p.wildTile().col), Math.abs(m.row - p.wildTile().row));
      if (c > 1) break;
      const ok = p.sendWildMobHit(target.i, HIT_MULT);
      if (ok) { stats.hits++; logT('swing', `🗡️ hit mob[${target.i}] lv=${m.lv}`, 8000); }
      await sleep(SWING_COOLDOWN_MS);
      if (await survivalCheck(p) === 'retreat') break;
    }
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
      p.on('queue', (d) => { if (d.ahead % 5 === 0) log('queue ahead=' + d.ahead); });
      p.on('wm_kill', (d) => { if (Number(d.zm) === 1 || Number(d.dr) === 1) { stats.kills++; log(`☠️ KILL #${stats.kills} (${d.zm ? 'zombie' : 'dragon'}) mob[${d.i}]`); } });
      p.on('skill_xp', (xp) => { if (xp && xp.combat != null) { stats.combatNow = xp.combat; if (stats.combatStart != null) stats.combatGain = xp.combat - stats.combatStart; logT('xp', `📈 combat XP=${xp.combat} (+${stats.combatGain})`, 10000); } });
      p.on('hp', (hp) => { stats.hp = hp; });
      await p.connect();
      log('✅ presence live region=' + p.region);
      return p;
    } catch (e) { log(`connect attempt ${attempt} failed: ${e.message.slice(0, 60)} — retry 15s`); await sleep(15000); }
  }
}

(async () => {
  try { fs.writeFileSync(LOGFILE, ''); } catch {}
  try { fs.mkdirSync(path.dirname(PIDFILE), { recursive: true }); fs.writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, started: Date.now() })); } catch {}
  process.on('exit', () => { try { fs.unlinkSync(PIDFILE); } catch {} });
  const a = await login();
  cli = new KintaraClient({ cookie: a.cookie });
  log('COMBAT BOT START player=' + a.player?.id + ' shard=' + SHARD);
  await assertCombatReadiness();

  for (;;) {
    const p = await connectWithRetry();
    p.on('close', () => { stats.reconnects++; log('⚠️ presence closed -> reconnect'); });
    p.hp = 100; p.shield = 0;
    await sleep(2000);

    try {
      log('🏦 banking loot first for safety...');
      await p.walkTo(bank.BANK_WORLD.x, bank.BANK_WORLD.z, { maxSec: 30 });
      await sleep(1500);
      const r = await bank.depositAll(cli);
      log(r.moved.length ? `🏦 banked: ${r.moved.join(', ')}` : '🏦 no loot to bank; safe to continue');
    } catch (e) { log('bank error; continuing: ' + e.message.slice(0, 60)); }

    const entered = await enterWild(p);
    if (!entered) { log('🛑 failed to enter wild — reconnecting'); try { p.close(); } catch {} await sleep(5000); continue; }

    try { await huntLoop(p); }
    catch (e) { log('hunt error: ' + e.message.slice(0, 60)); }

    try { if (/^wild/.test(p.region)) { p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1); await sleep(2000); } } catch {}
    try { p.close(); } catch {}
    saveState();
    await sleep(4000);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
