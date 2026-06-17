# Product Context

Kintara Bot is a headless automation controller for Kintara.gg. Its main value is allowing an operator to run game automation tasks from Telegram without opening a browser.

## Product goal

Enable a single account operator to control repeatable Kintara activities from Telegram:

- Fishing and cooking.
- Wood gathering.
- Stone/coal mining.
- Daily quest checks and claims.
- Basic inventory/status reporting.
- Automatic activity selection through an orchestrator.

## Non-goals

| Area | Status |
|---|---|
| Browser rendering | Not required for the default flow. |
| Chrome installation | Not required for NAS/Docker headless operation. |
| Combat automation | Pending; wilderness mobs are client-simulated and outside the stable headless flow. |
| Multi-account scaling | Out of scope. Current behavior assumes one account. |
| Public SaaS operation | Out of scope. This is designed for a controlled personal/server environment. |

## Users

The primary user is an operator who controls the bot through Telegram. The operator owns the wallet, Telegram bot token, and server/NAS environment.

## Core flows

### Telegram control

1. Operator starts `tools/telegram-bot.js` with `yarn start` or `npm start`.
2. Telegram bot receives commands from the configured `TELEGRAM_CHAT_ID`.
3. Commands spawn or stop activity processes.
4. Status and quest commands read local runtime state and Kintara API state.
5. `/claim` manually claims every completed daily quest that is not claimed yet.

### Wallet login

1. Bot reads `WALLET_PRIVATE_KEY` from environment or `.env`.
2. Bot requests `/api/auth/challenge` from Kintara.
3. Bot signs the challenge with ed25519.
4. Bot verifies the signature through `/api/auth/verify`.
5. Kintara returns a `kintara_session` cookie used for REST and WebSocket calls.

### Activity execution

1. Activity process logs in and connects to queue/presence WebSockets.
2. Bot sends position/action messages that match the Kintara protocol.
3. Bot calls REST endpoints for grants, inventory, quests, marketplace, or state reads.
4. Bot writes runtime state to `recon/` for Telegram status output.

### Auto orchestration

1. `/auto` starts `tools/orchestrator.js`.
2. The orchestrator claims any completed daily quests first.
3. Pending fishing daily quests take priority.
4. Pending gather/mining daily quests come next.
5. If no actionable daily quest is pending, the existing skills/materials logic decides between gathering and fishing.

## Required configuration

| Variable | Required | Purpose |
|---|---:|---|
| `WALLET_PRIVATE_KEY` | Yes | Solana Base58 key used to sign Kintara login challenge. |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram BotFather token. |
| `TELEGRAM_CHAT_ID` | Recommended | Restricts command handling to one chat. |
| `KINTARA_SHARD` | Optional | Game shard/server used for queue and presence WebSockets. Defaults to `s2`. |
| `KINTARA_API_BASE` | Optional | Defaults to `https://kintara.gg`. |
| `KINTARA_FANOUT_BASE` | Optional | Defaults to `https://ktra-server-b.onrender.com`. |

## Product risks

| Risk | Impact | Mitigation |
|---|---|---|
| Raw wallet private key handling | A leaked key can compromise the wallet. | Keep secrets out of Git, use private env files, restrict backups/logs. |
| Telegram token leakage | Attackers can send bot API requests. | Keep token secret and restrict commands by `TELEGRAM_CHAT_ID`. |
| Game Terms of Service | Automation may violate game rules. | Use at own risk; keep disclaimer visible. |
| Remote install patterns | `bash <(curl ...)` is unsafe for wallet workflows. | Prefer clone/inspect/run or controlled Docker deployment. |
| Dependency/repo updates at startup | Supply-chain changes can run on next restart. | Pin dependencies and update intentionally. |

## Success criteria

- Operator can start the Telegram controller without Chrome.
- Operator can trigger one activity at a time.
- `/auto` prioritizes daily quest completion before normal farming goals.
- Runtime state is visible through Telegram status commands.
- Secrets are not committed to the repository.
