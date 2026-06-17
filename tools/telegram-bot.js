#!/usr/bin/env node
// ============ TELEGRAM CONTROL BOT — controls and reports headless bot status ============
// Control the Kintara bot via Telegram: status, skills, balance, quests, start/stop fishing.
// Uses lib/telegram (long polling). Token+chatId come from .env; chat ID is auto-captured
// when the first message is sent to the bot.
//
// Usage: node tools/telegram-bot.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const tg = require('../lib/telegram');
const { KintaraClient } = require('../lib/kintaraClient');
const { login } = require('../lib/walletAuth');
const { config } = require('../config');
const { pickPlayerName, pickPlayerId, playerLabel } = require('../lib/playerIdentity');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recon');
const PIDFILE = path.join(OUT, 'control', 'fishbot.pid');
const GPIDFILE = path.join(OUT, 'control', 'gatherbot.pid');
const OPIDFILE = path.join(OUT, 'control', 'orch.pid');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cli = null, lastAuth = 0, myPid = null, myName = '';
async function client() {
  if (!cli || Date.now() - lastAuth > 1500000) {
    const a = await login();
    cli = new KintaraClient({ cookie: a.cookie });
    myPid = pickPlayerId(a.player) || myPid;
    myName = pickPlayerName(a.player) || myName;
    const me = await cli.me().catch(() => null);
    myPid = pickPlayerId(me?.player, me, a.player) || myPid;
    myName = pickPlayerName(me?.player, me, a.player) || myName;
    lastAuth = Date.now();
  }
  return cli;
}
function who() { return playerLabel({ name: myName, id: myPid }); }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function pidOf(f) { const p = readJson(f); if (!p?.pid) return null; try { process.kill(p.pid, 0); return p.pid; } catch { return null; } }
function botPid() { return pidOf(PIDFILE); }
function gatherPid() { return pidOf(GPIDFILE); }
function spawnBot(script, args, pidfile) {
  const child = cp.spawn('node', [path.join(ROOT, 'tools', script), ...args], { detached: true, stdio: 'ignore', cwd: ROOT });
  child.unref(); fs.writeFileSync(pidfile, JSON.stringify({ pid: child.pid, started: Date.now() }));
  return child.pid;
}

