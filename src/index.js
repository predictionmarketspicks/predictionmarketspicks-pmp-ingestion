import 'dotenv/config';
import http from 'node:http';

import { initSentry, Sentry } from './observability/sentry.js';
import {
  snapshot,
  registerFeed,
  markFeedRequired,
  recordTick,
  evaluateLiveness,
} from './observability/health.js';
import { startKalshi, stopKalshi, getQuote as getKalshiQuote } from './feeds/kalshi.js';
import { startPyth, stopAllPyth, FEED_IDS as PYTH_FEED_IDS } from './feeds/pyth.js';
// isOptionsMarketOpen still lives in massive.js (pure utility, no provider
// coupling). Lifecycle goes through the options-provider abstraction so the
// chain source can swap via OPTIONS_PROVIDER env without engine changes.
import { isOptionsMarketOpen } from './feeds/massive.js';
import {
  startOptionsFeed,
  stopAllOptionsFeeds,
  requiredFeedName,
  OPTIONS_PROVIDER,
} from './feeds/options-provider.js';
import { startYahooOil, stopYahooOil } from './feeds/yahoo-oil.js';
import {
  startPolymarket,
  stopPolymarket,
  getYesQuote as getPolymarketYesQuote,
  getQuoteCount as getPolymarketQuoteCount,
} from './feeds/polymarket.js';
import { computeSnapshot, discoverEvent } from './engine/commodity-base.js';
import { listAllCommodities, listEnabledCommodities } from './engine/commodities.js';
import { ARB_MAPPINGS, getPolymarketYesTokenIds } from './engine/arb-mappings.js';
import { evaluateAll as evaluateArbAll } from './engine/comparator.js';
import { ARB_COMPARE_INTERVAL_MS } from './engine/arb-thresholds.js';
import { EXPIRATION_BURST_WINDOW_MS } from './engine/thresholds.js';
import {
  upsertCommodityEdgeRows,
  upsertGammaSnapshot,
  insertArbAlerts,
  filterAlreadyPostedKeys,
  recordPostedAlerts,
  recordFeedPerformance,
} from './delivery/supabase.js';
import { postCommodityAlert, postMoversAlert } from './delivery/discord.js';
import { revalidateCommodityEdge } from './delivery/revalidate.js';
import { findActiveRollover as findOilRollover } from './engine/wti-rollover.js';
import { fetchKalshiCandidates } from './feeds/movers.js';
import {
  applyFilters as applyMoverFilters,
  selectTop as selectTopMovers,
  alertKey as moverAlertKey,
  moverTier,
} from './engine/movers.js';
import {
  bootstrapMacro,
  stopMacro,
  runMacroSnapshotOnce,
  getMacroState,
} from './engine/macro.js';
import {
  bootstrapPolymarketSnapshot,
  stopPolymarketSnapshot,
  runPolymarketSnapshotOnce,
  getPolymarketSnapshotState,
} from './engine/polymarket-snapshot.js';
import {
  bootstrapGasSnapshot,
  stopGasSnapshot,
  runGasSnapshotOnce,
  getGasSnapshotState,
} from './engine/gas-snapshot.js';
import {
  bootstrapWcSnapshot,
  stopWcSnapshot,
  runWcSnapshotOnce,
  getWcSnapshotState,
  getWcEspnGames,
  getWcMispricingsState,
  getWcPayloadsState,
  runWcPayloadsOnce,
} from './engine/wc-snapshot.js';
import { runWcMispricingsOnce } from './engine/wc-mispricings.js';
import {
  bootstrapPairDiscover,
  stopPairDiscover,
  runPairDiscoverOnce,
  getPairDiscoverState,
} from './engine/pair-discover.js';

initSentry();

const PORT = Number(process.env.PORT || 8080);
const ENGINE_ENV = process.env.ENGINE_ENV || 'dev';

// --- engine state ---
//
// Each enabled commodity gets its own EngineState row. Errors stay scoped to
// the failing engine — one bad Kalshi event fetch on copper doesn't kill the
// silver loop. ETF chains, Pyth feeds, and Kalshi events are independent.

