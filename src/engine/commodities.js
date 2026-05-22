// Per-commodity static config — single registry consumed by every engine
// (silver/gold/oil/copper) and by the multi-engine bootstrap in src/index.js.
//
// Each entry is plan §10 input. Adding a commodity = one entry here + one thin
// wrapper file in src/engine/. The shared compute fn in commodity-base.js
// reads the rest from the row passed in.
//
// Spot/chain feed source per commodity (May 16 2026):
//   silver   Pyth XAG/USD  + Databento SLV.OPT   (real-time, default provider)
//   gold     Pyth XAU/USD  + Databento GLD.OPT   (real-time)
//   oil      Yahoo CL=F /  + Databento USO.OPT   (hybrid: Yahoo spot for
//            CLM26.NYM                            contract-aware WTI accuracy,
//                                                 Databento for real-time IV chain)
//   bitcoin  Pyth BTC/USD  + Databento IBIT.OPT  (Phase 4 — daily Kalshi
//                                                 strike markets KXBTCD twice
//                                                 per session at 9am + 5pm ET)
//   copper   Pyth XCU/USD  — UNVERIFIED, no Pyth feed ID configured. Engine
//                            fails open when getPrice() returns null.
//
// Per-commodity `useYahooSpot` flag flips the spot source in commodity-base.js
// from Pyth to src/feeds/yahoo-oil.js. Chain always comes from the active
// options provider (Databento default; Massive fallback via OPTIONS_PROVIDER).
// Per-commodity `bypassWriterTag` flag exempts a feed from the WRITER_TAG
// gate that suppresses Discord posts + Vercel revalidation. Used for oil so
// it can post normally while silver/gold remain gated under delayed_test
// awaiting their replacement real-time source.
//
// `enabled` flag: false = engine bootstraps but no-ops. Lets the multi-engine
// scheduler ship without a real feed source for copper. Flip to true once
// the spot feed is wired.

import {
  SNAPSHOT_INTERVAL_MARKET_MS,
  SNAPSHOT_INTERVAL_OFF_MS,
  SNAPSHOT_INTERVAL_EXPIRATION_MS,
} from './thresholds.js';

