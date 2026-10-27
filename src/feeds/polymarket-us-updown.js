// Polymarket US Up/Down capture — the 5-Minute Board's writer.
// Spec: prediction-marketspicks/handoffs/FINAL_MINUTE_LANE_AND_5MIN_HUB_2026-10-27.md §4.6.
//
// Mirrors kalshi-btc15m.js in spirit: research/information capture, nothing prices off it, not a
// required feed (it can never 503 /health).
//
// What it writes:
//   poly_us_updown_book_5s  — top of book (Up/"Yes" side) for the CURRENT 5m window of BTC, ETH,
//                             SOL and XRP every 15 s, every 5 s in the final 90 s (~32 rows a
//                             window, ~37K a day), plus the current 15m window in ITS final 5 min
//                             at the same cadence (the site's "same closing minute" panel, ~12K a
//                             day). 14-day TTL (pg_cron poly-us-updown-book-cull).
//   poly_us_updown_windows  — one permanent ledger row per 5m window, rolled 2 min after the close
//                             (retried each minute until 30 min after) from the closed event's
//                             outcome + published terms and this process's own book samples.
//
// Reads (public gateway, no key):
//   GET /v1/events/slug/<coin>-updown-<h>-<UTC start>z — once per window for the market slug, and
//       again whenever the book 404s (its first ~90–120 s): the event's own bestBid/bestAsk stand
//       in, sizes null.
//   GET /v1/markets/<market slug>/book — the Yes-side book (lib/arb/depth.ts on the site).
//
// ⚠ The gateway keeps 5m events for a rolling ~120 h only (measured 2026-10-27), so the ledger is
// the long-run record: a catch-up sweep on boot and hourly re-reads any of the last 6 h of windows
// missing from it (those rows carry no book prices; source 'backfill').
//
// ⛔ Price to beat / settlement are Polymarket US's PUBLISHED market terms (stored for move_bps and
// audit; the site renders derived values only, decision D1). Nothing here reads or stores an index
// print. POLY_US_UPDOWN_ENABLED=0 switches it off without a redeploy.

import { getClient } from '../delivery/supabase.js';
import { registerFeed, recordTick, setFeedStatus } from '../observability/health.js';

export const FEED = 'poly_us_updown';
const BASE = process.env.POLY_US_GATEWAY_BASE || 'https://gateway.polymarket.us';
const UA = { 'User-Agent': 'PredictionMarketsPicks/1.0', Accept: 'application/json' };
const ENABLED = process.env.POLY_US_UPDOWN_ENABLED !== '0';

export const COINS = ['btc', 'eth', 'sol', 'xrp'];
export const HORIZON_MS = { '5m': 300_000, '15m': 900_000 };
/** 15m windows are only captured in their last 5 minutes (when a 5m window closes with them). */
export const CAPTURE_FROM_TAU_MS = { '5m': 300_000, '15m': 300_000 };
export const FAST_TAU_MS = 90_000;
export const SLOW_EVERY_S = 15;
export const FAST_EVERY_S = 5;
export const ROLL_DELAY_MS = 120_000;
export const ROLL_GIVE_UP_MS = 30 * 60_000;
const MAX_SPREAD = 0.15;

// ── pure helpers (test/feeds.polymarket-us-updown.test.js) ─────────────────────

const pad = (n) => String(n).padStart(2, '0');

/** `btc-updown-5m-2026-10-27-1230z` — the window START in UTC. */
export function eventSlug(coin, horizon, startMs) {
  const d = new Date(startMs);
  return `${coin}-updown-${horizon}-${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}z`;
}

export function windowStart(nowMs, horizon) {
  const len = HORIZON_MS[horizon];
  return Math.floor(nowMs / len) * len;
}