class EngineState {
  constructor(config) {
    this.config = config;
    this.currentEvent = null;
    this.expirationDateRef = { value: null };
    this.snapshotTimer = null;
    this.eventRefreshTimer = null;
    this.lastSnapshotMeta = null;
    this.lastSnapshotErrAt = null;
    this.snapshotCount = 0;
  }
}

const engines = new Map();
let stopRequested = false;

const enabledCommodities = listEnabledCommodities();
for (const config of enabledCommodities) {
  engines.set(config.commodity, new EngineState(config));
  // Data feeds gate readiness — if Massive stops responding or Pyth Hermes
  // goes down, /health returns 503. The engine markers below are descriptive
  // only; they tick once per snapshot (~5min during market hours) which is
  // looser than the 90s liveness window and would false-page if required.
  //
  // Massive moved to a 15min poll cadence on the delayed tier (May 5 2026),
  // so we override the stale threshold to 17min — anything tighter would
  // false-page between every poll. Pyth still polls at ~10s and is fine on
  // the global 90s/300s thresholds. Yahoo (oil) polls at 15min like Massive
  // and gets the same 17min override.
  // Chain always comes from the active options provider. Databento polls at
  // 5s during market hours via the sidecar; OPRA is dark off-hours, the
  // sidecar's book doesn't move, and the engine deliberately pauses writes
  // (commodities.js → pauseSnapshotsOffHours), so we drop the feed from the
  // readiness gate off-hours rather than false-paging on an intentionally
  // idle source. Massive's 15min delayed poll runs 24/5, so it keeps a 17min
  // override across both windows.
  const chainStaleOpts = OPTIONS_PROVIDER === 'databento'
    ? { maxStaleMs: 60 * 1000, requiredOffHours: false }
    : { maxStaleMs: 17 * 60 * 1000 };
  markFeedRequired(requiredFeedName(config.underlyingEtf), chainStaleOpts);

  if (config.useYahooSpot) {
    // Oil hybrid: Yahoo spot (CL=F / CLM26.NYM) + provider chain. The 15min
    // Yahoo poll cadence gets a 17min stale window. No Pyth feed for oil.
    markFeedRequired('yahoo_cl_f_spot', { maxStaleMs: 17 * 60 * 1000 });
  } else {
    markFeedRequired(`pyth_${config.pythSymbol.replace(/[/]/g, '_').toLowerCase()}`);
  }
  registerFeed(`${config.commodity}_engine`);
}
markFeedRequired('kalshi');
markFeedRequired('polymarket');
registerFeed('arb_engine');
registerFeed('movers_engine');

// Phase 2B arb engine state (separate from per-commodity engines).
const arbState = {
  evaluations: 0,
  alertsWritten: 0,
  lastRunAt: null,
  lastErrorAt: null,
  compareTimer: null,
};

// Phase 3 movers state. Cadence: every 4 hours, matches the discord-market-
// movers Edge Function it replaces. Test bypass: GET /dev/movers?test=true.
const MOVERS_INTERVAL_MS = Number(process.env.MOVERS_INTERVAL_MS || 4 * 3600 * 1000);
const moversState = {
  scans: 0,
  candidates: 0,
  posted: 0,
  suppressed: 0,
  lastRunAt: null,
  lastErrorAt: null,
  scanTimer: null,
};

function commodityAlertKey(commodity, tier, edge) {
  // Tier in the key so a tier upgrade re-fires; strike + direction so a
  // different strike crossing threshold fires independently.
  return `commodity_edge:${commodity}:${tier}:${edge.direction}:${edge.strike.toFixed(2)}`;
}

function expirationDateFromCloseTime(closeIso) {
  return new Date(closeIso).toISOString().slice(0, 10);
}

