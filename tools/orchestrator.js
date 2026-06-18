#!/usr/bin/env node
// ============ ORCHESTRATOR BRAIN — pilih aktivitas otomatis by goal ============
// Tiap interval: evaluasi skill + inventory + quest -> pilih aktivitas terbaik
// (fishing ATAU gather) -> kelola proses bot (start/stop). 1 akun = 1 aktivitas
// (beda realm), jadi switch = restart bot (antri lagi) — switch HEMAT (cuma pas
// goal-chunk selesai, bukan tiap menit).
//
// Goal priority (default):
//   1) Cooking skill rendah (avg butuh naik) / butuh ikan -> FISHING (fish+cook)
//   2) Woodcutting/mining rendah / butuh material (build/sell) -> GATHER (all)
//   3) Default -> FISHING (XP value tinggi)
//
// Pakai: node tools/orchestrator.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { config } = require('../config');
const { KintaraClient } = require('../lib/kintaraClient');
const { login, isWalletBannedError } = require('../lib/walletAuth');
const tg = require('../lib/telegram');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recon');
const CTRL = path.join(OUT, 'control');
const FPID = path.join(CTRL, 'fishbot.pid'), GPID = path.join(CTRL, 'gatherbot.pid');
const CPID = path.join(CTRL, 'combatbot.pid');
const STATEFILE = path.join(OUT, 'orchestrator-state.json');
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ORCH ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'orchestrator.log'), s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const pidOf = (f) => { const p = readJson(f); if (!p?.pid) return null; try { process.kill(p.pid, 0); return p.pid; } catch { return null; } };

const EVAL_MS = 600000;          // evaluasi tiap 10 menit (switch hemat)
const MIN_RUN_MS = 1500000;      // minimal 25 menit per aktivitas sebelum boleh switch (hindari antri bolak-balik)

let cli, lastAuth = 0, current = null, currentSince = 0, myPid = null;
async function client() { if (!cli || Date.now() - lastAuth > 1500000) { const a = await login(); cli = new KintaraClient({ cookie: a.cookie }); myPid = a.player?.id || myPid; lastAuth = Date.now(); } return cli; }
function saveState(data) {
  fs.writeFileSync(STATEFILE, JSON.stringify({ ...data, ts: Date.now() }, null, 2));
}

function ensureOnly(activity) {
  // pastikan cuma `activity` yg jalan
  const fp = pidOf(FPID), gp = pidOf(GPID), combatPid = pidOf(CPID);
  if (combatPid) { try { process.kill(combatPid, 'SIGKILL'); fs.unlinkSync(CPID); } catch {} }
  if (activity === 'fish') {
    if (gp) { try { process.kill(gp, 'SIGKILL'); fs.unlinkSync(GPID); } catch {} }
    if (!pidOf(FPID)) { const c = cp.spawn('node', [path.join(ROOT, 'tools', 'bot-headless.js'), config.shard || 's2'], { detached: true, stdio: 'ignore', cwd: ROOT }); c.unref(); fs.writeFileSync(FPID, JSON.stringify({ pid: c.pid, started: Date.now() })); log('▶️ START fishing (pid ' + c.pid + ')'); }
  } else if (activity === 'gather') {
    if (fp) { try { process.kill(fp, 'SIGKILL'); fs.unlinkSync(FPID); } catch {} }
    if (!pidOf(GPID)) { const c = cp.spawn('node', [path.join(ROOT, 'tools', 'gather-bot.js'), 'all', config.shard || 's2'], { detached: true, stdio: 'ignore', cwd: ROOT }); c.unref(); fs.writeFileSync(GPID, JSON.stringify({ pid: c.pid, started: Date.now() })); log('▶️ START gather-all (pid ' + c.pid + ')'); }
  }
}

async function decide() {
  const c = await client();
  const me = await c.me().catch(() => ({})); const bp = me.backpack || {};
  const st = await c.playerStats(myPid).catch(() => ({})); const xp = st.skillXp || {};
  let q = {}; try { q = await c.dailyQuestProgress(); } catch {}
  const quests = q?.dailyQuestConfig?.quests || [];
  // sinyal goal
  const needFishQuest = quests.some((x) => x.kind === 'fish' && (q.dailyQuest?.prog?.[x.id] || 0) < x.target);
  const woodLow = (bp.wood || 0) < 100, stoneLow = (bp.stone || 0) < 100;
  const gatherSkillLow = (xp.woodcutting || 0) < 5000 || (xp.mining || 0) < 5000; // level skill gather masih kecil
  // keputusan
  let goal, why;
  if (needFishQuest) { goal = 'fish'; why = 'daily-quest fish belum kelar'; }
  else if (gatherSkillLow && (woodLow || stoneLow)) { goal = 'gather'; why = 'skill woodcutting/mining + material masih rendah'; }
  else { goal = 'fish'; why = 'default: fishing XP/value tinggi'; }
  return { goal, why, snapshot: { wood: bp.wood, stone: bp.stone, coal: bp.coal, fish: bp.fish, woodcutting: xp.woodcutting, mining: xp.mining, fishing: xp.fishing, avg: st.avg } };
}

(async () => {
  fs.mkdirSync(CTRL, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'orchestrator.log'), '');
  await tg.send('🧠 <b>Orchestrator ON</b> — auto-pilih aktivitas by goal. /stop utk matikan.').catch(() => {});
  log('orchestrator start');
  for (;;) {
    try {
      const d = await decide();
      log(`evaluasi: goal=${d.goal} (${d.why}) | ${JSON.stringify(d.snapshot)}`);
      const elapsed = Date.now() - currentSince;
      let switched = false;
      let holdReason = null;
      if (d.goal !== current && (current === null || elapsed > MIN_RUN_MS)) {
        ensureOnly(d.goal); current = d.goal; currentSince = Date.now();
        switched = true;
        await tg.send(`🧠 Switch -> <b>${d.goal === 'fish' ? '🎣 Fishing' : '🪓 Gather'}</b>\n${d.why}`).catch(() => {});
      } else {
        ensureOnly(current || d.goal);
        if (!current) { current = d.goal; currentSince = Date.now(); }
        if (d.goal !== current) {
          const remainingMs = Math.max(0, MIN_RUN_MS - elapsed);
          holdReason = `tahan switch ${Math.ceil(remainingMs / 60000)}m lagi`;
        }
      }
      saveState({
        current,
        currentLabel: current === 'fish' ? 'Fishing' : current === 'gather' ? 'Gather' : current,
        currentSince,
        currentAgeMin: currentSince ? Math.round((Date.now() - currentSince) / 60000) : 0,
        currentWhy: switched ? d.why : (d.goal === current ? d.why : 'mode sekarang masih dipertahankan'),
        desiredGoal: d.goal,
        desiredLabel: d.goal === 'fish' ? 'Fishing' : d.goal === 'gather' ? 'Gather' : d.goal,
        desiredWhy: d.why,
        holdReason,
        snapshot: d.snapshot,
      });
    } catch (e) {
      log('err: ' + (e.message || '').slice(0, 60));
      if (isWalletBannedError(e)) {
        await tg.send('⛔ Orchestrator berhenti: wallet kena ban server (`wallet_banned`), jadi login ditolak.').catch(() => {});
        process.exit(1);
      }
      if (/cookie|401/.test(e.message || '')) lastAuth = 0;
    }
    await sleep(EVAL_MS);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
