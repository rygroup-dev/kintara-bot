#!/usr/bin/env node
// ============ COMBAT BOT — Wilderness hunting (Path A, headless) ============
// Server-authoritative mobs: hub broadcast posisi+HP di snap.npcs.wildMobs.
// Flow: login -> BANK semua loot (safety) -> queue+presence -> enter wild
// (north portal) -> hunt zombie terdekat (walk adjacent -> wm_ev hit s/d mati).
// Combat XP di-grant server (skill_xp push), daily zombie quest via wm_ev by=me.
//
// SURVIVAL KETAT:
//  - BANK-FIRST wajib (nol carried loss kalau mati).
//  - Monitor HP (wild_mb_ack/pvit/snap). HP<=POTION_HP -> consumePotion health.
//    HP<=SHIELD_HP -> + potion_shield. HP<=RETREAT_HP / potion habis -> RETREAT
//    ke safe camp + exit Mainland. Bot TIDAK PERNAH kirim wmb (kontak) -> mob
//    gak bisa damage kita; risiko nyata cuma PvP. Tetap retreat sebagai jaring.
//
// Pakai: node tools/combat-bot.js [shard=s2]
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

const stats = {
  kills: 0, hits: 0, combatStart: null, combatNow: null, combatGain: 0,
  potionsHealth: 0, potionsShield: 0, retreats: 0, deaths: 0, reconnects: 0,
  hp: 100, region: 'world', started: Date.now(),
};
function saveState(extra = {}) {
  try { fs.writeFileSync(STATEFILE, JSON.stringify({ ...stats, ...extra, ageMin: Math.round((Date.now() - stats.started) / 60000) }, null, 2)); } catch {}
}

let cli;
let healthLeft = 0, shieldLeft = 0;   // diisi dari backpack saat start (server authoritative)
let lastPotionAt = 0;

// Health potion = HoT +20/tick x5 = +100 total, DIDORONG CLIENT (consume-potion cuma
// kurangi potion; heal sebenarnya client-side + save-hp). Headless: kita yg apply + persist.
const HEALTH_POTION_TOTAL = 100;

async function refreshPotionCounts() {
  try {
    const me = await cli.me(); const bp = me.backpack || {};
    healthLeft = Number(bp.potion_health) || 0;
    shieldLeft = Number(bp.potion_shield) || 0;
  } catch {}
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
        // drive HoT + persist: server percaya save-hp saat combat (combatHealRealtime)
        p.hp = Math.min(100, (p.hp | 0) + HEALTH_POTION_TOTAL);
        try { await cli.saveHp(p.hp); } catch {}
      } else if (type === 'potion_shield') {
        stats.potionsShield++; shieldLeft = Math.max(0, shieldLeft - 1); p.shield = 5;
      }
      log(`🧪 drank ${type} -> hp=${p.hp} (health left=${healthLeft})`);
      return true;
    }
    logT('potfail', `potion ${type} rejected: ${r?.error || 'unknown'}`);
  } catch (e) { logT('poterr', `potion err: ${e.message.slice(0, 40)}`); }
  return false;
}

// HP-driven survival reaction. Returns 'retreat' if must bail, 'dead' kalau mati.
async function survivalCheck(p) {
  const hp = p.hp | 0;
  stats.hp = hp;
  if (hp <= 0) { stats.deaths++; log('💀 HP 0 — died (loot already banked = safe)'); return 'dead'; }
  // kritis: bail ke safe camp
  if (hp <= RETREAT_HP) {
    if (healthLeft <= 0 && shieldLeft <= 0) { log(`🩸 HP ${hp} kritis & potion habis — RETREAT+EXIT`); return 'retreat'; }
    log(`🩸 HP ${hp} <= ${RETREAT_HP} — RETREAT (heal di safe camp)`); return 'retreat';
  }
  // low: pop shield dulu kalau ada, lalu heal
  if (hp <= SHIELD_HP && shieldLeft > 0 && (p.shield | 0) <= 0) await tryPotion(p, 'potion_shield');
  if (hp <= POTION_HP && healthLeft > 0) await tryPotion(p, 'potion_health');
  return 'ok';
}

