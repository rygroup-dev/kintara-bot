#!/usr/bin/env node
// ============ TELEGRAM CONTROL BOT — kontrol + status headless bot ============
// Kontrol bot Kintara via Telegram: status, skill, saldo, quest, start/stop fishing.
// Pakai lib/telegram (long-poll). Token+chatId dari .env (auto-capture chat id
// saat pertama kirim pesan ke bot).
//
// Pakai: node tools/telegram-bot.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { config } = require('../config');
const tg = require('../lib/telegram');
const { KintaraClient } = require('../lib/kintaraClient');
const { login, isWalletBannedError } = require('../lib/walletAuth');
const { getErrors } = require('../lib/errorbus');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recon');
const PIDFILE = path.join(OUT, 'control', 'fishbot.pid');
const GPIDFILE = path.join(OUT, 'control', 'gatherbot.pid');
const OPIDFILE = path.join(OUT, 'control', 'orch.pid');
const CPIDFILE = path.join(OUT, 'control', 'combatbot.pid');
const TGPIDFILE = path.join(OUT, 'control', 'telegram.pid');
const VERSION_STATEFILE = path.join(OUT, 'game-version-state.json');
const AUTOREVIVE_STATEFILE = path.join(OUT, 'control', 'autorevive.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VERSION_POLL_MS = 10 * 60 * 1000;
const KEEPALIVE_POLL_MS = 20 * 1000;

let cli = null, lastAuth = 0, myPid = null;
async function client() {
  if (!cli || Date.now() - lastAuth > 1500000) { const a = await login(); cli = new KintaraClient({ cookie: a.cookie }); myPid = a.player?.id || myPid; lastAuth = Date.now(); }
  return cli;
}
async function ensureLoginOk() {
  try {
    await client();
    return null;
  } catch (e) {
    if (isWalletBannedError(e)) {
      return '⛔ Wallet ini kena ban server (`wallet_banned`). Bot tidak bisa login atau jalan dengan wallet ini. Coba cek status akun/wallet di game atau hubungi support resmi.';
    }
    throw e;
  }
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function pidOf(f) {
  const p = readJson(f);
  if (!p?.pid) return null;
  try {
    process.kill(p.pid, 0);
    return p.pid;
  } catch {
    try { fs.unlinkSync(f); } catch {}
    return null;
  }
}
function botPid() { return pidOf(PIDFILE); }
function gatherPid() { return pidOf(GPIDFILE); }
function combatPid() { return pidOf(CPIDFILE); }
function fmtAgeMin(min) {
  if (min == null || Number.isNaN(Number(min))) return '?';
  const total = Math.max(0, Math.round(Number(min)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}j ${m}m` : `${m}m`;
}
function activityLabel(name, gatherKind = null) {
  if (name === 'fish') return '🎣 Fishing';
  if (name === 'gather') {
    if (gatherKind === 'rock') return '⛏ Mining';
    if (gatherKind === 'tree') return '🪓 Woodcut';
    return '🪓⛏ Gather All';
  }
  if (name === 'combat') return '⚔️ Combat';
  if (name === 'auto') return '🧠 Auto';
  return 'Idle';
}
function procAgeMin(f) {
  const p = readJson(f);
  if (!p?.started) return null;
  return Math.round((Date.now() - p.started) / 60000);
}
function scriptPath(script) {
  return path.join(ROOT, 'tools', script);
}
function killDuplicateScriptProcesses(script) {
  const target = scriptPath(script);
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
function spawnBot(script, args, pidfile) {
  killDuplicateScriptProcesses(script);
  const child = cp.spawn('node', [scriptPath(script), ...args], { detached: true, stdio: 'ignore', cwd: ROOT });
  child.unref(); fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, started: Date.now() }));
  return child.pid;
}
function readAutoreviveState() {
  const state = readJson(AUTOREVIVE_STATEFILE);
  return state && typeof state === 'object' ? state : {};
}
function saveAutoreviveState(state) {
  fs.writeFileSync(AUTOREVIVE_STATEFILE, JSON.stringify(state, null, 2));
}
function normalizeDesiredState(state) {
  if (!state || typeof state !== 'object') return {};
  const next = { ...state };
  if (next.auto) {
    delete next.fish;
    delete next.gather;
    delete next.combat;
    return next;
  }
  const main = ['combat', 'gather', 'fish'].find((name) => next[name]);
  if (main) {
    for (const name of ['fish', 'gather', 'combat']) {
      if (name !== main) delete next[name];
    }
  }
  return next;
}
function setDesired(service, entry) {
  const state = normalizeDesiredState(readAutoreviveState());
  state[service] = { ...entry, updatedAt: Date.now() };
  saveAutoreviveState(normalizeDesiredState(state));
}
function clearDesired(...services) {
  const state = readAutoreviveState();
  let dirty = false;
  for (const service of services) {
    if (Object.prototype.hasOwnProperty.call(state, service)) {
      delete state[service];
      dirty = true;
    }
  }
  if (dirty) saveAutoreviveState(state);
}
function replaceMainDesired(service, entry) {
  clearDesired('fish', 'gather', 'auto', 'combat');
  setDesired(service, entry);
}
function syncDesiredFromLive() {
  const state = normalizeDesiredState(readAutoreviveState());
  let dirty = false;
  if (pidOf(OPIDFILE) && !state.auto) { state.auto = { updatedAt: Date.now() }; dirty = true; }
  if (!state.auto) {
    if (botPid() && !state.fish) { state.fish = { updatedAt: Date.now() }; dirty = true; }
    if (gatherPid() && !state.gather) {
      state.gather = { kind: readJson(GPIDFILE)?.kind || 'tree', updatedAt: Date.now() };
      dirty = true;
    }
    if (combatPid() && !state.combat) { state.combat = { updatedAt: Date.now() }; dirty = true; }
  } else {
    const normalized = normalizeDesiredState(state);
    if (JSON.stringify(normalized) !== JSON.stringify(state)) {
      dirty = true;
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, normalized);
    }
  }
  if (dirty) saveAutoreviveState(normalizeDesiredState(state));
}
function desiredServiceSpec(name, meta = {}) {
  if (name === 'fish') return { script: 'bot-headless.js', args: [config.shard || 's2'], pidfile: PIDFILE, label: 'Fishing bot' };
  if (name === 'gather') return { script: 'gather-bot.js', args: [meta.kind || 'tree', config.shard || 's2'], pidfile: GPIDFILE, label: meta.kind === 'rock' ? 'Mining bot' : 'Gather bot' };
  if (name === 'auto') return { script: 'orchestrator.js', args: [], pidfile: OPIDFILE, label: 'Orchestrator' };
  if (name === 'combat') return { script: 'combat-bot.js', args: [config.shard || 's2'], pidfile: CPIDFILE, label: 'Combat bot' };
  return null;
}
async function ensureDesiredServices() {
  const state = normalizeDesiredState(readAutoreviveState());
  saveAutoreviveState(state);
  for (const [name, meta] of Object.entries(state)) {
    const spec = desiredServiceSpec(name, meta);
    if (!spec) continue;
    if (pidOf(spec.pidfile)) continue;
    const pid = spawnBot(spec.script, spec.args, spec.pidfile);
    if (name === 'gather') {
      fs.writeFileSync(spec.pidfile, JSON.stringify({ pid, kind: meta.kind || 'tree', started: Date.now() }));
    }
    await tg.send(`♻️ ${spec.label} hidup lagi otomatis (pid ${pid})`).catch(() => {});
  }
}
function readVersionState() { return readJson(VERSION_STATEFILE) || {}; }
function saveVersionState(data) {
  try { fs.writeFileSync(VERSION_STATEFILE, JSON.stringify({ ...data, checkedAt: Date.now() }, null, 2)); } catch {}
}
async function fetchGameVersion() {
  const c = await client();
  const v = await c.version().catch(() => ({}));
  return { sha: v?.sha || null, ok: !!v?.ok };
}
async function maybeNotifyVersionChange() {
  try {
    const current = await fetchGameVersion();
    if (!current.sha) return;
    const prev = readVersionState();
    saveVersionState({ sha: current.sha, previousSha: prev.sha || null });
    if (prev.sha && prev.sha !== current.sha) {
      await tg.send(`🆕 Game update terdeteksi\nold: \`${prev.sha.slice(0, 8)}\`\nnew: \`${current.sha.slice(0, 8)}\`\nCek bot sebelum lanjut auto-run.`).catch(() => {});
    }
  } catch {}
}