async function refreshEvent(state) {
  const { config } = state;
  try {
    const ev = await discoverEvent(config);
    if (!ev) {
      console.warn(`[${config.commodity}] no open ${config.seriesTicker} event — likely weekend; will retry`);
      state.currentEvent = null;
      return;
    }
    const newExpiration = expirationDateFromCloseTime(ev.closeTime);
    if (!state.currentEvent || state.currentEvent.eventTicker !== ev.eventTicker) {
      console.log(`[${config.commodity}] event → ${ev.eventTicker} closes ${ev.closeTime} (${ev.markets.length} strikes)`);
    }
    state.currentEvent = ev;
    state.expirationDateRef.value = newExpiration;
  } catch (err) {
    console.error(`[${config.commodity}] event refresh failed`, err?.message || err);
    Sentry.captureException(err);
  }
}

async function runSnapshotOnce(state) {
  const { config } = state;
  if (!state.currentEvent) {
    console.warn(`[${config.commodity}] no event — skipping snapshot`);
    return;
  }
  try {
    const snap = await computeSnapshot(config, state.currentEvent);
    if (!snap) {
      // commodity-base logs the specific reason (missing pyth, missing chain, etc.)
      return;
    }
    state.snapshotCount += 1;
    state.lastSnapshotMeta = snap.meta;
    recordTick(`${config.commodity}_engine`);

    const { count, tag } = await upsertCommodityEdgeRows(snap.rows);
    const top = snap.meta.topEdge;
    const topStr = top
      ? `top=${top.direction} $${top.strike.toFixed(2)} ${(top.edge_pp * 100).toFixed(1)}pp ${snap.meta.topTier}`
      : 'top=NO_EDGE';
    console.log(`[${config.commodity}] snapshot: ${count} rows tag=${tag} • ${topStr} • spot=$${snap.meta.spotPrice.toFixed(2)}`);

    // Dealer-gamma snapshot — UNIQUE (commodity, snapshot_date) makes intraday
    // ticks idempotent (last-write-wins). Failures are logged but never throw,
    // so a gamma write outage cannot block edge upserts or Discord posts.
    if (snap.meta.gamma) {
      const g = snap.meta.gamma;
      const gammaResult = await upsertGammaSnapshot({
        commodity: config.commodity,
        etfSpot: snap.meta.etfPrice,
        netDealerGamma: g.netDealerGamma,
        gammaNeutralPrice: g.gammaNeutralPrice,
        gammaEnvironment: g.gammaEnvironment,
        signalModifier: g.signalModifier,
      });
      if (gammaResult.ok) {
        console.log(
          `[${config.commodity}] gamma: ${g.gammaEnvironment} mod=${g.signalModifier} net=${g.netDealerGamma.toExponential(2)} neutral=$${g.gammaNeutralPrice.toFixed(2)} strikes=${g.strikesContributing}`,
        );
      }
    }

    // Discord + revalidate are gated on writer_tag — Massive flipped to
    // real-time on 2026-05-04 and operator set WRITER_TAG=intraday. The
    // `delayed_test` branch is kept for any future bridge-week scenario
    // (paid tier rollback, second underlying still on delayed tier, etc.).
    //
    // Per-config `bypassWriterTag` lets a feed post normally regardless of
    // the global tag — used for oil (Yahoo path, May 9 2026) so it ships
    // alerts while silver/gold remain gated under delayed_test awaiting
    // their replacement real-time source.
    //
    // posted_alerts dedup (Phase 3): the engine fires a snapshot every
    // ~5 minutes during market hours. Without dedup, the same edge would
    // re-post 12×/hour. Cooldown is 6h, keyed by (commodity, tier, direction,
    // strike) — a tier upgrade (MODERATE → STRONG) re-fires (different key);
    // the same tier inside the cooldown does not.
    const tagOk = tag === 'intraday' || tag === 'daily';
    const bypass = config.bypassWriterTag === true;

    // WTI contract-month rollover guard. When Kalshi has rolled to next month
    // but our Yahoo CL=F continuous spot still reads the prior month, the
    // comparator surfaces basis-mismatch artifacts. Suppress Discord + skip
    // revalidate across the window. Vercel page already shows a paused banner
    // (see lib/tools/oil-edge.ts). Delete when Part B (contract-aware spot)
    // ships — handoffs/OIL_EDGE_WTI_ROLLOVER_FIX_2026-05-13.md.
    const oilRollover =
      config.commodity === 'oil' ? findOilRollover(snap.meta.eventCloseAt) : null;

    if (top && snap.meta.topTier !== 'NO_EDGE' && oilRollover) {
      console.log(
        `[${config.commodity}] discord+revalidate suppressed — rollover ${oilRollover.fromContract}→${oilRollover.toContract} active`,
      );
    } else if (top && snap.meta.topTier !== 'NO_EDGE' && (tagOk || bypass)) {
      const key = commodityAlertKey(config.commodity, snap.meta.topTier, top);
      const suppressed = await filterAlreadyPostedKeys([key], { hoursWindow: 6 });
      if (suppressed.has(key)) {
        console.log(`[${config.commodity}] discord suppressed (6h cooldown) ${snap.meta.topTier}`);
      } else {
        try {
          const sent = await postCommodityAlert(snap.meta);
          if (sent) {
            console.log(`[${config.commodity}] discord posted ${snap.meta.topTier}`);
            await recordPostedAlerts([
              {
                alert_key: key,
                title: `${config.commodity} ${top.direction} $${top.strike.toFixed(2)} ${snap.meta.topTier}`.slice(0, 200),
                alert_type: 'commodity_edge',
                platform: 'kalshi',
                posted_at: new Date().toISOString(),
              },
            ]);
          }
        } catch (err) {
          console.error(`[${config.commodity}] discord post failed`, err?.message || err);
          Sentry.captureException(err);
        }
      }
    } else if (top && snap.meta.topTier !== 'NO_EDGE') {
      console.log(`[${config.commodity}] would post discord ${snap.meta.topTier} (gated by writer_tag=${tag})`);
    }

    // Revalidate still runs during rollover — the page-side guard
    // (lib/tools/oil-edge.ts findActiveRollover) re-renders with the banner
    // and PASS rows, so a fresh build is desirable, not harmful.
    if (tagOk || bypass) {
      revalidateCommodityEdge(config.commodity)
        .then((r) => console.log(`[${config.commodity}] revalidate strategy=${r.strategy} ok=${r.ok}`))
        .catch((err) => console.warn(`[${config.commodity}] revalidate threw`, err?.message || err));
    }
  } catch (err) {
    state.lastSnapshotErrAt = new Date().toISOString();
    console.error(`[${config.commodity}] snapshot failed`, err?.message || err);
    Sentry.captureException(err);
  }
}

