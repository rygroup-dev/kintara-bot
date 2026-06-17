#!/usr/bin/env node
// ============ ORCHESTRATOR BRAIN — choose activity automatically by goal ============
// Each interval: evaluate skills + inventory + quests -> choose the best activity
// (fishing OR gathering) -> manage bot processes (start/stop). 1 account = 1 activity
// across different realms, so switching restarts the bot and queues again — switch sparingly, only when
// the goal chunk is complete, not every minute.
//
// Goal priority (default):
//   1) Completed daily quests -> claim immediately
//   2) Pending fishing daily quest -> FISHING (fish+cook)
//   3) Pending gather/mining daily quest -> GATHER (all)
//   4) Low woodcutting/mining / need materials (build/sell) -> GATHER (all)
//   5) Default -> FISHING (high XP/value)
//
// Usage: node tools/orchestrator.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { KintaraClient } = require('../lib/kintaraClient');
const { login } = require('../lib/walletAuth');
const tg = require('../lib/telegram');
const { config } = require('../config');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recon');
const CTRL = path.join(OUT, 'control');
const FPID = path.join(CTRL, 'fishbot.pid'), GPID = path.join(CTRL, 'gatherbot.pid');
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ORCH ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'orchestrator.log'), s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const pidOf = (f) => { const p = readJson(f); if (!p?.pid) return null; try { process.kill(p.pid, 0); return p.pid; } catch { return null; } };

const EVAL_MS = 600000;          // evaluate every 10 minutes and switch sparingly
const MIN_RUN_MS = 1500000;      // minimum 25 minutes per activity before switching to avoid queue thrashing

let cli, lastAuth = 0, current = null, currentSince = 0, myPid = null;
async function client() { if (!cli || Date.now() - lastAuth > 1500000) { const a = await login(); cli = new KintaraClient({ cookie: a.cookie }); myPid = a.player?.id || myPid; lastAuth = Date.now(); } return cli; }

function questProgress(q, quest) {
  return (q?.dailyQuest?.prog || {})[quest.id] || 0;
}

function questClaimed(q, quest) {
  return !!((q?.dailyQuest?.claimed || {})[quest.id]);
}

function isQuestPending(q, quest) {
  return !questClaimed(q, quest) && questProgress(q, quest) < quest.target;
}

function isQuestReady(q, quest) {
  return !questClaimed(q, quest) && questProgress(q, quest) >= quest.target;
}

function isGatherQuestKind(kind) {
  return ['gather', 'tree', 'wood', 'woodcutting', 'rock', 'stone', 'coal', 'mining'].includes(String(kind || '').toLowerCase());
}

async function claimReadyQuests(c, q) {
  const quests = q?.dailyQuestConfig?.quests || [];
  const claimed = [];
  for (const quest of quests) {
    if (!isQuestReady(q, quest)) continue;
    try {
      const r = await c.dailyQuestClaim(quest.id);
      claimed.push({ id: quest.id, kind: quest.kind, label: quest.label, rewardXp: quest.rewardXpSpreadTotal });
      if (!q.dailyQuest) q.dailyQuest = {};
      if (!q.dailyQuest.claimed) q.dailyQuest.claimed = {};
      q.dailyQuest.claimed[quest.id] = true;
      log(`🎁 CLAIMED daily ${quest.kind} (${quest.rewardXpSpreadTotal}XP) -> ${JSON.stringify(r).slice(0, 80)}`);
    } catch (e) {
      log(`daily claim ${quest.kind} failed: ${(e.message || '').slice(0, 60)}`);
    }
  }
  if (claimed.length) {
    await tg.send('🎁 <b>Daily quest claimed</b>\n' + claimed.map((x) => `✅ ${x.label || x.kind} (${x.rewardXp || 0}XP)`).join('\n')).catch(() => {});
  }
  return claimed;
}

