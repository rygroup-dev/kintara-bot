#!/usr/bin/env node
// ============ BOT HEADLESS — orchestrator persisten (Path A) ============
// Antri SEKALI lalu tinggal di dunia. Tahan 502/disconnect (auto-reconnect
// queue->presence). Loop: ke The Pond -> grant-fish-xp{} -> daily-quest fish.
// Log status ke recon/bot.log + recon/bot-state.json. Berhenti: kill / Ctrl-C.
//
// Pakai: node tools/bot-headless.js [shard=s2]
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { Presence } = require('../lib/presenceWs');
const { KintaraClient } = require('../lib/kintaraClient');
const { login, isWalletBannedError } = require('../lib/walletAuth');

const SHARD = process.argv[2] || config.shard || 's4';
const OUT = path.join(__dirname, '..', 'recon');
const PIDFILE = path.join(OUT, 'control', 'fishbot.pid');
const STATEFILE = path.join(OUT, 'bot-state.json');
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'bot.log'), s + '\n'); };
const _thr = {};
const logThrottle = (key, msg, everyMs = 30000) => { const now = Date.now(); if (!_thr[key] || now - _thr[key] > everyMs) { _thr[key] = now; log(msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryDelayMs = (attempt, base = 5000, cap = 60000) => Math.min(cap, base * (2 ** Math.max(0, attempt - 1))) + Math.floor(Math.random() * 1500);
const TRANSIENT_FAILOVER_AFTER = 5;
const isTransientGatewayErr = (msg) => /503|Unexpected token '<'|<!doctype|Non-JSON|presence ws err/i.test(String(msg || ''));
const PORTAL = { x: 61 - 30.5, z: 31 - 30.5 }; // mainland east -> pond

let cli, auth;
const stats = { fish: 0, casts: 0, ok: 0, cooked: 0, sold: 0, rate: 0, reconnects: 0, started: Date.now(), shard: SHARD, region: 'world', phase: 'boot', queueAhead: null };

async function freshAuth() { const r = await KintaraClient.create(); cli = r.client; auth = { cookie: cli.cookie, player: r.player }; return auth; }

async function connectWithRetry() {
  let transientGatewayFails = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const p = new Presence(SHARD);
      p.on('log', (m) => log('[ws] ' + m));
      p.on('queue', (d) => {
        stats.phase = 'queue';
        stats.queueAhead = Number.isFinite(Number(d?.ahead)) ? Number(d.ahead) : null;
        stats.region = p.region;
        saveState();
        if (d.ahead % 5 === 0) log('queue ahead=' + d.ahead);
      });
      await p.connect();
      transientGatewayFails = 0;
      stats.phase = 'presence';
      stats.queueAhead = null;
      stats.region = p.region;
      saveState();
      log('✅ presence live, region=' + p.region);
      return p;
    } catch (e) {
      if (isWalletBannedError(e)) throw e;
      if (isTransientGatewayErr(e.message)) transientGatewayFails++;
      else transientGatewayFails = 0;
      if (transientGatewayFails >= TRANSIENT_FAILOVER_AFTER) {
        stats.phase = 'failover_restart';
        stats.queueAhead = null;
        saveState();
        log(`♻️ shard failover after ${transientGatewayFails} transient gateway errors`);
        throw new Error('transient_presence_failover');
      }
      const waitMs = retryDelayMs(attempt);
      log(`connect attempt ${attempt} gagal: ${e.message.slice(0, 60)} — retry ${Math.ceil(waitMs / 1000)}s`);
      stats.phase = 'reconnect_wait';
      stats.queueAhead = null;
      saveState();
      await sleep(waitMs);
      if (attempt % 3 === 0) { try { await freshAuth(); log('re-auth cookie'); } catch {} }
    }
  }
}

async function gotoPond(p) {
  if (p.region === 'pond') return true;
  stats.phase = 'travel_pond';
  stats.region = p.region;
  saveState();
  log('walk -> portal east');
  await p.walkTo(PORTAL.x, PORTAL.z, { until: () => p.region === 'pond', maxSec: 30 });
  await sleep(1500);
  if (p.region !== 'pond') { p.setRegion('pond', PORTAL.x, PORTAL.z); await sleep(3000); }
  if (p.region === 'pond') {
    // spawn di dock barat pond (col~1). Jalan ke timur ke tepi air (col~8 -> x=-11.5).
    p.pos.x = -18.5; p.pos.z = 0; // titik masuk pond (west) approx
    await p.walkTo(-11.5, 0, { maxSec: 12 });
    log('di pond, tile=' + JSON.stringify(p.pondTile()));
  }
  stats.phase = p.region === 'pond' ? 'pond' : 'travel_pond';
  stats.queueAhead = null;
  stats.region = p.region;
  saveState();
  log('region=' + p.region);
  return p.region === 'pond';
}

// ----- konfigurasi manajemen ikan -----
const FISH_SPOT = { x: -11.5, z: 0 };       // tepi air pond (col8,row20)
const ROAST = { x: -14.5, z: -12.5 };       // dekat Roast Pit pond (col5-6,row6-7)
const COOK_AT = 40, COOK_BATCH = 8;         // kalau fish>=40, masak 8 (XP cooking)
const FISH_RESERVE = 50, SELL_FISH_AT = 160; // jual ikan kalau >160, sisakan 50 utk upgrade/masak
const COOKED_RESERVE = 40, SELL_COOKED_AT = 90; // simpan 40 cooked utk healing/upgrade
let fishPrice = 1;

function saveState(extra = {}) {
  try {
    fs.writeFileSync(STATEFILE, JSON.stringify({ ...stats, ...extra, ageMin: Math.round((Date.now() - stats.started) / 60000), updatedAt: Date.now() }));
  } catch {}
}

async function catchOne(p) {
  stats.phase = 'fishing';
  stats.region = p.region;
  saveState();
  const me = p.pondTile();
  const fc = me.col + 3, fr = me.row;
  p.setFishing(fc, fr, 0); await sleep(900);
  p.setFishing(fc, fr, 1); await sleep(900);
  p.setFishing(fc, fr, 2); await sleep(1600);
  try {
    const g = await cli.grantFishXp({}); p.clearAct(); stats.casts++;
    if (g?.ok !== false) { stats.ok++; stats.fish = g?.backpack?.fish ?? stats.fish; saveState(); logThrottle('catch', `🎣 fish=${stats.fish} xp=${g?.xp?.fishing} (ok ${stats.ok}/${stats.casts})`, 20000); }
  } catch (e) {
    p.clearAct(); const m = e.message || '';
    if (/rate_limited/.test(m)) stats.rate++;
    else if (/not_in_pond/.test(m)) { p.region = 'world'; logThrottle('kicked', 'kicked -> re-goto'); }
    else if (/502|Non-JSON/.test(m)) logThrottle('502', '502 transient');
    else logThrottle('ferr:' + m.slice(0, 20), 'fish err: ' + m.slice(0, 50));
    saveState({ region: p.region });
  }
}

async function cookBatch(p, n) {
  log(`🍳 ke Roast Pit, masak ${n}...`);
  await p.walkTo(ROAST.x, ROAST.z, { maxSec: 14 });
  await sleep(1500);
  let cooked = 0;
  for (let i = 0; i < n; i++) {
    try { const r = await cli.grantCookXp({ mode: 'fish' }); if (r?.ok !== false) { cooked++; stats.cooked = r?.backpack?.cooked_fish_meat ?? stats.cooked; } }
    catch (e) { if (!/rate_limited/.test(e.message)) { logThrottle('cook', 'cook err: ' + e.message.slice(0, 40)); break; } }
    await sleep(4500);
  }
  log(`🍳 masak ${cooked}/${n} (cooked total=${stats.cooked})`);
  await p.walkTo(FISH_SPOT.x, FISH_SPOT.z, { maxSec: 14 });
  await sleep(1000);
}

async function sellExcess(itemType, reserve) {
  try {
    const me = await cli.me(); const bp = me?.backpack || {};
    const slots = bp.invSlots || []; let idx = -1, have = 0;
    for (let i = 0; i < slots.length; i++) if (slots[i] && slots[i].t === itemType) { idx = i; have = slots[i].n; break; }
    if (idx < 0 || have <= reserve) return;
    const qty = Math.min(have - reserve, 200);
    if (itemType === 'fish' && fishPrice <= 1) { try { const st = await cli.marketplaceStats('fish'); fishPrice = Math.max(1, Math.round((st?.avg30d || 1))); } catch {} }
    const unitPrice = itemType === 'cooked_fish_meat' ? Math.max(2, fishPrice * 2) : fishPrice;
    const price = Math.max(1, Math.round(unitPrice * qty));
    const r = await cli.marketplaceSell({ itemType, slotKind: 'inv', slotIndex: idx, quantity: qty, currency: 'gold', priceGold: price });
    if (r?.ok !== false) { stats.sold = (stats.sold || 0) + qty; log(`💰 jual ${qty} ${itemType} @${price}g total (~${unitPrice}g/unit, total terjual ${stats.sold})`); }
  } catch (e) { logThrottle('sell', 'sell err: ' + (e.message || '').slice(0, 50)); }
}

async function fishLoop(p) {
  let sinceManage = 0;
  while (p.ready) {
    if (p.region !== 'pond') { if (!await gotoPond(p)) { await sleep(3000); continue; } }
    await catchOne(p);
    saveState({ region: p.region });
    await sleep(5500);
    if (++sinceManage >= 12) { // tiap ~12 catch, kelola inventory
      sinceManage = 0;
      try {
        const me = await cli.me(); const bp = me?.backpack || {};
        stats.fish = bp.fish || 0; stats.cooked = bp.cooked_fish_meat || 0;
        if (bp.fish >= COOK_AT && p.ready) await cookBatch(p, COOK_BATCH);
        if (bp.fish >= SELL_FISH_AT) await sellExcess('fish', FISH_RESERVE);
        if (bp.cooked_fish_meat >= SELL_COOKED_AT) await sellExcess('cooked_fish_meat', COOKED_RESERVE);
      } catch (e) { logThrottle('mng', 'manage err: ' + (e.message || '').slice(0, 40)); }
    }
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(OUT, 'control'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'bot.log'), '');
  fs.writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, started: Date.now() }));
  process.on('exit', () => { try { fs.unlinkSync(PIDFILE); } catch {} });
  await freshAuth();
  const me0 = await cli.me().catch(() => ({}));
  log('BOT START pid=' + auth.player?.id + ' fish0=' + me0?.backpack?.fish);
  stats.fish = me0?.backpack?.fish || 0;
  saveState();

  for (;;) { // supervisor: reconnect selamanya
    const p = await connectWithRetry();
    let closed = false;
    p.on('close', () => {
      if (!closed) {
        closed = true;
        stats.reconnects++;
        stats.phase = 'reconnect';
        stats.queueAhead = null;
        saveState();
        log('⚠️ presence closed -> reconnect');
      }
    });
    await sleep(2000);
    await gotoPond(p);
    await fishLoop(p); // keluar saat p.ready=false (disconnect)
    try { p.close(); } catch {}
    await sleep(3000);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