async function enterWild(p) {
  log('walk ke north portal Mainland...');
  p.equip('wild_sword');
  await p.walkTo(NORTH_PORTAL.x, NORTH_PORTAL.z, { until: () => /^wild/.test(p.region), maxSec: 40 });
  await sleep(1500);
  if (!/^wild/.test(p.region)) {
    log('paksa setRegion wild (handoff di tile portal)');
    const sp = wildWorld(25, 48); // WILD_SPAWN
    p.setRegion('wild', sp.x, sp.z);
    await sleep(3000);
  }
  if (!/^wild/.test(p.region)) return false;
  // kirim manifest blocked-tile (hub butuh utk spawn+path mob). Kosong = cukup utk trigger spawn.
  p.sendWildManifest([]);
  stats.region = p.region;
  log(`✅ masuk wild region=${p.region} tile=${JSON.stringify(p.wildTile())}`);
  // baseline combat XP (playerStats.skillXp.combat — bukan me())
  try { const st = await cli.playerStats(p.myId); stats.combatStart = st?.skillXp?.combat ?? 0; stats.combatNow = stats.combatStart; log(`baseline combat XP=${stats.combatStart}`); } catch {}
  await refreshPotionCounts();
  log(`🧪 potions: health=${healthLeft} shield=${shieldLeft}`);
  return true;
}

async function retreatToSafe(p) {
  stats.retreats++;
  const sc = wildWorld(SAFE_CAMP.col, SAFE_CAMP.row);
  log(`🏃 retreat ke safe camp (hp=${p.hp})...`);
  await p.walkTo(sc.x, sc.z, { maxSec: 30 });
  await sleep(1500);
  // heal pakai health potion sampai HP aman (>=80) atau potion habis.
  // tryPotion sekarang drive heal +100 + save-hp, jadi 1 potion biasanya cukup.
  for (let i = 0; i < 8 && p.hp < 80 && healthLeft > 0; i++) {
    await tryPotion(p, 'potion_health');
    await sleep(2600); // hormati rate-limit potion
  }
  if (healthLeft <= 0 && p.hp <= RETREAT_HP) {
    log('🚪 potion habis & HP rendah — EXIT ke Mainland (sesi combat selesai aman)');
    p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1);
    stats.region = 'world';
    await sleep(3000);
    return 'exited';
  }
  log(`🛡️ recovered hp=${p.hp} (health left=${healthLeft}), lanjut hunt`);
  return 'recovered';
}

