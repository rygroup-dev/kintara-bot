#!/usr/bin/env bash
# ============================================================
#  KINTARA BOT — one-liner installer
#  bash <(curl -fsSL https://raw.githubusercontent.com/rygroup-dev/kintara-bot/main/install.sh)
#
#  Non-interactive:
#  WALLET_PRIVATE_KEY=xxx TELEGRAM_BOT_TOKEN=yyy bash <(curl -fsSL .../install.sh)
# ============================================================
set -euo pipefail

REPO="https://github.com/rygroup-dev/kintara-bot.git"
DIR="${KINTARA_DIR:-kintara-bot}"

echo "🤖 Kintara Bot installer"

# --- Node check ---
command -v node >/dev/null 2>&1 || { echo "❌ Node.js >=18 is not installed. Install it first: https://nodejs.org"; exit 1; }
command -v git  >/dev/null 2>&1 || { echo "❌ git is not installed."; exit 1; }

# --- clone / update ---
if [ -d "$DIR/.git" ]; then
  echo "📂 updating repo..."; git -C "$DIR" pull --ff-only
else
  echo "📥 cloning repo..."; git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

# --- deps ---
echo "📦 installing dependencies..."
npm install --no-audit --no-fund --omit=optional

# --- .env (only if missing) ---
if [ ! -f .env ]; then
  WK="${WALLET_PRIVATE_KEY:-}"
  TT="${TELEGRAM_BOT_TOKEN:-}"
  if [ -z "$WK" ]; then read -rsp "🔑 Solana WALLET_PRIVATE_KEY (base58, hidden): " WK </dev/tty; echo; fi
  if [ -z "$TT" ]; then read -rp  "💬 TELEGRAM_BOT_TOKEN (from @BotFather): " TT </dev/tty; fi
  cp .env.example .env
  # safe inject (use | as delimiter; base58/token values never contain |)
  sed -i "s|^WALLET_PRIVATE_KEY=.*|WALLET_PRIVATE_KEY=${WK}|" .env
  sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=${TT}|" .env
  chmod 600 .env
  echo "✅ .env created (chmod 600, git-ignored)."
else
  echo "ℹ️  .env already exists — skipped."
fi

# --- start telegram control bot (background) ---
echo "🚀 starting Telegram control bot..."
mkdir -p recon/control
nohup node tools/telegram-bot.js > recon/telegram.log 2>&1 &
echo $! > recon/control/telegram.pid
sleep 2
echo ""
echo "✅ DONE! Control bot is running (pid $(cat recon/control/telegram.pid))."
echo "   Open your Telegram bot, type /start then /help."
echo "   Commands: /fishing /gather /mine /combat /auto /stop /status /skills /balance /quest"
echo "   Log: $DIR/recon/telegram.log"