export const COMMODITIES = {
  silver: {
    commodity: 'silver',
    seriesTicker: 'KXSILVERW',
    underlyingEtf: 'SLV',
    pythSymbol: 'XAG/USD',
    spotUnit: '$/oz',
    spotLabel: 'Pyth XAG/USD',
    enabled: true,
    // V2 cutover (2026-05-21): physical-measure prob drives direction/
    // confidence/tier/routing. drift.js + vol.js outputs feed
    // probAboveStrikePhysical; if either fails this tick the row falls back
    // to the V1 risk-neutral edge silently. See commodity-base.js v2Eligible
    // gate.
    useV2Cutover: true,
    // FRED skip: no clean daily silver spot equivalent on FRED (LBMA silver
    // is monthly only). Revisit if a daily series surfaces. See handoffs/
    // BATCH_FRED_P5_AND_TRACKER_P2_2026-05-10.md.
    fredSeriesId: null,
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
    // OPRA is dark off-hours and the SLV options book doesn't move, so
    // writing snapshots overnight just upserts duplicate rows into
    // commodity_edge_signals. Engine sleeps the snapshot loop off-hours
    // and resumes at 9:30 AM ET. Pairs with requiredOffHours:false on the
    // databento_slv readiness gate (src/index.js).
    pauseSnapshotsOffHours: true,
  },
  gold: {
    commodity: 'gold',
    seriesTicker: 'KXGOLDW',
    underlyingEtf: 'GLD',
    pythSymbol: 'XAU/USD',
    spotUnit: '$/oz',
    spotLabel: 'Pyth XAU/USD',
    enabled: true,
    // V2 cutover — see commodities.silver.useV2Cutover note.
    useV2Cutover: true,
    // FRED Phase 5: London Bullion Market PM fix, daily.
    fredSeriesId: 'GOLDPMGBD228NLBM',
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
    // Same as silver — OPRA dark off-hours, GLD book frozen, no new info to
    // surface. See commodities.silver.pauseSnapshotsOffHours.
    pauseSnapshotsOffHours: true,
  },
  oil: {
    commodity: 'oil',
    seriesTicker: 'KXWTI',
    underlyingEtf: 'USO',
    pythSymbol: 'WTI', // not used when useYahooSpot is true; kept for shape parity
    spotUnit: '$/bbl',
    spotLabel: 'USO-synthetic (Databento USO × FRED DCOILWTICO daily anchor)',
    enabled: true,
    // V2 cutover — see commodities.silver.useV2Cutover note.
    useV2Cutover: true,
    // USO-synthetic primary path (Phase B of COMMODITY_EDGE_CUTOVER_PLAN_
    // 2026-05-21). Derives WTI spot from the real-time USO mid the chain
    // already carries × a daily wti/uso ratio anchored to FRED DCOILWTICO.
    // Replaces Yahoo CL=F as the latency-sensitive anchor; Yahoo paths
    // below stay wired as tertiary fallback (contract-aware first, then
    // continuous CL=F) so any synthetic failure mode is covered without
    // a deploy. See src/feeds/uso-synthetic.js.
    useUsoSynthetic: true,
    useYahooSpot: true,
    bypassWriterTag: true,
    // Contract-aware spot (Part B of OIL_EDGE_WTI_ROLLOVER_FIX_2026-05-13).
    // SECONDARY fallback after Phase B 2026-05-22. When useUsoSynthetic
    // can't anchor (FRED outage, USO prev_close fetch failure, empty
    // chain so no live USO mid), we drop to this path: resolve the active
    // settle contract from Kalshi series metadata and pull the matching
    // Yahoo specific-month spot (CLM26.NYM etc.). Tertiary is CL=F
    // continuous via getOilSpot below.
    useContractAwareSpot: true,
    // FRED Phase 5: WTI Cushing daily close. Critical given the Yahoo CL=F
    // path is the most fragile of the four feeds.
    fredSeriesId: 'DCOILWTICO',
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
    // OPRA dark off-hours: USO chain stops updating overnight even though
    // Yahoo CL=F continues to print on Globex/Asia. Writing snapshots with
    // a frozen IV smile + a moving spot would just upsert misleading rows.
    // Pairs with requiredOffHours:false on the databento_uso readiness gate.
    pauseSnapshotsOffHours: true,
  },
  bitcoin: {
    commodity: 'bitcoin',
    // KXBTCD = "Bitcoin price Above/below" — HOURLY strike-event contracts
    // settling at the top of every hour, 24/7. Settlement is a 60-second
    // TWAP of the CF Benchmarks BRTI bitcoin reference rate over the minute
    // leading up to the hour. (Verified 2026-05-16 via /trade-api/v2/series:
    // frequency=hourly, tags include "Hourly", settlement_sources points to
    // CF Benchmarks BRTI.) Strikes are floor_strike numerics (e.g. $108,000)
    // parsed as-is by kalshi-event.js.
    seriesTicker: 'KXBTCD',
    // IBIT (BlackRock iShares Bitcoin Trust) — by far the most liquid US
    // spot-BTC ETF chain; FBTC and BITB trade an order of magnitude less.
    // OPRA NBBO via Databento sidecar (DATABENTO_SYMBOLS must include
    // IBIT.OPT — see project memory databento-phase1-live for the secret).
    underlyingEtf: 'IBIT',
    // Pyth Crypto.BTC/USD — verified 2026-05-16 against Hermes
    // (price returned $78,052 in spot check). 24/7 feed; engine still pauses
    // snapshots off-hours because the IBIT chain is frozen overnight and
    // running edge math against a stale smile would just chase moving spot.
    pythSymbol: 'BTC/USD',
    spotUnit: '$/BTC',
    spotLabel: 'Pyth BTC/USD',
    enabled: true,
    // V2 cutover EXPLICITLY OFF for bitcoin. KXBTCD events are hourly, so
    // T is ~tiny — drift contribution mathematically caps at ≤0.15pp,
    // invisible vs the 7pp MODERATE threshold. Math says V2 is a no-op
    // here; operational risk-aversion says keep BTC untouched until
    // silver/gold/oil prove V2 is correct in production. drift/vol
    // estimators still run (cost ~5ms) and write to the parallel V2
    // columns for free backtest data, but direction/confidence stay V1.
    useV2Cutover: false,
    // FRED skip: no daily BTC spot series on FRED; CF Benchmarks BRTI
    // (Kalshi's settlement source) isn't on FRED either. The Massive-style
    // cross-check that protects oil from a frozen CL=F print doesn't apply
    // when Pyth itself is the canonical real-time feed.
    fredSeriesId: null,
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
    // OPRA closes at 4pm ET. IBIT chain stops updating overnight even
    // though BTC spot keeps moving on 24/7 venues — running edge math
    // against a frozen IV smile + a moving Pyth spot would surface
    // basis-mismatch artifacts, not real edges. Burst window (60min
    // pre-close) still fires so the engine captures the final hour of
    // pre-settlement action. Pairs with requiredOffHours:false on the
    // databento_ibit readiness gate.
    pauseSnapshotsOffHours: true,
    // Restrict snapshots to the 7 hourly settles per weekday (10 AM through
    // 4 PM ET) covered by a live IBIT options chain. KXBTCD event tickers
    // encode the ET wallclock hour as the trailing 2 digits (DST-safe by
    // construction — Kalshi always emits ET wallclock, not UTC). The other
    // 17 daily settles + all weekend settles fall outside US equity-options
    // hours where the model has no honest IV input on the comparison side.
    // Aligns the engine with the public surface (article + tool page) that
    // ships only these 7 settles. Added 2026-05-16 after Kalshi API revealed
    // KXBTCD is hourly, not twice-daily as Phase 4 originally assumed.
    eventFilter: (ev) => {
      const m = String(ev.event_ticker).match(/(\d{2})$/);
      if (!m) return false;
      const hour = Number(m[1]);
      return hour >= 10 && hour <= 16;
    },
  },
  spx: {
    commodity: 'spx',
    // KXINXU = S&P 500 above/below — HOURLY strike-event contracts settling
    // at the top of every hour 9:30 AM–4 PM ET (7 settles/weekday: H1000
    // through H1600). Underlying is the .INX cash index; per the Kalshi
    // contract terms PDF (kalshi-public-docs.s3.../INX.pdf, verified
    // 2026-05-21) the Source Agency is Kalshi itself, so no S&P DJI license
    // is required to trade or analyze. Strikes are floor_strike numerics
    // at $25-wide increments (~60 strikes/event, 6600–8075 in current
    // regime). 24h volume on a single event around 26k contracts as of
    // 2026-05-21 — second-highest non-crypto Kalshi series after KXBTCD.
    seriesTicker: 'KXINXU',
    // SPY ETF — by 10× the most liquid OPRA-listed equity options chain.
    // Must add `SPY` to DATABENTO_SYMBOLS Fly secret BEFORE flipping
    // enabled:true (handoffs/SP500_EDGE_ENGINE_2026-05-21.md §Phase 0).
    underlyingEtf: 'SPY',
    // Pyth Equity.US.SPY/USD regular-session feed. Schedule (Hermes
    // attribute) is exactly 0930-1600 ET — drops out off-hours by design,
    // which lines up with KXINXU's locked trading window. We deliberately
    // skip the .PRE/.POST/.ON session-gated variants because the contract
    // doesn't trade outside RTH. SPY-ETF vs .INX-cash basis (~3-5bp)
    // auto-handled by commodity-base.js's `ratio = etfPrice / spotPrice`
    // — same mechanism that bridges Pyth BTC/USD to IBIT strikes.
    pythSymbol: 'SPY/USD',
    spotUnit: 'index pts',
    spotLabel: 'Pyth SPY/USD (S&P 500 ETF)',
    enabled: false, // FLIP TRUE after Phase 0 Databento SPY soak passes
    // FRED Phase 5: S&P 500 daily close. EOD only — catches Pyth/Databento
    // staleness at the next-morning open the same way DCOILWTICO protects
    // the WTI engine.
    fredSeriesId: 'SP500',
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
    // OPRA closes 4pm ET, .INX cash session closes 4pm ET, Pyth SPY/USD
    // regular-session feed drops out at 4pm ET — all three feeds converge
    // on the same window with no basis-mismatch risk (unlike Bitcoin where
    // Pyth keeps moving overnight while IBIT chain freezes). Keep pause
    // so we don't upsert stale rows on weekends.
    pauseSnapshotsOffHours: true,
    // Restrict snapshots to the 7 hourly settles 10am–4pm ET. KXINXU event
    // tickers encode the ET wallclock hour as `H1000` through `H1600` (e.g.
    // KXINXU-26MAY21H1600). Out-of-hours phantom events get filtered out
    // defensively. Mirrors the BTC eventFilter pattern in commodities.bitcoin.
    eventFilter: (ev) => {
      const m = String(ev.event_ticker).match(/H(\d{4})$/);
      if (!m) return false;
      const hour = Number(m[1].slice(0, 2));
      return hour >= 10 && hour <= 16;
    },
    // SPY trailing 12-month dividend yield ~1.3% (2026-Q1). Matters for the
    // risk-neutral drift on sub-hour expiries; commodity-base.js reads this
    // via `config.dividendYield ?? DIVIDEND_YIELD` so silver/gold/oil/bitcoin
    // keep the global 0.0 default.
    dividendYield: 0.013,
  },
  copper: {
    commodity: 'copper',
    seriesTicker: 'KXCOPPERMON',
    underlyingEtf: 'CPER',
    pythSymbol: 'XCU/USD',
    spotUnit: '$/lb',
    spotLabel: 'Pyth XCU/USD (unverified)',
    enabled: false, // flip true once a copper spot feed is wired
    // FRED skip: same constraint as silver — no daily FRED copper series.
    fredSeriesId: null,
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
  },
};

export function getCommodityConfig(name) {
  const c = COMMODITIES[name];
  if (!c) throw new Error(`unknown commodity: ${name}`);
  return c;
}

export function listEnabledCommodities() {
  return Object.values(COMMODITIES).filter((c) => c.enabled);
}

export function listAllCommodities() {
  return Object.values(COMMODITIES);
}
