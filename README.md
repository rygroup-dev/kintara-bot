<div align="center">

# 🤖 Kintara Bot

### a **RY GROUP** project

Fully **headless** automation bot for [Kintara.gg](https://kintara.gg), a Solana isometric MMO.
**No browser required.** Wallet login and full control through **Telegram**.

🎣 Fishing · 🍳 Cooking · 🪓 Woodcutting · ⛏ Mining (stone/coal/metal) · 🏦 Banking · 💰 Marketplace · 📋 Daily Quest · 🧠 Auto-Orchestrator

[![Node](https://img.shields.io/badge/node-%3E%3D18-43853d?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

## ⚡ One-line install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/kintara-bot/main/install.sh)
```

The installer clones the repository, installs dependencies, asks for only two required values — your wallet private key and Telegram bot token — writes them to `.env` with `chmod 600`, and starts the Telegram control bot.

**Non-interactive:**
```bash
WALLET_PRIVATE_KEY=your_base58_key TELEGRAM_BOT_TOKEN=123456:AA... \
  bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/kintara-bot/main/install.sh)
```

> 🔒 Your private key should never leave your machine. This project writes it only to the local `.env` file, protected with `chmod 600` and ignored by Git, so it can sign the game login challenge locally. **No cookie/session is required** because the bot logs in from the private key.

## 📱 Telegram control

After installation, open your Telegram bot and send `/start`:

| Command | Action |
|---------|--------|
| `/fish` | 🎣 Fishing + auto-cooking |
| `/gather` | 🪓 Chop wood |
| `/mine` | ⛏ Mine stone + coal + metal |
| `/auto` | 🧠 Let the orchestrator choose the activity automatically |
| `/stop` | ⏹️ Stop all bots |
| `/status` | 📊 Live status + inventory |
| `/skills` | 📈 Skill levels and XP |
| `/balance` | 💰 Gold / $KINS / resources |
| `/quest` | 📋 Daily quest |
| `/claim` | 🎁 Claim all completed daily quests |
| `/spinner` | 🎡 Run the free spinner wheel |
| `/help` | ❓ Command list |

> **1 account = 1 activity**: fishing **or** gathering. This is more natural and safer for anti-cheat behavior.
> `/spinner` checks cooldown, level, cosmetic bag space, and refuses to run while fishing/gathering workers are active because concurrent backpack writes could overwrite rewards. It does not delete or move items automatically.

## 🛠️ How it works (headless, reverse-engineered)

The bot talks directly to the Kintara protocol without rendering the game or opening a browser:

- **Auth**: `/api/auth/challenge` → ed25519 wallet signature → `/api/auth/verify` → session (`lib/walletAuth.js`).
- **Realtime**: WebSocket presence (`wss://kintara.gg/ws/queue|presence`) for movement (`pos`), region, snapshots, and harvest events (`lib/presenceWs.js`).
- **Actions**: fishing (`act:fish` + `grant-fish-xp`), gathering (`harv`/`harv_hit` + `actionProof`), cooking at the Roast Pit, banking (`bankSlots`), marketplace selling (`/api/marketplace/sell`).

## 📋 Requirements

- Node.js ≥ 18
- Solana wallet with a base58 private key, holding **≥ 1,000 $KINS** as required by Kintara, with the game tutorial already completed to unlock selling and quests.
- Telegram bot token from [@BotFather](https://t.me/BotFather).

## 🧩 Manual run (without Telegram)

```bash
npm install
cp .env.example .env   # fill WALLET_PRIVATE_KEY
npm run fish     # fishing + cooking
npm run gather   # wood
npm run mine     # stone/coal
npm run auto     # orchestrator
```

## ⚠️ Disclaimer

Automation tools may violate the game Terms of Service. Use at your own risk. This project is for education and research. Combat in the Wilderness is still **pending** because mobs are client-simulated in real time and currently outside the headless scope.

---

<div align="center"><sub>RY GROUP · MIT License</sub></div>
