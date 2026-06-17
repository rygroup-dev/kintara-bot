# Architecture

Kintara Bot is a Node.js CommonJS application. The default runtime is fully headless: it uses REST, wallet signatures, and WebSockets instead of browser automation.

## High-level design

```text
Telegram operator
      |
      v
 tools/telegram-bot.js
      |
      +--> tools/bot-headless.js      # fishing + cooking
      +--> tools/gather-bot.js        # wood/stone/coal gathering
      +--> tools/orchestrator.js      # chooses one activity
      +--> tools/daily-quest.js       # claims completed quests

Activity process
      |
      +--> lib/walletAuth.js          # Solana challenge signing
      +--> lib/kintaraClient.js       # REST API wrapper
      +--> lib/presenceWs.js          # queue/presence WebSocket client
      +--> recon/*.json, *.log        # runtime state for status/debugging
```

## Runtime boundaries

| Boundary | Module | Responsibility |
|---|---|---|
| Configuration | `config.js` | Loads `.env`, exposes typed config, persists discovered values like `TELEGRAM_CHAT_ID`. |
| Wallet auth | `lib/walletAuth.js` | Converts Base58 key to ed25519 keypair, signs challenge, obtains session cookie. |
| REST client | `lib/kintaraClient.js` | Wraps Kintara REST/fanout endpoints with session cookie and JSON handling. |
| WebSocket presence | `lib/presenceWs.js` | Handles queue, presence, movement, region updates, fishing/gather actions. |
| Telegram control | `lib/telegram.js` + `tools/telegram-bot.js` | Polls Telegram, restricts commands to configured chat, starts/stops worker processes. |
| Game state mutation | `lib/gameState.js` | Builds complete backpack payloads to avoid partial inventory wipes. |
| Banking | `lib/bank.js` | Moves inventory resources into bank slots through save-backpack. |
| Error tracking | `lib/errorbus.js` | Stores repeated error signatures in `errors.json`. |
| Optional browser helper | `lib/browserSession.js` | Playwright helper for real browser sessions; not part of the default NAS/headless path. |

## Process model

The Telegram bot is the control plane. It starts activity scripts as detached child processes and stores PID files under `recon/control/`.

| Process | Entry point | Notes |
|---|---|---|
| Control bot | `tools/telegram-bot.js` | Long-polls Telegram and handles `/fish`, `/gather`, `/mine`, `/auto`, `/stop`, `/status`, `/skills`, `/balance`, `/quest`. |
| Fishing bot | `tools/bot-headless.js` | Connects to Kintara presence, walks to pond, fishes, cooks, optionally sells excess fish. |
| Gathering bot | `tools/gather-bot.js` | Learns resource nodes from WebSocket events, walks to nodes, harvests, persists loot. |
| Orchestrator | `tools/orchestrator.js` | Chooses fishing or gathering based on quests, inventory, and skill levels. |
| Daily quest bot | `tools/daily-quest.js` | Polls daily quest progress and claims completed quests. |

## Data flow

### Authentication

```text
.env / process.env
  -> config.js
  -> lib/walletAuth.js
  -> GET /api/auth/challenge
  -> ed25519 signature
  -> POST /api/auth/verify
  -> kintara_session cookie
```

### Activity loop

```text
session cookie
  -> queue WebSocket for KINTARA_SHARD
  -> presence WebSocket for KINTARA_SHARD
  -> position/action messages
  -> REST grants or state reads
  -> recon/* runtime state
  -> Telegram /status output
```

## Dependencies

| Package | Runtime role |
|---|---|
| `bs58` | Decodes Solana Base58 private keys and encodes public keys. |
| `tweetnacl` | Creates ed25519 keypairs and signs login challenges. |
| `ws` | WebSocket client for Kintara queue and presence connections. |
| `playwright-core` | Optional browser helper only. It is safe to skip for Docker/NAS protocol mode. |

## Deployment notes

For a NAS/container image with Node 20 and no Chrome:

- Use `yarn start` to run the Telegram controller.
- Use `yarn install --production=true --ignore-optional` to skip `playwright-core`.
- Do not run `yarn dev`; there is no `dev` script.
- Set `KINTARA_SHARD` to select the game server, for example `s2` or `s3`.
- Persist the repository and `recon/` directory on NAS storage if state/logs should survive restarts.
- The app needs outbound network access to Kintara and Telegram.

## Security model

| Secret | Where used | Risk |
|---|---|---|
| `WALLET_PRIVATE_KEY` | `lib/walletAuth.js` | Controls wallet authentication. Leakage is critical. |
| `TELEGRAM_BOT_TOKEN` | `lib/telegram.js` | Allows Telegram Bot API access. |
| `TELEGRAM_CHAT_ID` | `lib/telegram.js` | Command allowlist. Commands from other chats should be ignored. |
| `kintara_session` cookie | Runtime memory/log-adjacent state | Grants authenticated Kintara session access. |

## Safe validation

When the user has not authorized live execution, prefer static validation:

```bash
node --check config.js
for f in lib/*.js tools/*.js; do node --check "$f"; done
```

Do not run scripts that connect to Kintara or Telegram unless explicitly requested.