// ---------- handlers ----------
async function hStatus() {
  await client().catch(() => null);
  const fr = botPid(), gr = gatherPid(), or = pidOf(OPIDFILE);
  const gk = readJson(GPIDFILE)?.kind; const gLbl = gk === 'rock' ? '⛏Mining' : gk === 'tree' ? '🪓Wood' : 'Gather';
  let out = `🤖 <b>Kintara Bot Status</b> — ${who()}\n🧠 Auto: ${or ? '🟢 ON' : '🔴 OFF'} | Fishing: ${fr ? '🟢' : '🔴'} | ${gLbl}: ${gr ? '🟢' : '🔴'}`;
  if (or) {
    const o = readJson(path.join(OUT, 'orchestrator-state.json'));
    if (o) {
      const ageSec = o.ts ? Math.max(0, Math.round((Date.now() - o.ts) / 1000)) : null;
      out += `\n🎯 ${o.current} — ${o.why}${ageSec == null ? '' : `\n🕒 Last auto check: ${ageSec}s ago`}`;
    }
  }
  const s = readJson(path.join(OUT, 'bot-state.json'));
  if (fr && s) out += `\n🎣 fish: ${s.fish} | 🍳 cooked: ${s.cooked} | ✅ ${s.ok}/${s.casts} | 💰 ${s.sold || 0} | ⏱ ${s.ageMin}m`;
  const g = readJson(path.join(OUT, 'gather-state.json'));
  if (gr && g) out += `\n🪓 felled: ${g.felled} | 🪵 wood: ${g.wood} | 🪨 stone: ${g.stone} | coal: ${g.coal} | ⏱ ${g.ageMin}m`;
  return out;
}
async function hSkills() {
  const c = await client(); const st = await c.playerStats(myPid).catch(() => ({}));
  const xp = st.skillXp || {};
  return `📊 <b>Skills</b> — ${who()} (avg lvl ${st.avg || '?'})\n` +
    `⚔️ combat: ${xp.combat ?? 0}\n🪓 woodcutting: ${xp.woodcutting ?? 0}\n⛏ mining: ${xp.mining ?? 0}\n` +
    `🎣 fishing: ${xp.fishing ?? 0}\n🍳 cooking: ${xp.cooking ?? 0}\n🔨 smithing: ${xp.smithing ?? 0}\n` +
    `${(st.avg || 0) >= 5 ? '✅ Spinner unlocked (avg≥5)' : '🔒 Spinner requires avg 5'}`;
}
async function hBalance() {
  const c = await client(); const me = await c.me(); const bp = me.backpack || {};
  let tok = '';
  try { const t = await c.tokenBlimpStats(); tok = `\n🪙 $KINS: $${t.priceUsd} (${t.marketCapLabel})`; } catch {}
  return `💰 <b>Balance</b> — ${who()}\ngold: ${bp.gold || 0}\n🎣 fish: ${bp.fish || 0} | 🍳 cooked: ${bp.cooked_fish_meat || 0}\n🪵 wood: ${bp.wood || 0} | 🪨 stone: ${bp.stone || 0} | coal: ${bp.coal || 0} | metal: ${bp.metal || 0}${tok}`;
}
async function hQuest() {
  const c = await client(); const q = await c.dailyQuestProgress().catch(() => ({}));
  const dq = q?.dailyQuest || {}; const cfg = q?.dailyQuestConfig || {};
  if (!(cfg.quests || []).length) return `📋 <b>Daily Quest</b> — ${who()} (${dq.day || '?'})\n(no quest today yet)`;
  const lines = (cfg.quests || []).map((quest) => {
    const pr = (dq.prog || {})[quest.id] || 0; const cl = (dq.claimed || {})[quest.id];
    return `${cl ? '✅' : pr >= quest.target ? '🎁' : '▫️'} ${quest.label} — ${pr}/${quest.target} (${quest.rewardXpSpreadTotal}XP)`;
  });
  return `📋 <b>Daily Quest</b> — ${who()} (${dq.day})\n` + lines.join('\n');
}
async function hClaimQuests() {
  const c = await client(); const q = await c.dailyQuestProgress().catch(() => ({}));
  const dq = q?.dailyQuest || {}; const cfg = q?.dailyQuestConfig || {};
  const prog = dq.prog || {}; const claimed = dq.claimed || {};
  const ready = (cfg.quests || []).filter((quest) => !claimed[quest.id] && (prog[quest.id] || 0) >= quest.target);
  if (!ready.length) return `🎁 <b>Daily Quest Claim</b> — ${who()}\nNo completed quests ready to claim.`;

  const ok = [], failed = [];
  for (const quest of ready) {
    try {
      await c.dailyQuestClaim(quest.id);
      ok.push(`✅ ${quest.label || quest.kind} (${quest.rewardXpSpreadTotal || 0}XP)`);
    } catch (e) {
      failed.push(`⚠️ ${quest.label || quest.kind}: ${(e.message || '').slice(0, 60)}`);
    }
  }

  return `🎁 <b>Daily Quest Claim</b> — ${who()}\n` +
    (ok.length ? ok.join('\n') : 'No quests claimed.') +
    (failed.length ? `\n\n${failed.join('\n')}` : '');
}
function hStartFish() {
  if (gatherPid()) return '⚠️ Gather bot is ON — run /stop first (1 account = 1 activity).';
  if (botPid()) return '🎣 Fishing bot is already ON.';
  const pid = spawnBot('bot-headless.js', [config.shard], PIDFILE);
  return `🎣 Fishing bot START (pid ${pid}). Queues for ~10min, then grinds+cooks. Check /status.`;
}
function hStartGather(args) {
  if (botPid()) return '⚠️ Fishing bot is ON — run /stop first (1 account = 1 activity).';
  const kind = (args[0] === 'rock' || args[0] === 'stone' || args[0] === 'coal' || args[0] === 'mine') ? 'rock' : 'tree';
  const lbl = kind === 'rock' ? '⛏ mine stone/coal' : '🪓 chop wood';
  const running = gatherPid(); const cur = readJson(GPIDFILE);
  if (running && cur?.kind === kind) return `${lbl} is already ON.`;
  if (running) { try { process.kill(running, 'SIGKILL'); } catch {} try { fs.unlinkSync(GPIDFILE); } catch {} } // switch kind
  const pid = spawnBot('gather-bot.js', [kind, config.shard], GPIDFILE);
  fs.writeFileSync(GPIDFILE, JSON.stringify({ pid, kind, started: Date.now() })); // save kind
  return `${lbl} START (pid ${pid})${running ? ' [switched from ' + (cur?.kind || '?') + ']' : ''}. Queues for ~10min. Check /status.`;
}
function hAuto() {
  if (pidOf(OPIDFILE)) return '🧠 Orchestrator is already ON.';
  const pid = spawnBot('orchestrator.js', [], OPIDFILE);
  return `🧠 Orchestrator START (pid ${pid}) — auto-selects fishing/gather by goal. Use /stop to turn it off.`;
}
function hStop() {
  let msg = [];
  // stop orchestrator first so it does not restart bots
  for (const [name, pf] of [['Orchestrator', OPIDFILE], ['Fishing', PIDFILE], ['Gather', GPIDFILE]]) {
    const pid = pidOf(pf);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} try { fs.unlinkSync(pf); } catch {} msg.push(`🛑 ${name} STOP (pid ${pid})`); }
  }
  return msg.length ? msg.join('\n') : '🔴 All bots are already OFF.';
}
function hHelp() {
  return `🤖 <b>Kintara Bot — Commands</b>\n` +
    `/status — bot status & inventory\n/skills — skill XP & levels\n/balance — gold/$KINS/resources\n/quest — daily quest\n/claim — claim completed daily quests\n` +
    `/fish — fishing + cooking\n/gather — chop wood 🪓\n/mine — mining stone/coal ⛏\n/auto — orchestrator auto-selects 🧠\n/stop — STOP all\n/help — help\n\n` +
    `<i>1 account = 1 activity (safer for anti-cheat). /combat soon.</i>`;
}

