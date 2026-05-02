# Polymarket CLOB WS — Observed Field Shapes

Last verified: 2026-05-02 (Phase 2B).

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

### `book` — full L2 snapshot (sent on subscribe and after a bookkeeping reset)

```json
{
  "event_type": "book",
  "asset_id": "30767812841387255642...",
  "market": "0xde04...",
  "buys":  [{"price": "0.94", "size": "120.0"}, {"price": "0.93", "size": "80.0"}],
  "sells": [{"price": "0.96", "size": "200.0"}, {"price": "0.97", "size": "150.0"}],
  "timestamp": "1746201230000",
  "hash": "..."
}
```

Some servers emit `bids`/`asks` instead of `buys`/`sells`. The feed accepts both.
We compute mid as `(best_bid + best_ask) / 2`. If only one side exists, mid
falls back to that side.

### `price_change` — order-level diff

```json
{
  "event_type": "price_change",
  "asset_id": "30767812841387255642...",
  "market": "0xde04...",
  "changes": [
    {"price": "0.95", "side": "BUY",  "size": "300.0"},
    {"price": "0.97", "side": "SELL", "size": "0.0"}
  ],
  "timestamp": "1746201240000"
}
```

The feed updates the best bid/ask in place when a level beats the current best.
A `size: "0"` cancels at that price level — the in-memory map ignores cancels
in v1 (the periodic comparator tolerates one stale tick; the next live print
corrects it). If staleness becomes a problem, swap in an L2 walker.

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