function isInExpirationWindow(ev) {
  if (!ev?.closeTime) return false;
  const msToClose = new Date(ev.closeTime).getTime() - Date.now();
  return msToClose > 0 && msToClose <= EXPIRATION_BURST_WINDOW_MS;
}

// Off-hours dormant interval for commodities that pause writes overnight. We
// don't need to wake more often than this — the next loop just checks whether
// the market is open yet and either schedules a real snapshot or sleeps again.
const OFF_HOURS_DORMANT_CHECK_MS = 10 * 60 * 1000;

function scheduleSnapshot(state) {
  if (stopRequested) return;
  const { config } = state;
  const inBurst = isInExpirationWindow(state.currentEvent);
  const marketOpen = isOptionsMarketOpen();

  // Commodities flagged pauseSnapshotsOffHours (silver/gold on Databento)
  // skip the off-hours write loop entirely — OPRA is dark, the book hasn't
  // moved, and re-upserting identical rows into commodity_edge_signals only
  // wastes DB writes. Still tick on a slow timer so we resume cleanly at
  // 9:30 AM ET without waiting for the next bootstrap.
  if (config.pauseSnapshotsOffHours && !inBurst && !marketOpen) {
    if (state.lastCadence !== 'dormant') {
      console.log(`[${config.commodity}] cadence → dormant (off-hours, snapshots paused)`);
      state.lastCadence = 'dormant';
    }
    state.snapshotTimer = setTimeout(() => scheduleSnapshot(state), OFF_HOURS_DORMANT_CHECK_MS);
    return;
  }

  let delay;
  let cadence;
  if (inBurst) {
    delay = config.snapshotIntervalExpirationMs;
    cadence = 'expiration_burst';
  } else if (marketOpen) {
    delay = config.snapshotIntervalMarketMs;
    cadence = 'market';
  } else {
    delay = config.snapshotIntervalOffMs;
    cadence = 'off';
  }
  // Log only on cadence transitions so the Friday burst is visible without
  // 60 lines/min of "still in burst" noise. Acceptance test (handoff #3) reads
  // these transitions to confirm the 60s delay activates pre-close.
  if (state.lastCadence !== cadence) {
    console.log(`[${config.commodity}] cadence → ${cadence} (delay=${delay}ms)`);
    state.lastCadence = cadence;
  }
  state.snapshotTimer = setTimeout(async () => {
    await runSnapshotOnce(state);
    scheduleSnapshot(state);
  }, delay);
}

