<div align="center">

# 🤖 Kintara Bot

### a **RY GROUP** project

Production-ready, **headless** automation for [Kintara.gg](https://kintara.gg).
No browser. No cookie babysitting. Just wallet login, Telegram control, and a clean one-line install.

🎣 Fishing · 🍳 Cooking · 🪓 Woodcutting · ⛏ Mining (stone/coal/metal) · ⚔️ Combat · 🏦 Banking · 💰 Marketplace · 🎡 Daily Spinner · 📋 Daily Quests · 🧠 Auto-Orchestrator

[![Node](https://img.shields.io/badge/node-%3E%3D18-43853d?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

## ⚡ One-line Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/kintara-bot/main/install.sh)
```

The installer clones the repo, installs dependencies, asks for **just 2 inputs** (wallet private key + Telegram bot token), writes `.env` with locked permissions, and starts the Telegram control bot.

**What you get after install:**

- A running **Telegram-controlled bot** on your machine
- Wallet-based login with **no browser and no manual cookie handling**
- Ready-to-use commands for farming, combat, quests, market checks, spinner, and diagnostics
- A clean `.env` setup so you can restart later with `npm start`

**Non-interactive:**
```bash
WALLET_PRIVATE_KEY=your_base58_key TELEGRAM_BOT_TOKEN=123456:AA... \
  bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/kintara-bot/main/install.sh)
```

> 🔒 Your private key **never leaves your machine** — it is only written to `.env` (chmod 600, git-ignored) and used to sign the game login locally. **No cookie/session needed** — the bot authenticates itself from the private key.

## 🚀 Quick Start

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather)
2. Run the one-line installer on your VPS / Linux server
3. Paste your `WALLET_PRIVATE_KEY` and `TELEGRAM_BOT_TOKEN`
4. Open your Telegram bot
5. Type `/start` then `/help`
6. Run `/auto` to let the bot handle the activity loop automatically

## Why This Bot

- **Actually headless**: no browser automation layer, no Playwright dependency for the core flow, no fragile DOM selectors
- **Telegram-first UX**: run, monitor, stop, inspect, and troubleshoot from chat
- **Safer automation model**: 1 account = 1 activity, bank-first combat flow, auto-revive/keepalive, and version-watch safety checks
- **Built for real VPS use**: one-line installer, persistent config, and clean restart path

## 📱 Control via Telegram

After install, open your Telegram bot and type `/start`:

| Command | Action |
|---------|--------|
| `/fishing` | 🎣 Fishing + auto-cooking |
| `/gather` | 🪓 Chop wood (woodcutting) |
| `/mine` | ⛏ Mine stone + coal + metal |
| `/combat` | ⚔️ Hunt Wilderness mobs (combat XP) |
| `/auto` | 🧠 Orchestrator picks the activity automatically |
| `/stop` | ⏹️ Stop all bots |
| `/status` | 📊 Live status + inventory |
| `/skills` | 📈 Skill levels & XP |
| `/balance` | 💰 Gold / $KINS / resources |
| `/market` | 🛒 Live market prices + interactive buy/sell flow |
| `/spinner` | 🎡 Claim the free daily spin (12h cooldown) |
| `/quest` | 📋 Daily quests |
| `/version` | 🧩 Current game/client version detected by bot |
| `/diag` | 🩺 Auth / queue / tutorial diagnostics |
| `/help` | ❓ Command list |

> **1 account = 1 activity** at a time: fishing, gathering, or combat. This is more natural and safer against anti-cheat heuristics.

## ✨ Included Features

- **Interactive `/market`**: shows live prices, live listings, and supports Telegram button flow for selling inventory-slot items in **gold** or **$KINS**.
- **Daily `/spinner`**: claims the free spin wheel reward and reports cooldown / paid-spin ticker info.
- **Smart `/auto`**: orchestrator chooses the best activity automatically instead of locking you into one loop.
- **Realtime `/status`**: shows current bot state, inventory snapshot, balance, and spinner readiness.
- **Version watchdog**: monitors game version drift and auto-pauses automation when Kintara updates.

## ⚔️ Combat & Survival

`/combat` hunts Wilderness mobs for combat XP with survival-first safeguards built in:

- **Bank-first** — all carried loot is deposited before entering the Wilderness, so a death costs nothing.
- **HP monitoring** — health is tracked from server vitals in real time.
- **Auto-potion** — drinks health/shield potions when HP drops below threshold.
- **Auto-retreat** — falls back to the safe camp and exits to the Mainland when HP is critical.

## 🛠️ How It Works

The bot talks to the Kintara protocol directly, with **no game render and no browser automation layer**:

- **Auth**: `/api/auth/challenge` → ed25519 signature (wallet) → `/api/auth/verify` → session (`lib/walletAuth.js`).
- **Realtime**: presence WebSocket (`wss://kintara.gg/ws/queue|presence`) — movement (`pos`), region, snapshots, harvesting (`lib/presenceWs.js`).
- **Actions**: fishing (`act:fish` + grant-fish-xp), gathering (`harv`/`harv_hit` + action proof), cooking (Roast Pit), banking (`bankSlots`), marketplace (`/api/marketplace/sell`), daily spinner (`/api/auth/daily-spinner-spin`), combat (server-authoritative mob snapshots + `wm_ev` hits).

## 📋 Requirements

- Node.js ≥ 18
- A Solana wallet (base58 private key) that **holds ≥ 1,000 $KINS** and has **completed the in-game tutorial**
- A Telegram bot token ([@BotFather](https://t.me/BotFather)).
- Linux VPS / server recommended for 24/7 uptime

## 🧩 Manual Run

```bash
npm install
cp .env.example .env   # fill in WALLET_PRIVATE_KEY
npm run fish     # fishing + cooking
npm run gather   # wood
npm run mine     # stone/coal/metal
npm run combat   # Wilderness hunting
npm run auto     # orchestrator
```

`/market`, `/spinner`, `/version`, `/diag`, and the richer inline flows are exposed through the Telegram controller (`npm start` or `node tools/telegram-bot.js`).

## 🩺 Troubleshooting

- **Bot does not respond on Telegram**: verify `TELEGRAM_BOT_TOKEN`, then restart with `npm start`
- **Login/auth fails**: re-check `WALLET_PRIVATE_KEY`; it must be a valid base58 Kintara wallet key
- **Marketplace sell blocked**: your character may still be below the required seller skill, or the item is not in an inventory slot
- **Merchant gold trade unavailable**: this is controlled server-side by Kintara, not by the bot

## ⚠️ Disclaimer

Automation tools may violate a game's Terms of Service. Use at your own risk — this is an educational / research project.

---

<div align="center"><sub>RY GROUP · MIT License</sub></div>
