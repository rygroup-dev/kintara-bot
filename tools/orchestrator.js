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
const { isWalletBannedError } = require('../lib/walletAuth');
const tg = require('../lib/telegram');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recon');
const CTRL = path.join(OUT, 'control');
const FPID = path.join(CTRL, 'fishbot.pid'), GPID = path.join(CTRL, 'gatherbot.pid');
const CPID = path.join(CTRL, 'combatbot.pid');
const OPID = path.join(CTRL, 'orch.pid');
const STATEFILE = path.join(OUT, 'orchestrator-state.json');
const FSTATE = path.join(OUT, 'bot-state.json');
const GSTATE = path.join(OUT, 'gather-state.json');
const CSTATE = path.join(OUT, 'combat-state.json');
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] ORCH ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'orchestrator.log'), s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const safeUnlink = (f) => { try { fs.unlinkSync(f); } catch {} };
const pidOf = (f) => {
  const p = readJson(f);
  if (!p?.pid) return null;
  try {
    process.kill(p.pid, 0);
    return p.pid;
  } catch {
    try { fs.unlinkSync(f); } catch {}
    return null;
  }
};

function killDuplicateScriptProcesses(script) {
  const target = path.join(ROOT, 'tools', script);
  try {
    const rows = cp.execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const row of rows) {
      const m = row.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const args = m[2];
      if (!pid || pid === process.pid) continue;
      if (args.includes(target) || args.includes(`tools/${script}`)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  } catch {}
}

function spawnDetached(script, args, pidfile, extra = {}) {
  killDuplicateScriptProcesses(script);
  const child = cp.spawn('node', [path.join(ROOT, 'tools', script), ...args], { detached: true, stdio: 'ignore', cwd: ROOT });
  child.unref();
  fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, started: Date.now(), ...extra }));
  return child.pid;
}

const EVAL_MS = 600000;          // evaluasi tiap 10 menit (switch hemat)
const MIN_RUN_MS = 1500000;      // minimal 25 menit per aktivitas sebelum boleh switch (hindari antri bolak-balik)

let cli, lastAuth = 0, current = null, currentSince = 0, myPid = null;
async function client() { if (!cli) { const { client: c, player } = await KintaraClient.create(); cli = c; myPid = player?.id || myPid; lastAuth = Date.now(); } return cli; }
function saveState(data) {
  fs.writeFileSync(STATEFILE, JSON.stringify({ ...data, ts: Date.now() }, null, 2));
}

// Pilih shard yg BISA dimasuki wallet (gate=ok) dgn queue terkecil. Akun belum
// lvl 20 & non-membership -> s1-s3 ditolak. FLOOR keras: shard >= KINTARA_MIN_SHARD
// (default 4). gate-check jadi lapis kedua biar ngikut perubahan peta server.
const ORCH_MIN_SHARD = Math.max(1, parseInt(process.env.KINTARA_MIN_SHARD || '4', 10) || 4);
let _shardCache = { ts: 0, shard: null };
async function pickShard() {
  if (Date.now() - _shardCache.ts < 120000 && _shardCache.shard) return _shardCache.shard;
  try {
    const c = await client();
    const r = await c.servers();
    const bypass = process.env.KINTARA_ALLOW_LOW_SERVERS === '1';
    const list = (r.servers || []).filter((x) => x && x.id != null);
    const eligible = bypass ? list : list.filter((x) => Number(x.id) >= ORCH_MIN_SHARD);
    const ranked = (eligible.length ? eligible : list)
      .sort((a, b) => (Number(a.queueLength || 0) - Number(b.queueLength || 0)) || (a.full === b.full ? 0 : a.full ? 1 : -1));
    if (!bypass) {
      for (const sv of ranked) {
        let ok = null;
        try { const g = await c.get(`/api/auth/gate-check?shard=${Number(sv.id) | 0}`); ok = g && g.gate === 'ok'; }
        catch (e) { ok = e && e.status === 403 ? false : null; }
        if (ok === true) { _shardCache = { ts: Date.now(), shard: 's' + sv.id }; return _shardCache.shard; }
      }
      if (ranked[0]) { _shardCache = { ts: Date.now(), shard: 's' + ranked[0].id }; return _shardCache.shard; }
    } else if (ranked[0]) { _shardCache = { ts: Date.now(), shard: 's' + ranked[0].id }; return _shardCache.shard; }
  } catch {}
  return config.shard || 's4';
}