async function bootstrapEngine(state) {
  await refreshEvent(state);
  // Chain always comes from the options provider. Oil also starts the Yahoo
  // spot poller (CL=F + contract-aware CLM26.NYM); silver/gold get their spot
  // from Pyth via startPyth() in bootstrapAll.
  startOptionsFeed(state);
  if (state.config.useYahooSpot) {
    startYahooOil(state.expirationDateRef);
  }
  // 8s is enough for the sidecar to deliver a populated chain on a warm
  // restart. Yahoo's spot poller is a single v8 chart call and resolves well
  // inside that window too.
  const firstSnapshotDelayMs = 8_000;
  setTimeout(async () => {
    await runSnapshotOnce(state);
    scheduleSnapshot(state);
  }, firstSnapshotDelayMs);
  state.eventRefreshTimer = setInterval(() => refreshEvent(state), 30 * 60 * 1000);
}

async function bootstrapAll() {
  // Pyth: dedupe symbols across enabled commodities, skip those without a
  // verified feed ID and the Yahoo-sourced ones (oil) since Pyth isn't used
  // for them. The poller logs a warning for unverified IDs and the engine
  // fails open.
  const pythSymbols = Array.from(
    new Set(
      enabledCommodities
        .filter((c) => !c.useYahooSpot)
        .map((c) => c.pythSymbol)
        .filter((s) => PYTH_FEED_IDS[s]),
    ),
  );
  startPyth(pythSymbols);
  for (const state of engines.values()) {
    bootstrapEngine(state).catch((err) => {
      console.error(`[${state.config.commodity}] bootstrap failed`, err);
      Sentry.captureException(err);
    });
  }
}

// --- arb engine (Phase 2B) ---
//
// Polymarket WS feeds the YES-token quotes; Kalshi WS already feeds the matched
// market YES. The comparator runs on a timer (every ARB_COMPARE_INTERVAL_MS),
// pulls both maps, and writes any rows that crossed thresholds and survived
// dedup into arb_alerts. The Pro dashboard subscribes via Realtime — there is
// no Discord delivery for arb in v1 (the Pro component is the surface).

async function runArbCompareOnce() {
  try {
    const writes = evaluateArbAll({
      getKalshiQuote,
      getPolymarketYesQuote,
      now: Date.now(),
    });
    arbState.evaluations += 1;
    arbState.lastRunAt = new Date().toISOString();
    if (writes.length === 0) return;
    const { count } = await insertArbAlerts(writes);
    arbState.alertsWritten += count;
    recordTick('arb_engine');
    const summary = writes
      .map((w) => `${w.pair_slug}=${w.spread_pp}pp/${w.confidence}`)
      .join(', ');
    console.log(`[arb] wrote ${count} alert(s): ${summary}`);
  } catch (err) {
    arbState.lastErrorAt = new Date().toISOString();
    console.error('[arb] comparator run failed', err?.message || err);
    Sentry.captureException(err);
  }
}

function scheduleArbCompare() {
  if (stopRequested) return;
  arbState.compareTimer = setTimeout(async () => {
    await runArbCompareOnce();
    scheduleArbCompare();
  }, ARB_COMPARE_INTERVAL_MS);
}

