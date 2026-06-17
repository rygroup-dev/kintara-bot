#!/usr/bin/env node
// ============ HEADLESS BOT — persistent orchestrator (Path A) ============
// Queue ONCE, then remain in the world. Tolerates 502/disconnects with auto-reconnect
// queue->presence). Loop: ke The Pond -> grant-fish-xp{} -> daily-quest fish.
// Logs status to recon/bot.log + recon/bot-state.json. Stop with kill / Ctrl-C.
//
// Usage: node tools/bot-headless.js [shard=s2]
const fs = require('fs');
const path = require('path');
const { Presence } = require('../lib/presenceWs');
const { KintaraClient } = require('../lib/kintaraClient');
const { login } = require('../lib/walletAuth');
const { config } = require('../config');

const SHARD = process.argv[2] || config.shard;
const OUT = path.join(__dirname, '..', 'recon');
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'bot.log'), s + '\n'); };
const _thr = {};
const logThrottle = (key, msg, everyMs = 30000) => { const now = Date.now(); if (!_thr[key] || now - _thr[key] > everyMs) { _thr[key] = now; log(msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORTAL = { x: 61 - 30.5, z: 31 - 30.5 }; // mainland east -> pond

let cli, auth;
const stats = { fish: 0, casts: 0, ok: 0, cooked: 0, sold: 0, rate: 0, reconnects: 0, started: Date.now() };

async function freshAuth() { auth = await login(); cli = new KintaraClient({ cookie: auth.cookie }); return auth; }

async function connectWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      const p = new Presence(SHARD);
      p.on('log', (m) => log('[ws] ' + m));
      p.on('queue', (d) => { if (d.ahead % 5 === 0) log('queue ahead=' + d.ahead); });
      await p.connect();
      log('✅ presence live, region=' + p.region);
      return p;
    } catch (e) {
      log(`connect attempt ${attempt} failed: ${e.message.slice(0, 60)} — retry 15s`);
      await sleep(15000);
      if (attempt % 3 === 0) { try { await freshAuth(); log('re-auth cookie'); } catch {} }
    }
  }
}

async function gotoPond(p) {
  if (p.region === 'pond') return true;
  log('walk -> portal east');
  await p.walkTo(PORTAL.x, PORTAL.z, { until: () => p.region === 'pond', maxSec: 30 });
  await sleep(1500);
  if (p.region !== 'pond') { p.setRegion('pond', PORTAL.x, PORTAL.z); await sleep(3000); }
  if (p.region === 'pond') {
    // spawn at the west pond dock (col~1). Walk east to the water edge (col~8 -> x=-11.5).
    p.pos.x = -18.5; p.pos.z = 0; // approximate pond entry point (west)
    await p.walkTo(-11.5, 0, { maxSec: 12 });
    log('at pond, tile=' + JSON.stringify(p.pondTile()));
  }
  log('region=' + p.region);
  return p.region === 'pond';
}

// ----- fish management configuration -----
const FISH_SPOT = { x: -11.5, z: 0 };       // pond water edge (col8,row20)
const ROAST = { x: -14.5, z: -12.5 };       // near pond Roast Pit (col5-6,row6-7)
const COOK_AT = 40, COOK_BATCH = 8;         // when fish>=40, cook 8 for cooking XP
const FISH_RESERVE = 50, SELL_FISH_AT = 160; // sell fish when >160, keep 50 for upgrades/cooking
const COOKED_RESERVE = 40, SELL_COOKED_AT = 90; // keep 40 cooked fish for healing/upgrades
let fishPrice = 1;

function saveState(region) { fs.writeFileSync(path.join(OUT, 'bot-state.json'), JSON.stringify({ ...stats, region, ageMin: Math.round((Date.now() - stats.started) / 60000) })); }

async function catchOne(p) {
  const me = p.pondTile();
  const fc = me.col + 3, fr = me.row;
  p.setFishing(fc, fr, 0); await sleep(900);
  p.setFishing(fc, fr, 1); await sleep(900);
  p.setFishing(fc, fr, 2); await sleep(1600);
  try {
    const g = await cli.grantFishXp({}); p.clearAct(); stats.casts++;
    if (g?.ok !== false) { stats.ok++; stats.fish = g?.backpack?.fish ?? stats.fish; logThrottle('catch', `🎣 fish=${stats.fish} xp=${g?.xp?.fishing} (ok ${stats.ok}/${stats.casts})`, 20000); }
  } catch (e) {
    p.clearAct(); const m = e.message || '';
    if (/rate_limited/.test(m)) stats.rate++;
    else if (/not_in_pond/.test(m)) { p.region = 'world'; logThrottle('kicked', 'kicked -> re-goto'); }
    else if (/502|Non-JSON/.test(m)) logThrottle('502', '502 transient');
    else logThrottle('ferr:' + m.slice(0, 20), 'fish err: ' + m.slice(0, 50));
  }
}

async function cookBatch(p, n) {
  log(`🍳 walking to Roast Pit, cooking ${n}...`);
  await p.walkTo(ROAST.x, ROAST.z, { maxSec: 14 });
  await sleep(1500);
  let cooked = 0;
  for (let i = 0; i < n; i++) {
    try { const r = await cli.grantCookXp({ mode: 'fish' }); if (r?.ok !== false) { cooked++; stats.cooked = r?.backpack?.cooked_fish_meat ?? stats.cooked; } }
    catch (e) { if (!/rate_limited/.test(e.message)) { logThrottle('cook', 'cook err: ' + e.message.slice(0, 40)); break; } }
    await sleep(4500);
  }
  log(`🍳 cooked ${cooked}/${n} (cooked total=${stats.cooked})`);
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
    const price = itemType === 'cooked_fish_meat' ? Math.max(2, fishPrice * 2) : fishPrice;
    const r = await cli.marketplaceSell({ itemType, slotKind: 'inv', slotIndex: idx, quantity: qty, currency: 'gold', priceGold: price });
    if (r?.ok !== false) { stats.sold = (stats.sold || 0) + qty; log(`💰 sold ${qty} ${itemType} @${price}g (total sold ${stats.sold})`); }
  } catch (e) { logThrottle('sell', 'sell err: ' + (e.message || '').slice(0, 50)); }
}

async function fishLoop(p) {
  let sinceManage = 0;
  while (p.ready) {
    if (p.region !== 'pond') { if (!await gotoPond(p)) { await sleep(3000); continue; } }
    await catchOne(p);
    saveState(p.region);
    await sleep(5500);
    if (++sinceManage >= 12) { // every ~12 catches, manage inventory
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
  fs.writeFileSync(path.join(OUT, 'bot.log'), '');
  await freshAuth();
  const me0 = await cli.me().catch(() => ({}));
  log('BOT START pid=' + auth.player?.id + ' fish0=' + me0?.backpack?.fish);
  stats.fish = me0?.backpack?.fish || 0;

  for (;;) { // supervisor: reconnect forever
    const p = await connectWithRetry();
    let closed = false;
    p.on('close', () => { if (!closed) { closed = true; stats.reconnects++; log('⚠️ presence closed -> reconnect'); } });
    await sleep(2000);
    await gotoPond(p);
    await fishLoop(p); // exits when p.ready=false (disconnect)
    try { p.close(); } catch {}
    await sleep(3000);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
