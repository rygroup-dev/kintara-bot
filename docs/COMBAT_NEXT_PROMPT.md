# Follow-up Prompt — Combat Seed Replication

Continue the `kintara-bot` project from this repository. Focus: build and validate a headless Wilderness combat bot for combat XP, mount drops, and daily zombie quests.

## Confirmed headless pieces

- Auth: `lib/walletAuth.js` signs the wallet challenge and returns the `kintara_session` cookie.
- Presence WS: `lib/presenceWs.js` connects through queue `wss://kintara.gg/ws/queue/<shard>` and presence `wss://kintara.gg/ws/presence/<shard>`.
- Position messages use `{t:'pos', region, x, y:0.25, z, ry, mov, act, ...}`.
- Mainland coordinates use `x=col-30.5`, `z=row-30.5`.
- Realm transitions work by walking to the portal and sending `setRegion`, then waiting for `region_ack`.
- Gathering and banking are already proven headless paths:
  - `Presence.harvestNode(...)`
  - `lib/bank.depositAll(...)`
- Telegram already controls fishing, gathering, mining, auto, stop, status, skills, balance, quest, claim, spinner, and combat.

## Current combat direction

Wilderness mobs are handled through the presence hub. The bot should:

1. Login and connect presence.
2. Bank loot before entering Wilderness.
3. Enter Wilderness through the north portal.
4. Send a blocked-tile manifest with `sendWildManifest([])` to trigger/refresh mob hosting.
5. Read server-authoritative mobs from `snap.npcs.wildMobs`.
6. Walk adjacent to the nearest live zombie.
7. Send `wm_ev` hit messages with the current life epoch.
8. Monitor HP and retreat before death.

## Combat protocol notes

- Hit mob:
  ```js
  { t: 'wm_ev', region: 'wild', a: 'hit', i: mobIndex, le: lifeEpoch, n: hitMult, px, pz }
  ```
- `wild_sword` must be equipped/broadcast via `eq` in presence position messages.
- Kill attribution and daily quest progress are server-side through `wm_ev`/skill XP pushes.
- HP/shield can arrive through `wild_mb_ack`, `pvit`, or `snap.players[]` self entries.

## Safety rules

- Always bank before entering Wilderness.
- Abort before combat if no health potions are available.
- Abort before combat if `wild_sword` is missing from inventory/hotbar.
- Retreat to safe camp or Mainland when HP is critical or health potions are exhausted.
- Keep one active worker per account: fishing, gathering, auto, spinner, and combat should not overlap.

## Validation notes

- First live combat run must be supervised by the user.
- Queue can take several minutes and the server can return intermittent 502s.
- Do not run live combat from an automated review unless explicitly requested.
