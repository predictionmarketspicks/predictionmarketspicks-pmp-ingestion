// Pyth price feeds, read directly from Pythnet instead of the Hermes HTTP API.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// Pyth's Core upgrade (2026-08-26 16:00 UTC) put Hermes behind an API key at
// $500/month. Our four Pyth feeds 401'd at 16:16:05 UTC that day.
//
// Hermes is a hosted convenience layer. The actual data lives on **Pythnet**,
// Pyth's own appchain, where every publisher posts continuously — it is what
// Hermes itself reads. Pythnet's RPC is public, so the same numbers are free at
// the source. This is NOT a substitute feed or a proxy: Kalshi settles
// KXSILVERW and KXGOLDW on Pyth XAG/USD and XAU/USD specifically, and this reads
// exactly those price accounts.
//
// ⛔ NEVER READ THESE ACCOUNTS FROM SOLANA MAINNET-BETA.
// The same addresses exist there and parse perfectly — same magic, same version,
// same layout — carrying a price that has not been updated in over 700 days.
// Measured 2026-08-27: mainnet-beta returns XAU/USD $2,423.48 and XAG/USD
// $27.5370 against a live $4,601.16 / $69.2533. A 47% error that looks
// completely structurally valid. That trap is the reason for the age gate below:
// a well-formed Pyth account is not the same thing as a fresh one.
//
// ── ACCOUNT LAYOUT (Pyth V2 price account) ───────────────────────────────────
//   0   magic u32 = 0xa1b2c3d4      20  exponent i32
//   4   version u32 = 2             96  timestamp i64 (seconds)
//   8   account type u32 = 3       184  prev_price i64
//                                  192  prev_conf u64
//                                  200  prev_timestamp i64
//                                  208  agg.price i64
//                                  216  agg.conf u64
//                                  224  agg.status u32   (1 = Trading)
//                                  232  agg.pub_slot u64
// The magic/version/type triple IS the version guard — if Pyth ever changes the
// layout these stop matching and we throw rather than decoding nonsense.

// api2 403'd on getAccountInfo when this file shipped (2026-08-27) but was
// re-probed 2026-08-31 and now serves it (slot-current, same account bytes as
// rpcpool). Second in the list: rpcpool stays primary, api2 is the failover
// the loop below walks to. mainnet-beta must NEVER be added — stale-copy trap.
const DEFAULT_RPCS = ['https://pythnet.rpcpool.com', 'https://api2.pythnet.pyth.network']

/** Comma-separated override so endpoints can be swapped without a deploy.
 *  Setting PYTHNET_RPC_URLS REPLACES the default list entirely. */