function ensureOnly(activity) {
  // ensure only `activity` is running
  const fp = pidOf(FPID), gp = pidOf(GPID);
  if (activity === 'fish') {
    if (gp) { try { process.kill(gp, 'SIGKILL'); fs.unlinkSync(GPID); } catch {} }
    if (!pidOf(FPID)) { const c = cp.spawn('node', [path.join(ROOT, 'tools', 'bot-headless.js'), config.shard], { detached: true, stdio: 'ignore', cwd: ROOT }); c.unref(); fs.writeFileSync(FPID, JSON.stringify({ pid: c.pid, started: Date.now() })); log('▶️ START fishing (pid ' + c.pid + ')'); }
  } else if (activity === 'gather') {
    if (fp) { try { process.kill(fp, 'SIGKILL'); fs.unlinkSync(FPID); } catch {} }
    if (!pidOf(GPID)) { const c = cp.spawn('node', [path.join(ROOT, 'tools', 'gather-bot.js'), 'all', config.shard], { detached: true, stdio: 'ignore', cwd: ROOT }); c.unref(); fs.writeFileSync(GPID, JSON.stringify({ pid: c.pid, started: Date.now() })); log('▶️ START gather-all (pid ' + c.pid + ')'); }
  }
}

async function decide() {
  const c = await client();
  const me = await c.me().catch(() => ({})); const bp = me.backpack || {};
  const st = await c.playerStats(myPid).catch(() => ({})); const xp = st.skillXp || {};
  let q = {}; try { q = await c.dailyQuestProgress(); } catch {}
  const claimedNow = await claimReadyQuests(c, q);
  const quests = q?.dailyQuestConfig?.quests || [];
  // goal signals
  const needFishQuest = quests.some((x) => x.kind === 'fish' && isQuestPending(q, x));
  const needGatherQuest = quests.some((x) => isGatherQuestKind(x.kind) && isQuestPending(q, x));
  const woodLow = (bp.wood || 0) < 100, stoneLow = (bp.stone || 0) < 100;
  const gatherSkillLow = (xp.woodcutting || 0) < 5000 || (xp.mining || 0) < 5000; // gather skills are still low
  // decision
  let goal, why;
  if (needFishQuest) { goal = 'fish'; why = 'daily fish quest is not complete yet'; }
  else if (needGatherQuest) { goal = 'gather'; why = 'daily gather/mining quest is not complete yet'; }
  else if (gatherSkillLow && (woodLow || stoneLow)) { goal = 'gather'; why = 'woodcutting/mining skill + materials are still low'; }
  else { goal = 'fish'; why = 'default: fishing has high XP/value'; }
  const daily = {
    day: q?.dailyQuest?.day,
    claimedNow: claimedNow.length,
    pending: quests.filter((x) => isQuestPending(q, x)).map((x) => ({ id: x.id, kind: x.kind, progress: questProgress(q, x), target: x.target })),
  };
  return { goal, why, forceSwitch: needFishQuest || needGatherQuest, snapshot: { wood: bp.wood, stone: bp.stone, coal: bp.coal, fish: bp.fish, woodcutting: xp.woodcutting, mining: xp.mining, fishing: xp.fishing, avg: st.avg, daily } };
}

(async () => {
  fs.mkdirSync(CTRL, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'orchestrator.log'), '');
  await tg.send('🧠 <b>Orchestrator ON</b> — auto-selects activity by goal. Use /stop to turn it off.').catch(() => {});
  log('orchestrator start');
  for (;;) {
    try {
      const d = await decide();
      log(`evaluate: goal=${d.goal} (${d.why}) | ${JSON.stringify(d.snapshot)}`);
      const elapsed = Date.now() - currentSince;
      if (d.goal !== current && (d.forceSwitch || current === null || elapsed > MIN_RUN_MS)) {
        ensureOnly(d.goal); current = d.goal; currentSince = Date.now();
        await tg.send(`🧠 Switch -> <b>${d.goal === 'fish' ? '🎣 Fishing' : '🪓 Gather'}</b>\n${d.why}`).catch(() => {});
      } else { ensureOnly(current || d.goal); if (!current) { current = d.goal; currentSince = Date.now(); } }
      fs.writeFileSync(path.join(OUT, 'orchestrator-state.json'), JSON.stringify({ current, why: d.why, snapshot: d.snapshot, ts: Date.now() }));
    } catch (e) { log('err: ' + (e.message || '').slice(0, 60)); if (/cookie|401/.test(e.message || '')) lastAuth = 0; }
    await sleep(EVAL_MS);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