/** Sample on this 5-second boundary? Every 15 s, every 5 s inside the final 90 s; 15m only in its last 5 min. */
export function shouldSample(tauMs, horizon, boundaryMs) {
  if (tauMs <= 0 || tauMs > CAPTURE_FROM_TAU_MS[horizon]) return false;
  const s = Math.round(boundaryMs / 1000);
  if (tauMs <= FAST_TAU_MS) return s % FAST_EVERY_S === 0;
  return s % SLOW_EVERY_S === 0;
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `/book` body → best Yes bid/ask (dollars) and sizes. Levels are re-sorted best-first. */
export function topOfBook(body) {
  const md = body?.marketData;
  if (!md) return null;
  const lv = (arr) => (Array.isArray(arr) ? arr : []).map((l) => ({ px: num(l?.px?.value), qty: num(l?.qty) })).filter((l) => l.px != null && l.px > 0 && l.px < 1);
  const bids = lv(md.bids).sort((a, b) => b.px - a.px);
  const asks = lv(md.offers).sort((a, b) => a.px - b.px);
  return {
    up_bid: bids[0]?.px ?? null,
    up_ask: asks[0]?.px ?? null,
    bid_size: bids[0]?.qty ?? null,
    ask_size: asks[0]?.qty ?? null,
  };
}

/** Event market's own bestBid/bestAsk (the Yes side; the book stand-in while /book 404s). */
export function topFromEventMarket(m) {
  if (!m) return null;
  const bid = num(m.bestBidQuote?.value);
  const ask = num(m.bestAskQuote?.value);
  return { up_bid: bid != null && bid > 0 && bid < 1 ? bid : null, up_ask: ask != null && ask > 0 && ask < 1 ? ask : null, bid_size: null, ask_size: null };
}

/** Up mid in cents (2 dp) from a sample — two-sided, uncrossed, spread ≤ 15¢; else null. */
export function midCents(s) {
  if (!s || s.up_bid == null || s.up_ask == null) return null;
  if (s.up_ask < s.up_bid || s.up_ask - s.up_bid > MAX_SPREAD + 1e-9) return null;
  return Math.round(((s.up_bid + s.up_ask) / 2) * 10000) / 100;
}

/** The four ledger prices from one window's samples ({tau_ms, up_bid, up_ask}, any order). */
export function windowPrices(samples) {
  const s = [...samples].sort((a, b) => b.tau_ms - a.tau_ms); // earliest first
  const lastAtOrBefore = (tau) => {
    let hit = null;
    for (const x of s) if (x.tau_ms >= tau && midCents(x) != null) hit = x;
    return hit ? midCents(hit) : null;
  };
  const firstPriced = s.find((x) => midCents(x) != null);
  const lastPriced = [...s].reverse().find((x) => midCents(x) != null);
  return {
    up_open_c: firstPriced ? midCents(firstPriced) : null,
    up_t60_c: lastAtOrBefore(60_000),
    up_t30_c: lastAtOrBefore(30_000),
    up_final_c: lastPriced ? midCents(lastPriced) : null,
    observations: s.length,
  };
}

const parseArr = (v) => {
  if (Array.isArray(v)) return v;
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
};

/** 'up' | 'down' from a resolved market (by the long side's name, never array order), else null. Mirror of the site's lib/five-min/ledger.ts. */
export function resolvedResult(m) {
  const outcomes = parseArr(m?.outcomes)?.map(String);
  const prices = parseArr(m?.outcomePrices)?.map(num);
  if (!outcomes || !prices || outcomes.length !== 2 || prices.length !== 2) return null;
  const longName = m.marketSides?.find((x) => x.long === true)?.description ?? 'Yes';
  const i = outcomes.indexOf(longName);
  if (i < 0) return null;
  if (prices[i] === 1 && prices[1 - i] === 0) return 'up';
  if (prices[i] === 0 && prices[1 - i] === 1) return 'down';
  return null;
}

/** A closed event body (+ this process's samples, may be empty) → a ledger row, or null while unresolved. */
export function ledgerRow(body, coin, horizon, samples = []) {
  const ev = body?.event;
  const m = ev?.markets?.[0];
  const t = m?.assetPriceTerms;
  if (!ev?.slug || !m?.slug || !t?.windowStart || !t?.windowEnd) return null;
  if (t.horizon && t.horizon !== horizon) return null;
  if (!(ev.closed || m.closed)) return null;
  const result = resolvedResult(m);
  if (!result) return null;
  const ptb = num(t.priceToBeat?.value);
  const sp = num(t.settlementPrice?.value);
  if (ptb != null && sp != null && (sp >= ptb ? 'up' : 'down') !== result) return null;
  const move = ptb != null && sp != null && ptb > 0 ? Math.round(((sp - ptb) / ptb) * 1e4 * 1000) / 1000 : null;
  const prices = samples.length ? windowPrices(samples) : { up_open_c: null, up_t60_c: null, up_t30_c: null, up_final_c: null, observations: 0 };
  return {
    coin,
    horizon,
    window_start: new Date(Date.parse(t.windowStart)).toISOString(),
    window_end: new Date(Date.parse(t.windowEnd)).toISOString(),
    event_slug: ev.slug,
    market_slug: m.slug,
    result,
    price_to_beat: ptb,
    settlement_price: sp,
    move_bps: move,
    ...prices,
    source: samples.length ? 'worker' : 'backfill',
    captured_at: new Date().toISOString(),
  };
}

// ── gateway ───────────────────────────────────────────────────────────────────

async function getJson(path, timeoutMs = 4_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { headers: UA, signal: ctrl.signal });
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) return { status: res.status, body: null };
    return { status: 200, body: await res.json() };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