const RPCS = (process.env.PYTHNET_RPC_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const PYTHNET_RPCS = RPCS.length > 0 ? RPCS : DEFAULT_RPCS

const PYTH_MAGIC = 0xa1b2c3d4
const PYTH_VERSION = 2
const PYTH_ACCOUNT_TYPE_PRICE = 3
const STATUS_TRADING = 1

/**
 * Absurdity gate, NOT a freshness policy. 24h is deliberately loose: metals stop
 * trading over the weekend and the last traded price is legitimately old, and
 * deciding whether a given snapshot may use a given spot is the ENGINE's job
 * (config.maxSpotAgeMs, applied per snapshot in commodity-base.js). This exists
 * solely to reject an abandoned account — the mainnet-beta copy is 728 days
 * stale, so anything in that class fails here by three orders of magnitude.
 */
const MAX_ONCHAIN_AGE_MS = 24 * 60 * 60 * 1000

/** Metals stop printing Friday ~21:00-22:00 UTC and resume Sunday ~22:00-23:00
 *  UTC, so by late Sunday the last legitimate on-chain print is ~49h old and
 *  the 24h gate above made every Saturday a standing false alarm. Widen to 72h
 *  for the metals pair on Sat/Sun (UTC) ONLY — day-of-week is the cheapest
 *  signal the code can know without a Kalshi call. The mainnet-beta abandoned
 *  copy is 700+ DAYS stale, so it still fails the widened gate by orders of
 *  magnitude. */
const WEEKEND_MAX_ONCHAIN_AGE_MS = 72 * 60 * 60 * 1000
const WEEKEND_WIDENED_SYMBOLS = new Set(['XAU/USD', 'XAG/USD'])

export function maxOnchainAgeMs(symbol, now = new Date()) {
  if (!WEEKEND_WIDENED_SYMBOLS.has(symbol)) return MAX_ONCHAIN_AGE_MS
  const day = now.getUTCDay()
  return day === 0 || day === 6 ? WEEKEND_MAX_ONCHAIN_AGE_MS : MAX_ONCHAIN_AGE_MS
}

const RPC_TIMEOUT_MS = 8000

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Pyth feed IDs are the price-account pubkey in hex; Solana RPC wants base58. */
export function feedIdToAccount(feedIdHex) {
  const hex = String(feedIdHex).replace(/^0x/, '')
  const bytes = Buffer.from(hex, 'hex')
  if (bytes.length !== 32) throw new Error(`feed id is not 32 bytes: ${feedIdHex}`)
  let n = BigInt('0x' + hex)
  let out = ''
  while (n > 0n) {
    const r = Number(n % 58n)
    n /= 58n
    out = B58[r] + out
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}

/** Decode a Pyth V2 price account. Throws on anything that is not one. */
export function parsePriceAccount(raw) {
  if (raw.length < 240) throw new Error(`price account too short (${raw.length}B)`)
  const magic = raw.readUInt32LE(0)
  const version = raw.readUInt32LE(4)
  const accountType = raw.readUInt32LE(8)
  if (magic !== PYTH_MAGIC) throw new Error(`bad magic 0x${magic.toString(16)}`)
  if (version !== PYTH_VERSION) throw new Error(`unsupported price-account version ${version}`)
  if (accountType !== PYTH_ACCOUNT_TYPE_PRICE) throw new Error(`account type ${accountType}, want price`)

  const expo = raw.readInt32LE(20)
  const scale = 10 ** expo
  const status = raw.readUInt32LE(224)
  const trading = status === STATUS_TRADING

  // When the aggregate is not Trading (metals daily break 17:00-18:00 ET,
  // weekends, halts), `prev_*` holds the last aggregate that WAS trading. Using
  // agg there would report a price with a status that says not to trust it.
  const price = trading ? Number(raw.readBigInt64LE(208)) : Number(raw.readBigInt64LE(184))
  const conf = trading ? Number(raw.readBigUInt64LE(216)) : Number(raw.readBigUInt64LE(192))
  const tsSec = trading ? Number(raw.readBigInt64LE(96)) : Number(raw.readBigInt64LE(200))

  if (!Number.isFinite(price) || price <= 0) throw new Error('non-positive price')
  return {
    price: price * scale,
    confidence: conf * scale,
    publishTimeMs: tsSec * 1000,
    status,
    trading,
    expo,
  }
}

async function rpcGetAccount(rpc, account) {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'pmp-ingestion/0.1' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [account, { encoding: 'base64' }],
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`rpc ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(`rpc error ${JSON.stringify(body.error).slice(0, 120)}`)
  const value = body?.result?.value
  if (!value?.data?.[0]) throw new Error('account not found')
  return Buffer.from(value.data[0], 'base64')
}

/**
 * Read one Pyth feed off Pythnet. Same return shape as the old Hermes
 * `fetchOnce`, so callers are unchanged.
 */
export async function fetchPythnetPrice(symbol, feedId) {
  const account = feedIdToAccount(feedId)
  const errors = []
  for (const rpc of PYTHNET_RPCS) {
    try {
      const parsed = parsePriceAccount(await rpcGetAccount(rpc, account))
      const ageMs = Date.now() - parsed.publishTimeMs
      if (ageMs > maxOnchainAgeMs(symbol)) {
        // An abandoned or wrong account, not a quiet market. Try the next RPC
        // rather than publishing it — this is the mainnet-beta trap.
        throw new Error(
          `on-chain price is ${Math.round(ageMs / 86400000)}d old — refusing (abandoned account?)`,
        )
      }
      return {
        symbol,
        price: parsed.price,
        confidence: parsed.confidence,
        publishTimeMs: parsed.publishTimeMs,
        feedId,
        trading: parsed.trading,
        source: 'pythnet',
      }
    } catch (err) {
      errors.push(`${rpc.replace(/^https:\/\//, '')}: ${err?.message || err}`)
    }
  }
  throw new Error(`pythnet ${symbol} — ${errors.join('; ')}`)
}

export const PYTHNET_RPC_LIST = PYTHNET_RPCS