const commands = {
  start: () => hHelp(), help: () => hHelp(),
  status: hStatus, skills: hSkills, balance: hBalance, saldo: hBalance,
  quest: hQuest, claim: hClaimQuests, claimquests: hClaimQuests, fish: hStartFish, stop: hStop,
  gather: hStartGather, chop: hStartGather, mine: () => hStartGather(['rock']),
  auto: hAuto, combat: () => '⚔️ Combat is being prepared (RE combat WS messages + survival).',
  sell: () => '💰 Sell is active after the tutorial is complete.',
};

// Set Telegram menu commands to only the currently supported commands, removing old ones
const MENU = [
  { command: 'fish', description: '🎣 Fishing + cooking' },
  { command: 'gather', description: '🪓 Chop wood' },
  { command: 'mine', description: '⛏ Mining stone/coal' },
  { command: 'auto', description: '🧠 Auto-select activity' },
  { command: 'stop', description: '⏹️ Stop all bots' },
  { command: 'status', description: '📊 Bot status + inventory' },
  { command: 'skills', description: '📈 Skill levels & XP' },
  { command: 'balance', description: '💰 Gold/$KINS/resources' },
  { command: 'quest', description: '📋 Daily quest' },
  { command: 'claim', description: '🎁 Claim completed quests' },
  { command: 'help', description: '❓ Command list' },
];
async function syncMenu() {
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/setMyCommands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands: MENU }),
    });
    console.log('[telegram-bot] menu commands synced (' + MENU.length + ' command)');
  } catch (e) { console.error('syncMenu err', e.message); }
}

(async () => {
  fs.mkdirSync(path.join(OUT, 'control'), { recursive: true });
  await syncMenu();
  await tg.send('🤖 <b>Kintara Bot online!</b> Send /help for the command list.').catch(() => {});
  console.log('[telegram-bot] polling...');
  for (;;) {
    try { await tg.pollCommands(commands); } catch (e) { console.error('poll err', e.message); }
    await sleep(2000);
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
