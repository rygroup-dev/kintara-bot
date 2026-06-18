// ============ TELEGRAM CONTROL ============
// Zero-dependency Telegram bot client (long polling) — kirim notif & terima command.
const fs = require('fs');
const path = require('path');
const { config, persistEnv } = require('../config');

const TG_API = config.telegramToken ? `https://api.telegram.org/bot${config.telegramToken}` : null;
const STATE_DIR = path.join(__dirname, '..', 'recon', 'control');
const OFFSET_PATH = path.join(STATE_DIR, 'telegram-offset.json');

function loadOffset() {
  try {
    return JSON.parse(fs.readFileSync(OFFSET_PATH, 'utf8')).offset || 0;
  } catch {
    return 0;
  }
}

function saveOffset(offset) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(OFFSET_PATH, JSON.stringify({ offset }));
  } catch (e) {
    console.error('[telegram] gagal simpan offset:', e.message);
  }
}

function isAuthorizedChat(msg) {
  const chatId = String(msg?.chat?.id || '');
  if (!chatId) return false;
  if (!config.telegramChatId) {
    persistEnv('TELEGRAM_CHAT_ID', chatId);
    config.telegramChatId = chatId;
    return true;
  }
  return chatId === String(config.telegramChatId);
}

async function tgCall(method, body) {
  if (!TG_API) return null;
  try {
    const res = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    console.error('[telegram] error:', e.message);
    return null;
  }
}

function toPlainTelegramText(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

async function send(text) {
  if (!config.telegramChatId) {
    console.log('[telegram:no-chat-id]', text);
    return;
  }
  return tgCall('sendMessage', {
    chat_id: config.telegramChatId,
    text: toPlainTelegramText(text),
  });
}

let offset = loadOffset();

/**
 * Poll update terbaru & jalankan handler command.
 * @param {Record<string, (args: string[]) => Promise<string>|string>} commands - key tanpa '/'
 */
async function pollCommands(commands) {
  if (!TG_API) return;
  const res = await tgCall('getUpdates', { offset, timeout: 0 });
  if (!res?.ok) return;

  for (const update of res.result || []) {
    offset = update.update_id + 1;
    saveOffset(offset);
    const msg = update.message;
    if (!msg?.text) continue;

    if (!isAuthorizedChat(msg)) continue;

    const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
    const cmd = cmdRaw.replace(/^\//, '').toLowerCase();

    const handler = commands[cmd];
    if (handler) {
      try {
        const reply = await handler(args);
        if (reply) await send(reply);
      } catch (e) {
        await send(`⚠️ Error menjalankan /${cmd}: ${e.message}`);
      }
    }
  }
}

module.exports = { send, pollCommands };
