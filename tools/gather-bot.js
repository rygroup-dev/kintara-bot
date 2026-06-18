#!/usr/bin/env node
// ============ GATHER BOT — autopilot wood/stone/coal (Path A, headless) ============
// Connect to world -> learn nodes from res_evt -> walk adjacent -> harvestNode
// (harv->proof->harv_hit until felled) -> save-backpack loot -> repeat. Levels
// woodcutting/mining. Supervisor reconnects and tolerates 502 responses.
//
// Usage: node tools/gather-bot.js [kind=tree|rock] [shard=s2]
const fs = require('fs');
const path = require('path');
const { Presence } = require('../lib/presenceWs');
const { KintaraClient } = require('../lib/kintaraClient');
const { login, isWalletBannedError } = require('../lib/walletAuth');
const gs = require('../lib/gameState');
const { config } = require('../config');

const KIND = process.argv[2] || 'tree';
const SHARD = process.argv[3] || config.shard;
const OUT = path.join(__dirname, '..', 'recon');
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'gather.log'), s + '\n'); };
const lt = {}; const logT = (k, m, ms = 30000) => { const n = Date.now(); if (!lt[k] || n - lt[k] > ms) { lt[k] = n; log(m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

let cli;
async function connectWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      const p = new Presence(SHARD);
      p.on('log', (m) => log('[ws] ' + m));
      p.on('queue', (d) => { if (d.ahead % 5 === 0) log('queue ahead=' + d.ahead); });
      await p.connect();
      log('✅ presence live region=' + p.region);
      return p;
    } catch (e) {
        if (isWalletBannedError(e)) throw e;
        log(`connect attempt ${attempt} failed: ${e.message.slice(0, 50)} — retry 15s`);
        await sleep(15000);
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
    const pool = KIND === 'all' ? [...p.knownNodes('tree'), ...p.knownNodes('rock')] : p.knownNodes(KIND);
    const nodes = pool.filter((n) => !harvested.has(n.key));
    if (!nodes.length) { logT('wait', 'waiting for nodes from res_evt...'); await sleep(5000); continue; }
    // choose the nearest node from the current position
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
    fs.writeFileSync(path.join(OUT, 'gather-state.json'), JSON.stringify({
      ...stats,
      kind: KIND,
      region: p.region,
      ageMin: Math.round((Date.now() - stats.started) / 60000),
    }, null, 2));
    await sleep(1500);
    if (harvested.size > 200) harvested.clear(); // Reset so respawned nodes can be harvested again.
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'gather.log'), '');
  const a = await login(); cli = new KintaraClient({ cookie: a.cookie });
  log('GATHER BOT START kind=' + KIND + ' pid=' + a.player?.id);
  for (;;) {
    const p = await connectWithRetry();
    p.on('close', () => { stats.reconnects++; log('⚠️ presence closed -> reconnect'); });
    await sleep(2000);
    // wait 8s first so nodes can be collected from res_evt
    log('learning nodes for 8s...'); await sleep(8000);
    await gatherLoop(p);
    try { p.close(); } catch {}
    await sleep(3000);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
