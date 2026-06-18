#!/usr/bin/env node
// ============ DAILY-QUEST AUTOPILOT — pure REST, no queue ============
// Loop: read daily-quest-progress -> claim completed quests. Runs in parallel
// with bot-headless, which grinds fish/gather. Re-authenticates the cookie periodically.
//
// Usage: node tools/daily-quest.js
const fs = require('fs');
const path = require('path');
const { KintaraClient } = require('../lib/kintaraClient');
const { login, isWalletBannedError } = require('../lib/walletAuth');

const OUT = path.join(__dirname, '..', 'recon');
const log = (...a) => { const s = `[${new Date().toISOString().slice(11, 19)}] DQ ${a.join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'daily-quest.log'), s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INTERVAL = 180000; // 3 minutes

(async () => {
  let cli, lastAuth = 0;
  fs.mkdirSync(OUT, { recursive: true });
  for (;;) {
    try {
      if (Date.now() - lastAuth > 1800000) { const a = await login(); cli = new KintaraClient({ cookie: a.cookie }); lastAuth = Date.now(); log('auth ok'); }
      const q = await cli.dailyQuestProgress();
      const dq = q?.dailyQuest || {}; const cfg = q?.dailyQuestConfig || {};
      const prog = dq.prog || {}; const claimed = dq.claimed || {};
      const summary = [];
      for (const quest of (cfg.quests || [])) {
        const pr = prog[quest.id] || 0; const done = pr >= quest.target; const cl = !!claimed[quest.id];
        summary.push(`${quest.kind} ${pr}/${quest.target}${cl ? '✓claimed' : done ? '✓READY' : ''}`);
        if (done && !cl) {
          try { const r = await cli.dailyQuestClaim(quest.id); log(`🎁 CLAIMED ${quest.kind} (${quest.rewardXpSpreadTotal}XP) -> ${JSON.stringify(r).slice(0, 80)}`); }
          catch (e) { log(`claim ${quest.kind} failed: ${e.message.slice(0, 50)}`); }
        }
      }
      log('day=' + dq.day + ' | ' + summary.join(' | '));
      fs.writeFileSync(path.join(OUT, 'daily-quest-state.json'), JSON.stringify({ day: dq.day, prog, claimed, ts: Date.now() }));
    } catch (e) {
      log('err: ' + (e.message || '').slice(0, 60));
      if (isWalletBannedError(e)) process.exit(1);
      if (/cookie|401|Non-JSON/.test(e.message || '')) lastAuth = 0;
    }
    await sleep(INTERVAL);
  }
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