// ── state ─────────────────────────────────────────────────────────────────────

const state = {
  started: false,
  timer: null,
  sweepTimer: null,
  rowsWritten: 0,
  windowsRolled: 0,
  sweepRows: 0,
  lastSampleAt: null,
  lastRollAt: null,
  lastError: null,
  lastErrorAt: null,
};
/** `${coin}|${horizon}|${startMs}` → { marketSlug, samples: [] } */
const windows = new Map();
/** `${coin}|${startMs}` → first roll attempt due (ms) for 5m windows awaiting the ledger. */
const pendingRolls = new Map();
let buffer = [];

function noteError(where, err) {
  state.lastError = `${where}: ${err?.message ?? err}`;
  state.lastErrorAt = new Date().toISOString();
  setFeedStatus(FEED, { lastError: state.lastError, lastErrorAt: state.lastErrorAt });
}

async function marketSlugFor(coin, horizon, startMs) {
  const key = `${coin}|${horizon}|${startMs}`;
  let w = windows.get(key);
  if (!w) {
    w = { marketSlug: null, samples: [] };
    windows.set(key, w);
    if (horizon === '5m') pendingRolls.set(`${coin}|${startMs}`, startMs + HORIZON_MS['5m'] + ROLL_DELAY_MS);
  }
  return w;
}

async function sampleOne(coin, horizon, boundaryMs) {
  const startMs = windowStart(boundaryMs, horizon);
  const endMs = startMs + HORIZON_MS[horizon];
  const tauMs = endMs - boundaryMs;
  if (!shouldSample(tauMs, horizon, boundaryMs)) return;
  const w = await marketSlugFor(coin, horizon, startMs);
  let eventMarket = null;
  if (!w.marketSlug) {
    const ev = await getJson(`/v1/events/slug/${eventSlug(coin, horizon, startMs)}`);
    eventMarket = ev.body?.event?.markets?.[0] ?? null;
    if (!eventMarket?.slug) return;
    w.marketSlug = eventMarket.slug;
  }
  const book = await getJson(`/v1/markets/${encodeURIComponent(w.marketSlug)}/book`);
  let top = book.status === 200 ? topOfBook(book.body) : null;
  if (!top && book.status === 404) {
    if (!eventMarket) {
      const ev = await getJson(`/v1/events/slug/${eventSlug(coin, horizon, startMs)}`);
      eventMarket = ev.body?.event?.markets?.[0] ?? null;
    }
    top = topFromEventMarket(eventMarket);
  }
  if (!top) return;
  const row = {
    coin,
    horizon,
    market_slug: w.marketSlug,
    observed_at: new Date(boundaryMs).toISOString(),
    tau_ms: tauMs,
    ...top,
  };
  w.samples.push({ tau_ms: tauMs, up_bid: top.up_bid, up_ask: top.up_ask });
  buffer.push(row);
}

async function flush() {
  if (!buffer.length) return;
  const rows = buffer;
  buffer = [];
  const { error } = await getClient().from('poly_us_updown_book_5s').upsert(rows, { onConflict: 'market_slug,observed_at', ignoreDuplicates: true });
  if (error) {
    noteError('book insert', error);
    return;
  }
  state.rowsWritten += rows.length;
}

async function rollDue(nowMs) {
  for (const [key, dueMs] of pendingRolls) {
    if (nowMs < dueMs) continue;
    const [coin, startStr] = key.split('|');
    const startMs = Number(startStr);
    if (nowMs > startMs + HORIZON_MS['5m'] + ROLL_GIVE_UP_MS) {
      pendingRolls.delete(key);
      windows.delete(`${coin}|5m|${startMs}`);
      continue;
    }
    const ev = await getJson(`/v1/events/slug/${eventSlug(coin, '5m', startMs)}`);
    const w = windows.get(`${coin}|5m|${startMs}`);
    const row = ev.body ? ledgerRow(ev.body, coin, '5m', w?.samples ?? []) : null;
    if (!row) {
      pendingRolls.set(key, nowMs + 60_000); // not resolved yet — retry in a minute
      continue;
    }
    const { error } = await getClient().from('poly_us_updown_windows').upsert(row, { onConflict: 'coin,horizon,window_start' });
    if (error) {
      noteError('ledger upsert', error);
      pendingRolls.set(key, nowMs + 60_000);
      continue;
    }
    pendingRolls.delete(key);
    windows.delete(`${coin}|5m|${startMs}`);
    state.windowsRolled += 1;
    state.lastRollAt = new Date().toISOString();
  }
  // 15m windows carry no ledger here — drop their samples once closed.
  for (const key of windows.keys()) {
    const [, horizon, startStr] = key.split('|');
    if (horizon === '15m' && Number(startStr) + HORIZON_MS['15m'] < nowMs) windows.delete(key);
  }
}

