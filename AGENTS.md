# Agent Guide

This file gives LLM agents the operating rules for this repository. Keep generated code, comments, docs, and user-facing strings in English unless a task explicitly asks otherwise.

## Project summary

Kintara Bot is a Node.js headless automation bot for Kintara.gg. It logs in with a Solana wallet signature, connects to Kintara REST/WebSocket endpoints, and exposes control through Telegram.

## Start here

Read these files before making changes:

1. `docs/PRODUCT.md` — product purpose, users, constraints, risks.
2. `docs/ARCHITECTURE.md` — runtime architecture and module map.
3. `README.md` — operator-facing setup and commands.
4. `package.json` — supported scripts and dependency list.

## Repository rules

- Do not add AI attribution or `Co-Authored-By` lines.
- Use conventional commit messages when commits are requested.
- Do not run the bot, connect to Kintara, or call Telegram unless the user explicitly asks.
- Prefer static checks for safe validation, for example `node --check <file>`.
- Keep secrets out of Git. Never commit `.env`, wallet keys, Telegram tokens, cookies, HAR files, logs, screenshots, or runtime state.
- Do not reintroduce browser/Chrome requirements into the default flow. Browser automation is optional only.
- Do not use `install.sh` for NAS/Docker guidance unless the user explicitly asks for it.
- If documenting NAS/Docker deployment, prefer `yarn start` for the Telegram control bot and `yarn install --production=true --ignore-optional` when Chrome is unavailable.
- Use `KINTARA_SHARD` for server selection. Do not hardcode `s2` in new process-launching code.

## Important scripts

| Command | Purpose |
|---|---|
| `npm start` / `yarn start` | Starts Telegram control bot (`tools/telegram-bot.js`). |
| `npm run fish` / `yarn fish` | Starts fishing + cooking bot. |
| `npm run gather` / `yarn gather` | Starts wood gathering bot. |
| `npm run mine` / `yarn mine` | Starts stone/coal mining bot. |
| `npm run quest` / `yarn quest` | Starts daily quest claimer. |
| `npm run auto` / `yarn auto` | Starts orchestrator that chooses activity automatically. |

There is no `dev` script.

## Security notes

- `WALLET_PRIVATE_KEY` is a high-value secret. Treat it as equivalent to wallet ownership.
- `TELEGRAM_BOT_TOKEN` can control bot access. Treat it as a secret.
- `TELEGRAM_CHAT_ID` is an allowlist boundary. Keep command handling restricted to it.
- One-line remote installers (`bash <(curl ...)`) are risky for wallet software. Prefer explicit clone + inspect + run steps in new docs.

## Runtime state

Runtime files live under `recon/` and are intentionally ignored by Git. They may contain logs, process IDs, bot state, and account-derived telemetry.

## Dependency intent

| Dependency | Why it exists |
|---|---|
| `bs58` | Decode/encode Solana Base58 keys. |
| `tweetnacl` | Create ed25519 keypairs and signatures for wallet login. |
| `ws` | Connect to Kintara queue/presence WebSocket endpoints. |
| `playwright-core` | Optional browser-session helper only; not needed for the default headless protocol flow. |
