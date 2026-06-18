#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { login, isWalletBannedError } = require('../lib/walletAuth');
const { KintaraClient } = require('../lib/kintaraClient');
const { launchBrowser, enterWorld } = require('../lib/browserSession');
const tg = require('../lib/telegram');
const { config, persistEnv } = require('../config');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'recon');
const CTRL = path.join(OUT, 'control');
const PIDFILE = path.join(CTRL, 'tutorialwatch.pid');
const STATEFILE = path.join(OUT, 'tutorial-watch-state.json');
const LOGFILE = path.join(OUT, 'tutorial-watch.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] TUTWATCH ${a.join(' ')}`;
  console.log(s);
  try { fs.appendFileSync(LOGFILE, s + '\n'); } catch {}
};

function saveState(data) {
  try { fs.writeFileSync(STATEFILE, JSON.stringify({ ...data, ts: Date.now() }, null, 2)); } catch {}
}

function parseQueueInfo(text) {
  const body = String(text || '');
  const m = body.match(/IN QUEUE\s*·?\s*(\d+)\s*AHEAD/i) || body.match(/players ahead of you\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

async function refreshCookie() {
  const auth = await login();
  persistEnv('KINTARA_SESSION_COOKIE', auth.cookie);
  if (auth.player?.id) persistEnv('MY_PLAYER_ID', String(auth.player.id));
  return auth;
}

async function fetchPlayerState() {
  const auth = await refreshCookie();
  const cli = new KintaraClient({ cookie: auth.cookie });
  const me = await cli.me();
  return { auth, cli, me };
}

async function monitorInWorld(page, cli, initialTutorial) {
  let lastTutorial = initialTutorial;
  let lastHint = '';
  let hintGoneCount = 0;
  await tg.send(`✅ Masuk world. Tutorial step saat ini: ${lastTutorial}`).catch(() => {});
  for (;;) {
    const me = await cli.me().catch(() => ({}));
    const tutorialStep = me?.tutorialStep ?? lastTutorial;
    const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000)).catch(() => '');
    const hint = (body.match(/TUTORIAL[\s\S]{0,220}/i) || [''])[0].trim();
    if (tutorialStep !== lastTutorial) {
      lastTutorial = tutorialStep;
      saveState({ phase: 'in_world', tutorialStep, hint, enteredWorld: true });
      await tg.send(`📈 Tutorial berubah ke step ${tutorialStep}${hint ? `\n${hint.slice(0, 220)}` : ''}`).catch(() => {});
    }
    if (hint && hint !== lastHint) {
      lastHint = hint;
      hintGoneCount = 0;
      saveState({ phase: 'in_world', tutorialStep: lastTutorial, hint, enteredWorld: true });
      log('tutorial hint: ' + hint.slice(0, 160));
    } else if (!hint) {
      hintGoneCount += 1;
      if (hintGoneCount >= 4 && lastTutorial > initialTutorial) {
        saveState({ phase: 'completed_or_hidden', tutorialStep: lastTutorial, enteredWorld: true });
        await tg.send(`🎉 Tutorial watcher: tutorial kemungkinan sudah selesai / panel tutorial sudah hilang. Step terakhir: ${lastTutorial}`).catch(() => {});
        return;
      }
    } else {
      hintGoneCount = 0;
    }
    await sleep(15000);
  }
}

(async () => {
  fs.mkdirSync(CTRL, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, started: Date.now() }));
  process.on('exit', () => { try { fs.unlinkSync(PIDFILE); } catch {} });
  fs.writeFileSync(LOGFILE, '');

  const { cli, me } = await fetchPlayerState();
  const initialTutorial = me?.tutorialStep ?? 0;
  saveState({ phase: 'boot', tutorialStep: initialTutorial, enteredWorld: false });
  await tg.send(`👀 Tutorial watcher ON\nShard: ${config.shard}\nTutorial step: ${initialTutorial}`).catch(() => {});

  const { browser, page } = await launchBrowser();
  let lastQueue = null;
  let lastQueueNoticeAt = 0;
  const pagePoll = setInterval(async () => {
    try {
      const body = await page.evaluate(() => document.body?.innerText || '');
      const ahead = parseQueueInfo(body);
      if (ahead != null) {
        saveState({ phase: 'queue', tutorialStep: initialTutorial, queueAhead: ahead, enteredWorld: false });
        const shouldNotify = lastQueue === null || ahead <= 3 || ahead < lastQueue || (Date.now() - lastQueueNoticeAt > 180000 && ahead !== lastQueue);
        if (shouldNotify) {
          lastQueue = ahead;
          lastQueueNoticeAt = Date.now();
          await tg.send(`🚪 Queue update: ${ahead} ahead di ${config.shard}`).catch(() => {});
        }
      }
    } catch {}
  }, 15000);

  try {
    const ok = await enterWorld(page, (msg) => log(msg), 60);
    clearInterval(pagePoll);
    if (!ok) {
      const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 2000)).catch(() => '');
      saveState({ phase: 'timeout', tutorialStep: initialTutorial, enteredWorld: false, body });
      await tg.send(`⏳ Tutorial watcher timeout: belum tembus masuk world.\nQueue terakhir: ${lastQueue ?? '?'}`).catch(() => {});
      return;
    }
    saveState({ phase: 'in_world', tutorialStep: initialTutorial, enteredWorld: true });
    await monitorInWorld(page, cli, initialTutorial);
  } finally {
    clearInterval(pagePoll);
    try { await browser.close(); } catch {}
  }
})().catch(async (e) => {
  saveState({ phase: 'error', error: e.message, enteredWorld: false });
  if (isWalletBannedError(e)) await tg.send('⛔ Tutorial watcher gagal start: wallet kena ban server.').catch(() => {});
  else await tg.send(`⚠️ Tutorial watcher error: ${e.message}`).catch(() => {});
  log('FATAL ' + (e.stack || e.message));
  process.exit(1);
});