// ---------- handlers ----------
async function hStatus() {
  const fr = botPid(), gr = gatherPid(), cb = combatPid(), or = pidOf(OPIDFILE);
  const gatherMeta = readJson(GPIDFILE) || {};
  const gatherState = readJson(path.join(OUT, 'gather-state.json'));
  const gatherKind = gatherState?.kind || gatherMeta?.kind || 'all';
  const gLbl = gatherKind === 'rock' ? '⛏ Mining' : gatherKind === 'tree' ? '🪓 Wood' : '🪓⛏ Gather';
  const orch = readJson(path.join(OUT, 'orchestrator-state.json'));
  const active = cb ? 'combat' : gr ? 'gather' : fr ? 'fish' : or ? (orch?.current || 'auto') : 'idle';
  const activeLabel = activityLabel(active, gatherKind);
  const activeAge = active === 'fish'
    ? fmtAgeMin(procAgeMin(PIDFILE))
    : active === 'gather'
      ? fmtAgeMin(procAgeMin(GPIDFILE))
      : active === 'combat'
        ? fmtAgeMin(procAgeMin(CPIDFILE))
        : null;
  const lines = [
    '🤖 <b>Status Bot Kintara</b>',
    `🎯 <b>Aktif:</b> ${activeLabel}${activeAge ? ` • ${activeAge}` : ''}`,
    `🧠 Auto ${or ? '🟢 ON' : '🔴 OFF'} | 🎣 Fish ${fr ? '🟢' : '🔴'} | ${gLbl} ${gr ? '🟢' : '🔴'} | ⚔️ Combat ${cb ? '🟢' : '🔴'}`,
  ];
  if (or && orch) {
    lines.push('');
    lines.push(`🧠 <b>Auto Mode</b>`);
    lines.push(`• now: ${activityLabel(orch.current, gatherKind)}`);
    lines.push(`• why: ${orch.currentWhy || orch.desiredWhy || '-'}`);
    if (orch.desiredGoal && orch.desiredGoal !== orch.current) {
      lines.push(`• next: ${activityLabel(orch.desiredGoal, gatherKind)}`);
      lines.push(`• hold: ${orch.desiredWhy || '-'}${orch.holdReason ? ` • ${orch.holdReason}` : ''}`);
    }
  }
  const s = readJson(path.join(OUT, 'bot-state.json'));
  const g = gatherState;
  const cs = readJson(path.join(OUT, 'combat-state.json'));
  lines.push('');
  lines.push('📦 <b>Session</b>');
  if (s) lines.push(`🎣 fish ${s.ok || 0}/${s.casts || 0} | 🎒 ${s.fish || 0} | 🍳 ${s.cooked || 0} | 💰 ${s.sold || 0} | ⏱ ${fmtAgeMin(s.ageMin)}`);
  if (g) lines.push(`🪓 felled ${g.felled || 0} | 🪵 ${g.wood || 0} (+${g.gainedWood || 0}) | 🪨 ${g.stone || 0} (+${g.gainedStone || 0}) | ⬛ ${g.coal || 0} (+${g.gainedCoal || 0}) | 🔩 ${g.metal || 0} (+${g.gainedMetal || 0}) | ⏱ ${fmtAgeMin(g.ageMin)}`);
  if (cs) lines.push(`⚔️ kill ${cs.kills || 0} | 🗡️ ${cs.hits || 0} | 📈 +${cs.combatGain || 0}XP | ❤️ ${cs.hp || 0} | 🧪 ${cs.potionsHealth || 0}H/${cs.potionsShield || 0}S | 🏃 ${cs.retreats || 0} | ⏱ ${fmtAgeMin(cs.ageMin)}`);
  return lines.join('\n');
}
async function hSkills() {
  const c = await client(); const st = await c.playerStats(myPid).catch(() => ({}));
  const xp = st.skillXp || {};
  return `📊 <b>Skills</b> (avg lvl ${st.avg || '?'})\n` +
    `⚔️ combat: ${xp.combat ?? 0}\n🪓 woodcutting: ${xp.woodcutting ?? 0}\n⛏ mining: ${xp.mining ?? 0}\n` +
    `🎣 fishing: ${xp.fishing ?? 0}\n🍳 cooking: ${xp.cooking ?? 0}\n🔨 smithing: ${xp.smithing ?? 0}\n` +
    `${(st.avg || 0) >= 5 ? '✅ Spinner unlocked (avg≥5)' : '🔒 Spinner butuh avg 5'}`;
}
async function hBalance() {
  const c = await client(); const me = await c.me(); const bp = me.backpack || {};
  let tok = '';
  try { const t = await c.tokenBlimpStats(); tok = `\n🪙 $KINS: $${t.priceUsd} (${t.marketCapLabel})`; } catch {}
  return `💰 <b>Saldo</b>\ngold: ${bp.gold || 0}\n🎣 fish: ${bp.fish || 0} | 🍳 cooked: ${bp.cooked_fish_meat || 0}\n🪵 wood: ${bp.wood || 0} | 🪨 stone: ${bp.stone || 0} | coal: ${bp.coal || 0} | metal: ${bp.metal || 0}${tok}`;
}
async function hMarket() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  const c = await client();
  const items = [
    ['fish', '🎣 fish'],
    ['cooked_fish_meat', '🍳 cooked'],
    ['wood', '🪵 wood'],
    ['stone', '🪨 stone'],
    ['coal', '⬛ coal'],
    ['metal', '🔩 metal'],
  ];
  const lines = ['🛒 <b>Marketplace</b>'];
  for (const [itemType, label] of items) {
    try {
      const r = await c.marketplaceStats(itemType);
      const last = Array.isArray(r?.samples) && r.samples.length ? r.samples[r.samples.length - 1] : null;
      lines.push(`${label}: avg30d ${r?.avg30d ?? '?'}g | last ${last?.avgUnitPrice ?? '?'}g | sales ${last?.sales ?? 0}`);
    } catch (e) {
      lines.push(`${label}: err ${e.message.slice(0, 40)}`);
    }
  }
  return lines.join('\n');
}
async function hQuest() {
  const c = await client(); const q = await c.dailyQuestProgress().catch(() => ({}));
  const dq = q?.dailyQuest || {}; const cfg = q?.dailyQuestConfig || {};
  if (!(cfg.quests || []).length) return `📋 <b>Daily Quest</b> (${dq.day || '?'})\n(belum ada quest hari ini)`;
  const lines = (cfg.quests || []).map((quest) => {
    const pr = (dq.prog || {})[quest.id] || 0; const cl = (dq.claimed || {})[quest.id];
    return `${cl ? '✅' : pr >= quest.target ? '🎁' : '▫️'} ${quest.label} — ${pr}/${quest.target} (${quest.rewardXpSpreadTotal}XP)`;
  });
  return `📋 <b>Daily Quest</b> (${dq.day})\n` + lines.join('\n');
}
async function hVersion() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  const current = await fetchGameVersion();
  const prev = readVersionState();
  saveVersionState({ sha: current.sha, previousSha: prev.sha || null });
  return `🧩 <b>Game Version</b>\ncurrent: ${current.sha || '?'}\nlast saved: ${prev.sha || current.sha || '?'}\nwatch: auto-detect ON`;
}
async function hDiag() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  const c = await client();
  const me = await c.me().catch(() => ({}));
  const viewer = await c.viewerLevel().catch(() => ({}));
  const servers = await c.servers().catch(() => ({}));
  const player = me?.player || {};
  const tutorialStep = me?.tutorialStep ?? '?';
  const queueable = (servers?.servers || [])
    .filter((s) => !s.minLevel || s.minLevel <= 1)
    .sort((a, b) => (a.queueLength ?? 999) - (b.queueLength ?? 999))
    .slice(0, 3)
    .map((s) => `${s.name}: q${s.queueLength}${s.full ? '' : ' open'}`)
    .join(' | ') || 'n/a';
  const lastErr = Object.values(getErrors())
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))[0];
  const desired = normalizeDesiredState(readAutoreviveState());
  const desiredMain = desired.auto ? '🧠 auto' : desired.combat ? '⚔️ combat' : desired.gather ? `🪓 gather${desired.gather?.kind === 'rock' ? ' rock' : desired.gather?.kind === 'tree' ? ' tree' : ''}` : desired.fish ? '🎣 fish' : 'none';
  const procLine = [
    `tg ${procAgeMin(TGPIDFILE) != null ? `🟢 ${fmtAgeMin(procAgeMin(TGPIDFILE))}` : '🔴 off'}`,
    `auto ${procAgeMin(OPIDFILE) != null ? `🟢 ${fmtAgeMin(procAgeMin(OPIDFILE))}` : '🔴 off'}`,
    `fish ${procAgeMin(PIDFILE) != null ? `🟢 ${fmtAgeMin(procAgeMin(PIDFILE))}` : '🔴 off'}`,
    `gather ${procAgeMin(GPIDFILE) != null ? `🟢 ${fmtAgeMin(procAgeMin(GPIDFILE))}` : '🔴 off'}`,
    `combat ${procAgeMin(CPIDFILE) != null ? `🟢 ${fmtAgeMin(procAgeMin(CPIDFILE))}` : '🔴 off'}`,
  ].join(' | ');
  const lines = [
    '🩺 <b>Diag</b>',
    `👤 ${player.display_name || player.username || '?'} • id ${player.id || '?'}`,
    `🧭 shard ${config.shard || 's2'} • tutorial ${tutorialStep} • avg ${viewer?.avgLevel ?? '?'}`,
    `🎒 inv ${(me?.backpack?.invSlots || []).filter(Boolean).length}/24 • gold ${me?.backpack?.gold || 0}`,
    '',
    '🤖 <b>Process</b>',
    procLine,
    `♻️ desired: ${desiredMain}`,
    `🚪 queue: ${queueable}`,
  ];
  const vs = readVersionState();
  if (vs.sha) lines.push(`🧩 ver: ${String(vs.sha).slice(0, 8)}`);
  if (lastErr) lines.push(`⚠️ last err: ${lastErr.code} @ ${lastErr.context} (${lastErr.count}x)`);
  return lines.join('\n');
}
async function hStartFish() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  if (gatherPid() || combatPid() || pidOf(OPIDFILE)) return '⚠️ Bot lain ON — /stop dulu (1 akun = 1 aktivitas).';
  if (botPid()) return '🎣 Fishing bot udah ON.';
  replaceMainDesired('fish', {});
  const pid = spawnBot('bot-headless.js', [config.shard || 's2'], PIDFILE);
  return `🎣 Fishing bot START (pid ${pid}). Antri ~10min lalu grind+cook. Cek /status.`;
}
async function hStartGather(args) {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  if (botPid() || combatPid() || pidOf(OPIDFILE)) return '⚠️ Bot lain ON — /stop dulu (1 akun = 1 aktivitas).';
  const kind = (args[0] === 'rock' || args[0] === 'stone' || args[0] === 'coal' || args[0] === 'mine') ? 'rock' : 'tree';
  const lbl = kind === 'rock' ? '⛏ mining stone/coal/metal' : '🪓 chop wood';
  const running = gatherPid(); const cur = readJson(GPIDFILE);
  if (running && cur?.kind === kind) return `${lbl} udah ON.`;
  if (running) { try { process.kill(running, 'SIGKILL'); } catch {} try { fs.unlinkSync(GPIDFILE); } catch {} } // switch kind
  replaceMainDesired('gather', { kind });
  const pid = spawnBot('gather-bot.js', [kind, config.shard || 's2'], GPIDFILE);
  fs.writeFileSync(GPIDFILE, JSON.stringify({ pid, kind, started: Date.now() })); // simpan kind
  return `${lbl} START (pid ${pid})${running ? ' [switch dari ' + (cur?.kind || '?') + ']' : ''}. Antri ~10min. Cek /status.`;
}
async function hAuto() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  if (botPid() || gatherPid() || combatPid()) return '⚠️ Bot lain ON — /stop dulu sebelum nyalain orchestrator.';
  if (pidOf(OPIDFILE)) return '🧠 Orchestrator udah ON.';
  replaceMainDesired('auto', {});
  const pid = spawnBot('orchestrator.js', [], OPIDFILE);
  return `🧠 Orchestrator START (pid ${pid}) — auto-pilih fishing/gather by goal. /stop utk matikan.`;
}
async function hStartCombat() {
  const authErr = await ensureLoginOk();
  if (authErr) return authErr;
  if (botPid() || gatherPid() || pidOf(OPIDFILE)) return '⚠️ Bot lain ON — /stop dulu (1 akun = 1 aktivitas).';
  if (combatPid()) return '⚔️ Combat bot udah ON.';
  replaceMainDesired('combat', {});
  const pid = spawnBot('combat-bot.js', [config.shard || 's2'], CPIDFILE);
  return `⚔️ Combat bot START (pid ${pid}).\n🏦 Bank dulu (safety) → masuk Wilderness → hunt zombie.\n🛡️ Auto-potion + retreat saat HP kritis. Antri ~10min. Cek /status.\n\n<i>⚠️ Wilderness = PvP risk. Loot udah di-bank = aman walau mati.</i>`;
}
function hStop() {
  let msg = [];
  clearDesired('fish', 'gather', 'auto', 'combat');
  // matikan orchestrator dulu (biar gak restart bot)
  for (const [name, pf] of [['Orchestrator', OPIDFILE], ['Fishing', PIDFILE], ['Gather', GPIDFILE], ['Combat', CPIDFILE]]) {
    const pid = pidOf(pf);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} try { fs.unlinkSync(pf); } catch {} msg.push(`🛑 ${name} STOP (pid ${pid})`); }
  }
  return msg.length ? msg.join('\n') : '🔴 Semua bot udah OFF.';
}
function hHelp() {
  return `🤖 <b>Kintara Bot — Perintah</b>\n` +
    `/status — status bot & inventory\n/skills — XP & level skill\n/balance — gold/$KINS/resource\n/market — harga marketplace\n/version — versi game saat ini\n/quest — daily quest\n/diag — auth, queue, tutorial, process\n` +
    `/fish — fishing + cooking\n/gather — chop wood 🪓\n/mine — mining stone/coal/metal ⛏\n/combat — hunt zombie Wilderness ⚔️\n/auto — orchestrator pilih otomatis 🧠\n/stop — STOP semua\n/help — bantuan\n\n` +
    `<i>1 akun = 1 aktivitas (lebih aman anti-cheat). Combat = bank-first + auto-survival.</i>`;
}