/** Re-read any of the last `hours` of 5m windows missing from the ledger (the gateway forgets them after ~120 h). */
export async function sweepMissing({ hours = 6, nowMs = Date.now() } = {}) {
  const since = new Date(nowMs - hours * 3_600_000).toISOString();
  const { data, error } = await getClient()
    .from('poly_us_updown_windows')
    .select('coin, window_start')
    .eq('horizon', '5m')
    .gte('window_start', since)
    .order('window_start', { ascending: true })
    .limit(1000); // 6 h × 12 × 4 coins = 288 rows max — inside one page
  if (error) {
    noteError('sweep read', error);
    return 0;
  }
  const have = new Set((data ?? []).map((r) => `${r.coin}|${Date.parse(r.window_start)}`));
  const newest = windowStart(nowMs, '5m') - 2 * HORIZON_MS['5m']; // closed ≥ 5 min ago
  let wrote = 0;
  for (const coin of COINS) {
    for (let s = newest; s >= nowMs - hours * 3_600_000; s -= HORIZON_MS['5m']) {
      if (have.has(`${coin}|${s}`) || pendingRolls.has(`${coin}|${s}`)) continue;
      const ev = await getJson(`/v1/events/slug/${eventSlug(coin, '5m', s)}`);
      const row = ev.body ? ledgerRow(ev.body, coin, '5m', []) : null;
      if (!row) continue;
      const { error: e2 } = await getClient().from('poly_us_updown_windows').upsert(row, { onConflict: 'coin,horizon,window_start', ignoreDuplicates: true });
      if (e2) noteError('sweep upsert', e2);
      else wrote += 1;
      await new Promise((r) => setTimeout(r, 200)); // ≤ 5 req/s
    }
  }
  state.sweepRows += wrote;
  return wrote;
}

async function tick() {
  const boundaryMs = Math.round(Date.now() / 5000) * 5000;
  try {
    await Promise.all(COINS.flatMap((c) => ['5m', '15m'].map((h) => sampleOne(c, h, boundaryMs).catch((e) => noteError(`sample ${c} ${h}`, e)))));
    if (buffer.length) state.lastSampleAt = new Date(boundaryMs).toISOString();
    await flush();
    await rollDue(Date.now());
    recordTick(FEED);
    setFeedStatus(FEED, { rowsWritten: state.rowsWritten, windowsRolled: state.windowsRolled, sweepRows: state.sweepRows, lastSampleAt: state.lastSampleAt, lastRollAt: state.lastRollAt });
  } catch (e) {
    noteError('tick', e);
  }
}

function schedule() {
  const now = Date.now();
  const next = Math.ceil((now + 1) / 5000) * 5000;
  state.timer = setTimeout(async () => {
    await tick();
    schedule();
  }, next - now);
}

export function startPolymarketUsUpdown() {
  registerFeed(FEED);
  if (!ENABLED) {
    setFeedStatus(FEED, { enabled: false });
    console.log('[poly-us-updown] disabled (POLY_US_UPDOWN_ENABLED=0)');
    return;
  }
  if (state.started) return;
  state.started = true;
  setFeedStatus(FEED, { enabled: true });
  schedule();
  const sweep = () => sweepMissing().then((n) => n && console.log(`[poly-us-updown] sweep wrote ${n} missing windows`)).catch((e) => noteError('sweep', e));
  setTimeout(sweep, 30_000);
  state.sweepTimer = setInterval(sweep, 60 * 60_000);
  console.log('[poly-us-updown] started: 5m book 15 s / 5 s final 90 s, 15m final 5 min, ledger roll T+2 min');
}

export function stopPolymarketUsUpdown() {
  clearTimeout(state.timer);
  clearInterval(state.sweepTimer);
  state.started = false;
}

export function getPolymarketUsUpdownHealth() {
  return { enabled: ENABLED, ...state, timer: undefined, sweepTimer: undefined, openWindows: windows.size, pendingRolls: pendingRolls.size, buffered: buffer.length };
}
