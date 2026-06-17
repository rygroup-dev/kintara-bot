# Core Loop TODO

## Confirmed API areas

- Auth and player state (`/api/auth/me`, player stats)
- Backpack/inventory save flow
- Marketplace listing reads, stats, token quote/buy, sell/cancel helpers
- Daily quest progress and claim
- Casino spinner endpoints
- World tribute and merchant campaign
- Bank unlock-page endpoint
- Friends and DM endpoints
- Token and server info endpoints

## Confirmed headless realtime areas

- Wallet auth through `lib/walletAuth.js`
- Queue and presence WebSocket through `lib/presenceWs.js`
- Movement through presence position messages
- Fishing/cooking loop through `tools/bot-headless.js`
- Gathering/mining through `tools/gather-bot.js`
- Banking selected tradeable loot through `lib/bank.js`
- Daily quest orchestration through `tools/orchestrator.js`
- Telegram control through `tools/telegram-bot.js`

## Still useful to capture with HAR or live protocol review

### 1. Combat edge cases

Capture a supervised attack against one Wilderness mob and verify:

- exact `wm_ev` payload fields used by the official client,
- HP/shield update message order,
- kill attribution fields,
- daily quest increment behavior,
- whether loot bags or drops need an additional REST call.

### 2. Marketplace create listing edge cases

Capture creating and canceling one small listing to confirm:

- request body shape,
- slot kind/index semantics,
- reserve/release behavior,
- failure responses for stale inventory state.

### 3. Bank deposit/withdraw details

Capture manual deposit/withdraw for non-resource slot items to confirm:

- slot move payload shape,
- pagination behavior,
- failure mode when bank pages are full.

### 4. Spinner inventory constraints

Capture a free spinner with a nearly full inventory/cosmetic bag to confirm:

- exact server error codes,
- whether resources require a free normal slot,
- whether Red Aura requires a free cosmetic slot only.

## HAR analysis helper

When a HAR is available, run:

```bash
node tools/har-analyze.js path/to/capture.har
node tools/har-analyze.js path/to/capture.har --full
```

The helper reads local files only, redacts cookies/tokens, and highlights Kintara requests and WebSocket candidates.

## Safety baseline

- Keep all write/push operations based on a fresh `/api/auth/me` state sequence.
- Preserve full backpack structures when saving inventory.
- Keep one worker per account to avoid overwriting state.
- Prefer static review first; only run live game actions when explicitly requested.