// --- movers engine (Phase 3) ---
//
// Replaces supabase/functions/discord-market-movers. Fetches the 22-series
// Kalshi watchlist, applies vol/delta/price filters, dedupes against
// posted_alerts (24h cooldown — same window as the Edge Fn), posts top N
// gainers + losers to #market-movers, and writes feed_performance rows.
//
// Discord posting is gated on WRITER_TAG (the engine's bridge-week safety
// switch) so the soak window starts fully under operator control.

async function runMoversOnce({ isTest = false } = {}) {
  const tag = process.env.WRITER_TAG || 'delayed_test';
  try {
    moversState.scans += 1;
    moversState.lastRunAt = new Date().toISOString();
    recordTick('movers_engine');
    const all = await fetchKalshiCandidates();
    const sportsRestricted = process.env.NEXT_PUBLIC_SPORTS_RESTRICTION === '1';
    let filtered = applyMoverFilters(all, { sportsRestricted, isTest });
    moversState.candidates += filtered.length;

    if (!isTest && filtered.length > 0) {
      const keys = filtered.map(moverAlertKey);
      const suppressed = await filterAlreadyPostedKeys(keys, { hoursWindow: 24 });
      const before = filtered.length;
      filtered = filtered.filter((c) => !suppressed.has(moverAlertKey(c)));
      moversState.suppressed += before - filtered.length;
    }

    const { gainers, losers } = selectTopMovers(filtered, { isTest });
    const toPost = [...gainers, ...losers];

    if (toPost.length === 0) {
      console.log(
        `[movers] scanned=${all.length} candidates=${filtered.length} posted=0 test=${isTest}`,
      );
      return { scanned: all.length, candidates: filtered.length, posted: 0 };
    }

    if (!isTest && tag === 'delayed_test') {
      console.log(
        `[movers] would post ${toPost.length} (gated by writer_tag=${tag}) — gainers=${gainers.length} losers=${losers.length}`,
      );
      return { scanned: all.length, candidates: filtered.length, posted: 0, gated: true };
    }

    const sent = await postMoversAlert({ gainers, losers });
    if (!sent) {
      console.warn('[movers] postMoversAlert returned false (no token?) — skipping dedup write');
      return { scanned: all.length, candidates: filtered.length, posted: 0 };
    }
    moversState.posted += toPost.length;

    if (!isTest) {
      const now = new Date().toISOString();
      await recordPostedAlerts(
        toPost.map((c) => ({
          alert_key: moverAlertKey(c),
          title: c.title.slice(0, 200),
          alert_type: 'market_movers',
          platform: 'kalshi',
          posted_at: now,
        })),
      );
      await recordFeedPerformance(
        toPost.map((c) => ({
          feed_type: 'market_movers',
          alert_id: moverAlertKey(c),
          platform: 'kalshi',
          market_id: c.ticker,
          confidence_tier: moverTier(Math.abs(c.price_change_24h)),
          direction: c.yes_price <= 50 ? 'no' : 'yes',
          alert_price: c.yes_price,
          alert_edge_pp: Math.abs(c.price_change_24h),
        })),
      );
    }

    console.log(
      `[movers] posted ${toPost.length} (gainers=${gainers.length} losers=${losers.length}) scanned=${all.length}`,
    );
    return {
      scanned: all.length,
      candidates: filtered.length,
      gainers: gainers.length,
      losers: losers.length,
      posted: toPost.length,
    };
  } catch (err) {
    moversState.lastErrorAt = new Date().toISOString();
    console.error('[movers] run failed', err?.message || err);
    Sentry.captureException(err);
    throw err;
  }
}

function scheduleMovers() {
  if (stopRequested) return;
  moversState.scanTimer = setTimeout(async () => {
    try {
      await runMoversOnce();
    } catch {
      /* runMoversOnce already logged + reported */
    }
    scheduleMovers();
  }, MOVERS_INTERVAL_MS);
}

function bootstrapMovers() {
  // Wait briefly so Kalshi WS + commodity engines have settled before the
  // first REST burst. 30s also avoids racing the engine's first snapshot log.
  setTimeout(() => {
    runMoversOnce().catch(() => {});
    scheduleMovers();
  }, 30_000);
}