async function ensureOnly(activity) {
  // pastikan cuma `activity` yg jalan
  const fp = pidOf(FPID), gp = pidOf(GPID), combatPid = pidOf(CPID);
  const gatherMeta = readJson(GPID);
  if (combatPid) { try { process.kill(combatPid, 'SIGKILL'); } catch {} safeUnlink(CPID); safeUnlink(CSTATE); }
  if (activity === 'fish') {
    if (gp) { try { process.kill(gp, 'SIGKILL'); } catch {} safeUnlink(GPID); safeUnlink(GSTATE); }
    if (!pidOf(FPID)) { const shard = await pickShard(); const pid = spawnDetached('bot-headless.js', [shard], FPID); log('▶️ START fishing (pid ' + pid + ') shard=' + shard); }
  } else if (activity === 'gather') {
    if (fp) { try { process.kill(fp, 'SIGKILL'); } catch {} safeUnlink(FPID); safeUnlink(FSTATE); }
    if (gp && gatherMeta?.kind && gatherMeta.kind !== 'all') {
      try { process.kill(gp, 'SIGKILL'); } catch {}
      safeUnlink(GPID);
      safeUnlink(GSTATE);
    }
    if (!pidOf(GPID)) { const shard = await pickShard(); const pid = spawnDetached('gather-bot.js', ['all', shard], GPID, { kind: 'all', shard }); log('▶️ START gather-all (pid ' + pid + ') shard=' + shard); }
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
  if (needFishQuest) { goal = 'fish'; why = 'unfinished daily fishing quest'; }
  else if (gatherSkillLow && (woodLow || stoneLow)) { goal = 'gather'; why = 'woodcutting/mining progression and materials are still low'; }
  else { goal = 'fish'; why = 'default: fishing currently has the best XP/value profile'; }
  return { goal, why, snapshot: { wood: bp.wood, stone: bp.stone, coal: bp.coal, fish: bp.fish, woodcutting: xp.woodcutting, mining: xp.mining, fishing: xp.fishing, avg: st.avg } };
}

(async () => {
  fs.mkdirSync(CTRL, { recursive: true });
  killDuplicateScriptProcesses('orchestrator.js');
  fs.writeFileSync(OPID, JSON.stringify({ pid: process.pid, started: Date.now() }));
  process.on('exit', () => { try { fs.unlinkSync(OPID); } catch {} });
  fs.writeFileSync(path.join(OUT, 'orchestrator.log'), '');
  await tg.send('🧠 <b>Orchestrator ON</b> — smart activity switching is active. Use /stop to turn it off.').catch(() => {});
  log('orchestrator start');
  for (;;) {
    try {
      const d = await decide();
      log(`evaluasi: goal=${d.goal} (${d.why}) | ${JSON.stringify(d.snapshot)}`);
      const elapsed = Date.now() - currentSince;
      let switched = false;
      let holdReason = null;
      if (d.goal !== current && (current === null || elapsed > MIN_RUN_MS)) {
        await ensureOnly(d.goal); current = d.goal; currentSince = Date.now();
        switched = true;
        await tg.send(`🧠 Switch -> <b>${d.goal === 'fish' ? '🎣 Fishing' : '🪓 Gather'}</b>\nReason: ${d.why}`).catch(() => {});
      } else {
        await ensureOnly(current || d.goal);
        if (!current) { current = d.goal; currentSince = Date.now(); }
        if (d.goal !== current) {
          const remainingMs = Math.max(0, MIN_RUN_MS - elapsed);
          holdReason = `hold current activity for ${Math.ceil(remainingMs / 60000)}m more`;
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
      if (/cookie|401/.test(e.message || '')) { cli = null; lastAuth = 0; }
    }
    await sleep(EVAL_MS);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