const commands = {
  start: () => hHelp(), help: () => hHelp(),
  status: hStatus, skills: hSkills, balance: hBalance, saldo: hBalance, market: hMarket, harga: hMarket, version: hVersion, versi: hVersion,
  quest: hQuest, diag: hDiag, fish: hStartFish, stop: hStop,
  gather: hStartGather, chop: hStartGather, mine: () => hStartGather(['rock']),
  auto: hAuto, combat: hStartCombat,
  sell: () => '💰 Sell aktif setelah tutorial selesai.',
};

// Set menu command Telegram = HANYA yg dipakai sekarang (hapus sisa lama)
const MENU = [
  { command: 'fish', description: '🎣 Fishing + cooking' },
  { command: 'gather', description: '🪓 Chop wood' },
  { command: 'mine', description: '⛏ Mining stone/coal/metal' },
  { command: 'combat', description: '⚔️ Hunt zombie Wilderness' },
  { command: 'auto', description: '🧠 Auto-pilih aktivitas' },
  { command: 'stop', description: '⏹️ Stop semua bot' },
  { command: 'status', description: '📊 Status bot + inventory' },
  { command: 'diag', description: '🩺 Auth, queue, tutorial' },
  { command: 'market', description: '🛒 Harga marketplace' },
  { command: 'version', description: '🧩 Versi game' },
  { command: 'skills', description: '📈 Level & XP skill' },
  { command: 'balance', description: '💰 Gold/$KINS/resource' },
  { command: 'quest', description: '📋 Daily quest' },
  { command: 'help', description: '❓ Daftar command' },
];
async function syncMenu() {
  try {
    const { config } = require('../config');
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/setMyCommands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands: MENU }),
    });
    console.log('[telegram-bot] menu command di-sync (' + MENU.length + ' command)');
  } catch (e) { console.error('syncMenu err', e.message); }
}

