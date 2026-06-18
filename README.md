<div align="center">

# 🤖 Kintara Bot

### a **RY GROUP** project

Fully **headless** automation bot for [Kintara.gg](https://kintara.gg) — a Solana isometric MMO.
**No browser required.** Sign in with your wallet, control everything from **Telegram**.

🎣 Fishing · 🍳 Cooking · 🪓 Woodcutting · ⛏ Mining (stone/coal/metal) · ⚔️ Combat · 🏦 Banking · 💰 Marketplace · 🎡 Daily Spinner · 📋 Daily Quests · 🧠 Auto-Orchestrator

[![Node](https://img.shields.io/badge/node-%3E%3D18-43853d?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

## ⚡ One-line Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/kintara-bot/main/install.sh)
```

The installer: clones the repo → installs dependencies → asks for **just 2 things** (wallet private key + Telegram bot token) → writes `.env` (chmod 600) → starts the Telegram control bot.

**Non-interactive:**
```bash
WALLET_PRIVATE_KEY=your_base58_key TELEGRAM_BOT_TOKEN=123456:AA... \
  bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/kintara-bot/main/install.sh)
```

> 🔒 Your private key **never leaves your machine** — it is only written to `.env` (chmod 600, git-ignored) and used to sign the game login locally. **No cookie/session needed** — the bot authenticates itself from the private key.

## 📱 Control via Telegram

After install, open your Telegram bot → `/start`:

| Command | Action |
|---------|--------|
| `/fish` | 🎣 Fishing + auto-cooking |
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

> **1 account = 1 activity** at a time (fishing **or** gather **or** combat) — more natural / safer against anti-cheat.

## ✨ Included Features

- **Interactive `/market`**: shows live prices, live listings, and supports Telegram button flow for selling inventory-slot items in **gold** or **$KINS**.
- **Daily `/spinner`**: claims the free spin wheel reward and reports cooldown / paid-spin ticker info.
- **Smart `/auto`**: orchestrator chooses the best activity automatically instead of locking you into one loop.
- **Realtime `/status`**: shows current bot state, inventory snapshot, balance, and spinner readiness.

## ⚔️ Combat & Survival

`/combat` hunts Wilderness mobs (zombies) for combat XP, with strict survival built in:

- **Bank-first** — all carried loot is deposited before entering the Wilderness, so a death costs nothing.
- **HP monitoring** — health is tracked from server vitals in real time.
- **Auto-potion** — drinks health/shield potions when HP drops below threshold.
- **Auto-retreat** — falls back to the safe camp and exits to the Mainland when HP is critical.

## 🛠️ How It Works

The bot speaks the Kintara protocol directly — **no game render, no browser**:

- **Auth**: `/api/auth/challenge` → ed25519 signature (wallet) → `/api/auth/verify` → session (`lib/walletAuth.js`).
- **Realtime**: presence WebSocket (`wss://kintara.gg/ws/queue|presence`) — movement (`pos`), region, snapshots, harvesting (`lib/presenceWs.js`).
- **Actions**: fishing (`act:fish` + grant-fish-xp), gathering (`harv`/`harv_hit` + action proof), cooking (Roast Pit), banking (`bankSlots`), marketplace (`/api/marketplace/sell`), daily spinner (`/api/auth/daily-spinner-spin`), combat (server-authoritative mob snapshots + `wm_ev` hits).

## 📋 Requirements

- Node.js ≥ 18
- A Solana wallet (base58 private key) that **holds ≥ 1,000 $KINS** (required to play Kintara) and has **completed the in-game tutorial** (unlocks selling/quests).
- A Telegram bot token ([@BotFather](https://t.me/BotFather)).

## 🧩 Manual Run (without Telegram)

```bash
npm install
cp .env.example .env   # fill in WALLET_PRIVATE_KEY
npm run fish     # fishing + cooking
npm run gather   # wood
npm run mine     # stone/coal/metal
npm run combat   # Wilderness hunting
npm run auto     # orchestrator
```

`/market`, `/spinner`, `/version`, `/diag`, and the richer status/inline flows are exposed through the Telegram controller (`npm start` / `node tools/telegram-bot.js`).

## ⚠️ Disclaimer

Automation tools may violate a game's Terms of Service. Use at your own risk — this is an educational / research project.

---

<div align="center"><sub>RY GROUP · MIT License</sub></div>
