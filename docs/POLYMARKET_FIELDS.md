# Polymarket CLOB WS — Observed Field Shapes

Last verified: 2026-05-02 (Phase 2B + Phase 2B hot-fix). Captured against live
production traffic via `scripts/poly-probe.mjs`.

Polymarket has historically renamed schema fields without notice (build plan §10).
The Polymarket feed (`src/feeds/polymarket.js`) logs the first 5 raw frames per
connection. Re-confirm against a fresh `/health` log after every reconnect that
shows new event types — update this doc, then update the feed's `applyMessage`
parser to match.

## Endpoint

```
wss://ws-subscriptions-clob.polymarket.com/ws/market
```

Public, no auth. Subscribe by sending exactly one frame after `open`:

```json
{"type": "market", "assets_ids": ["<token_id_1>", "<token_id_2>", ...]}
```

`assets_ids` are Polymarket CLOB token IDs (the long decimal strings from the
gamma-api `clobTokenIds` array). The first element of each `clobTokenIds` array
is the YES token; the second is NO. The arb comparator subscribes only to YES
tokens — NO price = `1 - YES`.

## Resolving condition_id → asset_id

The CLOB WS does NOT subscribe by `condition_id`. Each binary outcome has two
asset_ids (YES, NO). To resolve a condition_id, fetch the gamma-api event:

```
GET https://gamma-api.polymarket.com/events?slug=<event-slug>
```

Each `markets[]` entry returns:
- `conditionId` — the on-chain condition identifier (used in arb_alerts.market_b for human readability)
- `clobTokenIds` — JSON-encoded array `["<YES>", "<NO>"]`
- `outcomes` — `["Yes", "No"]` mapping order to clobTokenIds

The arb mapping registry stores both `conditionId` (for the arb_alerts row) and
`yesTokenId` (for the WS subscription) per pair.

## Message shapes

Polymarket sometimes batches multiple events into one frame as a JSON array.
Single-message frames are one object. Both are handled in `applyMessage`.

### `book` — full L2 snapshot (sent on subscribe)

On first subscribe, all books arrive in a **single array frame** — the message
handler iterates the array and dispatches per item. Each book has a top-level
`asset_id`.

```json
{
  "event_type": "book",
  "asset_id": "30767812841387255642...",
  "market": "0xde04...",
  "bids":  [{"price": "0.94", "size": "120.0"}, {"price": "0.93", "size": "80.0"}],
  "asks":  [{"price": "0.96", "size": "200.0"}, {"price": "0.97", "size": "150.0"}],
  "tick_size": "0.01",
  "last_trade_price": "0.945",
  "timestamp": "1777756325449",
  "hash": "..."
}
```

We compute mid as `(best_bid + best_ask) / 2`. If only one side exists, mid
falls back to that side.

### `price_change` — order-level diff (LIVE shape, locked 2026-05-02)

**Critical drift from earlier docs**: Polymarket uses `price_changes` (plural),
NOT `changes`. There is **NO top-level `asset_id`** — each entry inside the
`price_changes[]` array has its own. YES + NO of the same condition typically
arrive in one frame (one `BUY`, one `SELL`).

```json
{
  "event_type": "price_change",
  "market": "0xde04...",
  "price_changes": [
    {
      "asset_id": "30767812841387255642...",   // YES token
      "price": "0.94",
      "size": "125994.25",
      "side": "BUY",
      "hash": "...",
      "best_bid": "0.95",
      "best_ask": "0.96"
    },
    {
      "asset_id": "40302938956091099752...",   // NO token (mirror)
      "price": "0.06",
      "size": "125994.25",
      "side": "SELL",
      "hash": "...",
      "best_bid": "0.04",
      "best_ask": "0.05"
    }
  ],
  "timestamp": "1777756330593"
}
```

`best_bid` / `best_ask` per change are the authoritative top-of-book values —
the feed parser reads those directly rather than walking levels. `size: "0"`
indicates a cancel at the named `price` level; `best_bid`/`best_ask` still
reflect the post-cancel top correctly, so the engine doesn't need cancel-aware
bookkeeping.

### `last_trade_price` — print

```json
{
  "event_type": "last_trade_price",
  "asset_id": "30767812841387255642...",
  "market": "0xde04...",
  "price": "0.945",
  "side": "BUY",
  "size": "50.0",
  "fee_rate_bps": "0",
  "timestamp": "1746201250000"
}
```

Used as a mid fallback when no two-sided book is available — common for very
quiet markets where one side has zero depth.

### `tick_size_change` — server-side tick size adjustment

Logged at shape-debug level but not acted on. Tick size doesn't affect the mid
computation in v1.

## Reconnect behavior

- Exponential backoff: 500ms → 30s with ±250ms jitter (matches the Kalshi feed).
- Server closes idle connections after ~30s. The feed sends WS pings every 25s.
- On reconnect, `rawShapeLogged` resets so the next 5 frames are logged again —
  useful when the schema drifts during a deploy gap.