(async () => {
  fs.mkdirSync(path.join(OUT, 'control'), { recursive: true });
  fs.writeFileSync(TGPIDFILE, JSON.stringify({ pid: process.pid, started: Date.now() }));
  process.on('exit', () => { try { fs.unlinkSync(TGPIDFILE); } catch {} });
  syncDesiredFromLive();
  await syncMenu();
  await maybeNotifyVersionChange();
  await ensureDesiredServices();
  await tg.send('🤖 <b>Kintara Bot online!</b> Ketik /help buat daftar perintah.').catch(() => {});
  console.log('[telegram-bot] polling...');
  let nextVersionPollAt = Date.now() + VERSION_POLL_MS;
  let nextKeepaliveAt = Date.now() + KEEPALIVE_POLL_MS;
  for (;;) {
    try { await tg.pollCommands(commands); } catch (e) { console.error('poll err', e.message); }
    if (Date.now() >= nextVersionPollAt) {
      await maybeNotifyVersionChange();
      nextVersionPollAt = Date.now() + VERSION_POLL_MS;
    }
    if (Date.now() >= nextKeepaliveAt) {
      try { await ensureDesiredServices(); } catch (e) { console.error('keepalive err', e.message); }
      nextKeepaliveAt = Date.now() + KEEPALIVE_POLL_MS;
    }
    await sleep(2000);
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