function bootstrapArb() {
  const tokenIds = getPolymarketYesTokenIds();
  if (tokenIds.length === 0) {
    console.warn('[arb] no mappings registered — comparator skipped');
    return;
  }
  startPolymarket(tokenIds).catch((err) => {
    console.error('[polymarket] startup failed', err);
    Sentry.captureException(err);
  });
  // Wait briefly so both feeds populate quote maps before the first compare.
  setTimeout(() => {
    runArbCompareOnce().catch(() => {
      /* runArbCompareOnce already logs and reports */
    });
    scheduleArbCompare();
  }, 10_000);
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    const snap = snapshot();
    const liveness = evaluateLiveness();
    snap.healthy = liveness.healthy;
    snap.liveness = {
      inMarketHours: liveness.inMarketHours,
      thresholdMs: liveness.thresholdMs,
      uptimeMs: liveness.uptimeMs,
      grace: liveness.grace,
      stale: liveness.stale,
    };
    snap.engine = {
      env: ENGINE_ENV,
      commodities: {},
    };
    for (const [name, state] of engines) {
      snap.engine.commodities[name] = {
        snapshotCount: state.snapshotCount,
        lastSnapshotErrAt: state.lastSnapshotErrAt,
        currentEvent: state.currentEvent?.eventTicker || null,
        lastSnapshot: state.lastSnapshotMeta
          ? {
              generatedAt: state.lastSnapshotMeta.generatedAt,
              spotPrice: state.lastSnapshotMeta.spotPrice,
              etfPrice: state.lastSnapshotMeta.etfPrice,
              topTier: state.lastSnapshotMeta.topTier,
              topTierInt: state.lastSnapshotMeta.topTierInt,
              strikeCount: state.lastSnapshotMeta.strikeCount,
            }
          : null,
      };
    }
    snap.engine.disabledCommodities = listAllCommodities()
      .filter((c) => !c.enabled)
      .map((c) => c.commodity);
    snap.engine.arb = {
      mappingCount: ARB_MAPPINGS.length,
      polymarketQuotes: getPolymarketQuoteCount(),
      evaluations: arbState.evaluations,
      alertsWritten: arbState.alertsWritten,
      lastRunAt: arbState.lastRunAt,
      lastErrorAt: arbState.lastErrorAt,
    };
    snap.engine.movers = {
      scans: moversState.scans,
      candidates: moversState.candidates,
      posted: moversState.posted,
      suppressed: moversState.suppressed,
      lastRunAt: moversState.lastRunAt,
      lastErrorAt: moversState.lastErrorAt,
    };
    snap.engine.macro = getMacroState();
    snap.engine.polymarket_snapshot = getPolymarketSnapshotState();
    snap.engine.gas_snapshot = getGasSnapshotState();
    snap.engine.wc_snapshot = getWcSnapshotState();
    snap.engine.wc_espn = getWcEspnGames();
    snap.engine.wc_mispricings = getWcMispricingsState();
    snap.engine.wc_payloads = getWcPayloadsState();
    snap.engine.pair_discover = getPairDiscoverState();
    const status = liveness.healthy ? 200 : 503;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snap));
    return;
  }

  if (url.pathname === '/dev/throw') {
    const err = new Error('dev/throw — deliberate Sentry test capture');
    Sentry.captureException(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'captured', message: err.message }));
    return;
  }

  // Manual trigger for ops debugging — fires one movers scan, returns the
  // result. ?test=true skips filters + dedup so it always posts something.
  if (url.pathname === '/dev/movers') {
    const isTest = url.searchParams.get('test') === 'true';
    runMoversOnce({ isTest })
      .then((result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      });
    return;
  }

  // Manual trigger for ops debugging — fires one macro snapshot pass and
  // returns the count of rows written. Useful for verifying the new table
  // post-deploy without waiting up to 15min for the next scheduled tick.
  if (url.pathname === '/dev/macro') {
    runMacroSnapshotOnce()
      .then((result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      });
    return;
  }

  // Manual trigger for ops debugging — fires one Kalshi gas snapshot pass and
  // returns the count of rows written. Useful for verifying kalshi_gas_strikes
  // post-deploy without waiting up to 15min for the next scheduled tick.
  if (url.pathname === '/dev/gas') {
    runGasSnapshotOnce()
      .then((result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      });
    return;
  }

  // Manual trigger for ops debugging — fires one Polymarket Gamma snapshot
  // pass and returns the count of rows written. Useful for verifying the new
  // table post-deploy without waiting up to 15min for the next scheduled tick.
  if (url.pathname === '/dev/poly') {
    runPolymarketSnapshotOnce()
      .then((result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      });
    return;
  }

  // Manual trigger — one WC snapshot scan across all four feeds. Useful for
  // ops debugging and the post-merge soak window.
  if (url.pathname === '/dev/wc') {
    runWcSnapshotOnce()
      .then((result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      });
    return;
  }

  // PR 4 — manual mispricing trigger. Reads sim_latest × market_latest as-is
  // (no fresh snapshot fetch) so it's safe to fire ad-hoc during the soak
  // without blowing through the Odds API quota.
  if (url.pathname === '/dev/wc-mispricings') {
    runWcMispricingsOnce()
      .then((result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      });
    return;
  }

  // Manual trigger for pair-discover — useful for verifying the LLM flow and
  // ANTHROPIC_API_KEY wiring without waiting for the 24h cadence. ?force=true
  // bypasses the lastRunAt short-circuit.
  if (url.pathname === '/dev/pair-discover') {
    const force = url.searchParams.get('force') === 'true';
    runPairDiscoverOnce({ force })
      .then((result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      });
    return;
  }

  // PR 5 — manual payload-rebuild trigger. Pure read+upsert (no Kalshi /
  // Polymarket fetches), safe to fire on demand for ops debugging.
  if (url.pathname === '/dev/wc-payloads') {
    runWcPayloadsOnce()
      .then((result) => {
        res.writeHead(result.ok === false ? 500 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      });
    return;
  }

  // Manual trigger for ops debugging — fires one snapshot for the named
  // commodity, returns the result.
  if (url.pathname === '/dev/snapshot') {
    const commodity = url.searchParams.get('commodity') || 'silver';
    const state = engines.get(commodity);
    if (!state) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `unknown or disabled commodity: ${commodity}` }));
      return;
    }
    runSnapshotOnce(state)
      .then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, meta: state.lastSnapshotMeta }));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
});