async function huntLoop(p) {
  // tunggu hub spawn mob (wildMobs di snap)
  log('nunggu wildMobs dari hub...');
  for (let w = 0; w < 15 && !p.wildMobs.some((m) => m.alive); w++) {
    await sleep(2000);
    if (w % 3 === 0) logT('waitmob', `  nunggu mob... ${w * 2}s (mobs=${p.wildMobs.length})`);
    if (w === 5) { p.sendWildManifest([]); } // re-send manifest
  }
  const aliveCount = p.wildMobs.filter((m) => m.alive).length;
  if (!aliveCount) { log('⚠️ hub belum kirim mob setelah 30s — coba reconnect'); return; }
  log(`🧟 ${aliveCount} mob hidup terdeteksi. Mulai hunt.`);

  while (p.ready && /^wild/.test(p.region)) {
    const sv = await survivalCheck(p);
    if (sv === 'dead') return;
    if (sv === 'retreat') { const r = await retreatToSafe(p); if (r === 'exited') return; continue; }

    const target = p.nearestMob();
    if (!target) { logT('nomob', 'gak ada mob hidup, nunggu respawn...'); await sleep(3000); continue; }

    // walk ke adjacent (cheb<=1). Target tile -> berdiri 1 tile di selatannya (row-1 menuju spawn).
    if (target.cheb > 1) {
      const dest = wildWorld(target.col, target.row + 1); // approach dari selatan (arah safe)
      await p.walkTo(dest.x, dest.z, { maxSec: 18, until: () => p.hp <= RETREAT_HP });
      await sleep(400);
      if (p.hp <= RETREAT_HP) continue;
    }

    // re-resolve mob index (snap bisa update)
    const tt = p.wildMobs[target.i];
    if (!tt || !tt.alive) { await sleep(300); continue; }
    const cheb = Math.max(Math.abs(tt.col - p.wildTile().col), Math.abs(tt.row - p.wildTile().row));
    if (cheb > 1) { logT('chase', `mob bergerak (cheb=${cheb}), kejar...`); continue; }

    // HIT: swing loop sampai mob mati (lv=0) atau lepas
    p.equip('wild_sword');
    const startKills = stats.kills;
    for (let swing = 0; swing < ZOMBIE_LIVES + 3; swing++) {
      const m = p.wildMobs[target.i];
      if (!m || !m.alive) break;
      const c = Math.max(Math.abs(m.col - p.wildTile().col), Math.abs(m.row - p.wildTile().row));
      if (c > 1) break; // mob kabur, re-target
      const ok = p.sendWildMobHit(target.i, HIT_MULT);
      if (ok) { stats.hits++; logT('swing', `🗡️ hit mob[${target.i}] lv=${m.lv}`, 8000); }
      await sleep(SWING_COOLDOWN_MS);
      if (await survivalCheck(p) === 'retreat') break;
    }
    // cek apakah mati (lv jadi 0 / alive false setelah snap)
    await sleep(600);
    const after = p.wildMobs[target.i];
    if (after && !after.alive && stats.kills === startKills) { /* kill di-handle event wm_kill */ }
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
      // kill attribution + XP
      p.on('wm_kill', (d) => { if (Number(d.zm) === 1 || Number(d.dr) === 1) { stats.kills++; log(`☠️ KILL #${stats.kills} (${d.zm ? 'zombie' : 'dragon'}) mob[${d.i}]`); } });
      p.on('skill_xp', (xp) => { if (xp && xp.combat != null) { stats.combatNow = xp.combat; if (stats.combatStart != null) stats.combatGain = xp.combat - stats.combatStart; logT('xp', `📈 combat XP=${xp.combat} (+${stats.combatGain})`, 10000); } });
      p.on('hp', (hp) => { stats.hp = hp; });
      await p.connect();
      log('✅ presence live region=' + p.region);
      return p;
    } catch (e) {
      if (isWalletBannedError(e)) throw e;
      log(`connect attempt ${attempt} gagal: ${e.message.slice(0, 60)} — retry 15s`);
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
  log('COMBAT BOT START pid=' + a.player?.id + ' shard=' + SHARD);

  for (;;) {
    const p = await connectWithRetry();
    p.on('close', () => { stats.reconnects++; log('⚠️ presence closed -> reconnect'); });
    p.hp = 100; p.shield = 0;
    await sleep(2000);

    // === BANK-FIRST (safety) — sebelum masuk wild ===
    try {
      log('🏦 bank dulu (safety)...');
      await p.walkTo(bank.BANK_WORLD.x, bank.BANK_WORLD.z, { maxSec: 30 });
      await sleep(1500);
      const r = await bank.depositAll(cli);
      log(r.moved.length ? `🏦 banked: ${r.moved.join(', ')}` : '🏦 gak ada loot utk di-bank (aman)');
    } catch (e) { log('bank err (lanjut): ' + e.message.slice(0, 50)); }

    // === ENTER WILD ===
    const entered = await enterWild(p);
    if (!entered) { log('🛑 gagal masuk wild — reconnect'); try { p.close(); } catch {} await sleep(5000); continue; }

    // === HUNT ===
    try { await huntLoop(p); }
    catch (e) { log('hunt err: ' + e.message.slice(0, 60)); }

    // keluar wild sebelum reconnect (aman)
    try { if (/^wild/.test(p.region)) { p.setRegion('world', NORTH_PORTAL.x, NORTH_PORTAL.z + 1); await sleep(2000); } } catch {}
    try { p.close(); } catch {}
    saveState();
    await sleep(4000);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
