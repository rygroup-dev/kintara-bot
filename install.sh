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

have_cmd() { command -v "$1" >/dev/null 2>&1; }
need_sudo() {
  if have_cmd sudo; then
    sudo "$@"
  else
    "$@"
  fi
}

install_git() {
  if have_cmd git; then return 0; fi
  echo "📦 git not found. Attempting automatic install..."
  if have_cmd apt-get; then
    need_sudo apt-get update
    need_sudo apt-get install -y git
  elif have_cmd dnf; then
    need_sudo dnf install -y git
  elif have_cmd yum; then
    need_sudo yum install -y git
  elif have_cmd brew; then
    brew install git
  else
    echo "❌ git is not installed and no supported package manager was found."
    echo "   Please install git manually, then run the one-liner again."
    exit 1
  fi
}

install_node() {
  if have_cmd node; then return 0; fi
  echo "📦 Node.js not found. Attempting automatic install..."
  if have_cmd apt-get; then
    need_sudo apt-get update
    need_sudo apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | need_sudo bash
    need_sudo apt-get install -y nodejs
  elif have_cmd dnf; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | need_sudo bash
    need_sudo dnf install -y nodejs
  elif have_cmd yum; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | need_sudo bash
    need_sudo yum install -y nodejs
  elif have_cmd brew; then
    brew install node
  else
    echo "❌ Node.js >=18 is not installed and no supported package manager was found."
    echo "   Please install Node.js manually from https://nodejs.org, then rerun the installer."
    exit 1
  fi
}

ensure_node_18_plus() {
  if ! have_cmd node; then install_node; fi
  local major
  major="$(node -p 'process.versions.node.split(\".\")[0]')"
  if [ "${major:-0}" -lt 18 ]; then
    echo "❌ Node.js ${major} detected, but Node.js >=18 is required."
    echo "   Please upgrade Node.js and rerun the installer."
    exit 1
  fi
}

# --- system deps ---
install_git
ensure_node_18_plus
have_cmd npm || { echo "❌ npm is missing even though Node.js is installed. Please fix Node.js/npm first."; exit 1; }

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