server.listen(PORT, () => {
  console.log(
    `[http] listening on :${PORT} env=${ENGINE_ENV} writer_tag=${process.env.WRITER_TAG || 'delayed_test'} commodities=${enabledCommodities.map((c) => c.commodity).join(',')}`,
  );
});

startKalshi().catch((err) => {
  console.error('[kalshi] startup failed', err);
  Sentry.captureException(err);
});

bootstrapAll().catch((err) => {
  console.error('[engine] bootstrap failed', err);
  Sentry.captureException(err);
});

bootstrapArb();

bootstrapMovers();

bootstrapMacro();

bootstrapPolymarketSnapshot();

bootstrapGasSnapshot();

bootstrapWcSnapshot();

bootstrapPairDiscover();

// --- shutdown ---

async function shutdown(signal) {
  console.log(`[shutdown] ${signal} received`);
  stopRequested = true;
  for (const state of engines.values()) {
    if (state.snapshotTimer) clearTimeout(state.snapshotTimer);
    if (state.eventRefreshTimer) clearInterval(state.eventRefreshTimer);
  }
  if (arbState.compareTimer) clearTimeout(arbState.compareTimer);
  if (moversState.scanTimer) clearTimeout(moversState.scanTimer);
  stopMacro();
  stopPolymarketSnapshot();
  stopGasSnapshot();
  stopWcSnapshot();
  stopPairDiscover();
  stopKalshi();
  stopPolymarket();
  stopAllPyth();
  stopAllOptionsFeeds();
  stopYahooOil();
  server.close(() => {
    console.log('[shutdown] http closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('[shutdown] forced exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  Sentry.captureException(reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  Sentry.captureException(err);
});
