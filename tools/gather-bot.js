#!/usr/bin/env node
// ============ GATHER BOT — autopilot wood/stone/coal/metal (Path A, headless) ============
// Connect world -> belajar node dari res_evt -> walk adjacent -> harvestNode
// (harv->proof->harv_hit s/d felled) -> save-backpack loot -> ulang. Level
// woodcutting/mining. Supervisor reconnect, tahan 502.
//
// Pakai: node tools/gather-bot.js [kind=tree|rock] [shard=s2]
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { Presence } = require('../lib/presenceWs');
const { KintaraClient } = require('../lib/kintaraClient');
const { isWalletBannedError } = require('../lib/walletAuth');
const gs = require('../lib/gameState');

const KIND = process.argv[2] || 'tree';
const SHARD = process.argv[3] || config.shard || 's4';
const OUT = path.join(__dirname, '..', 'recon');
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'gather.log'), s + '\n'); };
const lt = {}; const logT = (k, m, ms = 30000) => { const n = Date.now(); if (!lt[k] || n - lt[k] > ms) { lt[k] = n; log(m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const retryDelayMs = (attempt, base = 5000, cap = 60000) => Math.min(cap, base * (2 ** Math.max(0, attempt - 1))) + Math.floor(Math.random() * 1500);
const stats = {
  felled: 0,
  wood: 0,
  stone: 0,
  coal: 0,
  metal: 0,
  gainedWood: 0,
  gainedStone: 0,
  gainedCoal: 0,
  gainedMetal: 0,
  harvests: 0,
  reconnects: 0,
  started: Date.now(),
};
function saveState(extra = {}) {
  fs.writeFileSync(path.join(OUT, 'gather-state.json'), JSON.stringify({
    ...stats,
    kind: KIND,
    region: extra.region || stats.region || 'world',
    phase: extra.phase || stats.phase || 'boot',
    queueAhead: extra.queueAhead != null ? extra.queueAhead : (stats.queueAhead ?? null),
    updatedAt: Date.now(),
    ageMin: Math.round((Date.now() - stats.started) / 60000),
  }, null, 2));
  if (extra.region !== undefined) stats.region = extra.region;
  if (extra.phase !== undefined) stats.phase = extra.phase;
  if (extra.queueAhead !== undefined) stats.queueAhead = extra.queueAhead;
}

let cli;
async function connectWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      const p = new Presence(SHARD);
      p.on('log', (m) => log('[ws] ' + m));
      p.on('queue', (d) => {
        if (d.ahead % 5 === 0) log('queue ahead=' + d.ahead);
        saveState({ phase: 'queue', queueAhead: Number.isFinite(Number(d?.ahead)) ? Number(d.ahead) : null, region: p.region });
      });
      await p.connect();
      log('✅ presence live region=' + p.region);
      saveState({ phase: 'presence', queueAhead: null, region: p.region });
      return p;
    } catch (e) {
      if (isWalletBannedError(e)) throw e;
      saveState({ phase: 'reconnect', queueAhead: null });
      const waitMs = retryDelayMs(attempt);
      saveState({ phase: 'reconnect_wait', queueAhead: null });
      log(`connect attempt ${attempt} gagal: ${e.message.slice(0, 50)} — retry ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
}

async function persistLoot(loot, yld = 1) {
  try {
    const st = await gs.fetchState(cli); const bp = st.backpack; const slots = bp.invSlots || [];
    let put = false;
    for (const s of slots) if (s && s.t === loot) { s.n += yld; put = true; break; }
    if (!put) { const e = slots.findIndex((s) => !s); if (e >= 0) slots[e] = { t: loot, n: yld }; }
    bp[loot] = (Number(bp[loot]) || 0) + yld;
    const r = await gs.pushBackpack(cli, bp, st.stateSeq, []);
    stats[loot] = r?.backpack?.[loot] ?? stats[loot];
    if (loot === 'wood') stats.gainedWood += yld;
    if (loot === 'stone') stats.gainedStone += yld;
    if (loot === 'coal') stats.gainedCoal += yld;
    if (loot === 'metal') stats.gainedMetal += yld;
    return true;
  } catch (e) { logT('persist', 'persist err: ' + e.message.slice(0, 50)); return false; }
}

async function gatherLoop(p) {
  const harvested = new Set();
  while (p.ready) {
    saveState({ phase: 'scan', queueAhead: null, region: p.region });
    const pool = KIND === 'all' ? [...p.knownNodes('tree'), ...p.knownNodes('rock')] : p.knownNodes(KIND);
    const nodes = pool.filter((n) => !harvested.has(n.key));
    if (!nodes.length) { logT('wait', 'nunggu node dari res_evt...'); await sleep(5000); continue; }
    // pilih node terdekat dari posisi sekarang
    nodes.sort((a, b) => {
      const [ac, ar] = a.key.split(',').map(Number), [bc, br] = b.key.split(',').map(Number);
      const da = Math.abs(ac - 30.5 - p.pos.x) + Math.abs(ar - 30.5 - p.pos.z);
      const db = Math.abs(bc - 30.5 - p.pos.x) + Math.abs(br - 30.5 - p.pos.z);
      return da - db;
    });
    const node = nodes[0]; harvested.add(node.key);
    const [col, row] = node.key.split(',').map(Number);
    await p.walkTo(col - 30.5 - 1, row - 30.5, { maxSec: 20 });
    await sleep(1000);
    if (!p.ready) break;
    const res = await p.harvestNode(node.kind, node.key, node.hasCoal, node.hasMetal, { maxHits: 10, hitGap: 1700 });
    stats.harvests++;
    if (res.felled) { stats.felled++; await persistLoot(res.loot, 1); logT('fell', `🪓 felled ${node.kind} @${node.key} -> ${res.loot} (wood=${stats.wood} stone=${stats.stone} coal=${stats.coal} metal=${stats.metal}, felled ${stats.felled})`, 15000); }
    saveState({ phase: 'gather', queueAhead: null, region: p.region });
    await sleep(1500);
    if (harvested.size > 200) harvested.clear(); // reset biar bisa re-harvest (node respawn)
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'gather.log'), '');
  saveState({ phase: 'boot', queueAhead: null, region: 'world' });
  const { client: c, player } = await KintaraClient.create(); cli = c;
  log('GATHER BOT START kind=' + KIND + ' pid=' + player?.id);
  for (;;) {
    const p = await connectWithRetry();
    p.on('close', () => { stats.reconnects++; saveState({ phase: 'reconnect', queueAhead: null, region: p.region }); log('⚠️ presence closed -> reconnect'); });
    await sleep(2000);
    // diam dulu 8s biar kekumpul node dari res_evt
    saveState({ phase: 'learning', queueAhead: null, region: p.region });
    log('belajar node 8s...'); await sleep(8000);
    await gatherLoop(p);
    try { p.close(); } catch {}
    await sleep(3000);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
