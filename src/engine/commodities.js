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
  BTC_SNAPSHOT_INTERVAL_MARKET_MS,
  BTC_STRIKE_BAND_PCT,
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
    // Spot is Pyth (sub-second publishes); 5 min without a tick means the feed
    // is dead, not quiet. Demotes tier — see commodity-base.js staleness gate.
    maxSpotAgeMs: 5 * 60 * 1000,
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
    // OPRA is dark off-hours and the SLV options book doesn't move, so
    // writing snapshots overnight just upserts duplicate rows into
    // commodity_edge_signals. Engine sleeps the snapshot loop off-hours
    // and resumes at 9:30 AM ET. Pairs with requiredOffHours:false on the
    // databento_slv readiness gate (src/index.js).
    pauseSnapshotsOffHours: true,
    // Intraday history retention (INTRADAY_EDGE_HISTORY_2026-07-05). Append the
    // banded strike subset to commodity_edge_intraday every tick; nightly rollup
    // + 7-day prune handle the rest. Band = ±intradayBandPct of spot ∪ live book.
    // --- Containment kit ported from bitcoin (EDGE_MARKETS §1.1, 2026-08-31) ---
    // Metals/oil shipped raw probAboveStrikePhysical with none of bitcoin's
    // post-incident guards. Observed live 2026-08-28: at T=2h, gold σ_blend
    // ≈0.14 → σ√τ ≈0.21%; a strike 0.5% OTM prints d₂=2.37 → model 99.1% vs a
    // 79¢ book → +20pp "edge" → STRONG in edge_alerts. Bitcoin's measured
    // version of the same disease: claimed 0.794, realized 0.481.
    //
    // Graduated tier ceiling by minutes-to-close — same mechanism as bitcoin's,
    // scaled to the daily/weekly settle horizon (bitcoin is hourly, so its
    // 30/10/2 ladder would sit entirely inside the window where the Aug 28 row
    // fired). STRONG needs ≥120min (the observed T=2h failure is inside it),
    // MODERATE ≥30min, SPECULATIVE ≥5min; inside 5min every row goes PASS.
    tierCeilingByMinutes: { STRONG: 120, MODERATE: 30, SPECULATIVE: 5 },
    // Post-spread, side-aware BUY gate (mechanism: commodity-base.js
    // postSpreadSideGate). YES must clear its ask-side spread by ≥5pp
    // (MIN_EDGE_PP), or ≥10pp when yesAsk ≥70¢ (favorite band, via the default
    // yesFavorite knobs — model saturation is worst exactly where the Aug 28
    // row sat); YES under 15¢ is suppressed (longshot band). NO side stays
    // ENABLED here — unlike bitcoin, there is no adverse live NO record for
    // this engine — but at the stricter 10pp post-spread bar.
    postSpreadGate: true,
    // Net of the Kalshi fee too (§1.4, 2026-08-31). The spread was already
    // charged; a fee peaking at 1.75c on a 50c contract is most of a thin edge,
    // so a tier computed without it was never a claim about money. Published
    // counts fall by design — that is the point, and it is recorded in
    // tool_changes for each of the four surfaces.
    chargeFees: true,
    // μ = 0 (EDGE_MARKETS §2.4, 2026-08-31). The 60-day trailing drift carried
    // no information at the horizons we price and only displaced the model CDF.
    // Measured, not assumed: see the backtest note in commodity-base.js.
    // Bitcoin is NOT here — its drift path is the short-horizon momentum μ,
    // already zeroed at BTC_MU_SCALE.
    driftMuScale: 0,
    minEdgePpNoSide: 0.1,
    noSideEnabled: true,
    intradayHistory: true,
    intradayBandPct: 0.10,
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
    // FRED skip (2026-08-19): GOLDPMGBD228NLBM (LBMA gold PM fix) returns HTTP
    // 400 from the FRED API — surfaced as `fred_goldpmgbd228nlbm: FRED 400` on
    // /health. FRED withdrew the LBMA precious-metal series over licensing, so
    // this is gone, not flaky. Left as-is it fails EVERY tick and the divergence
    // cross-check below never runs, which means gold silently lost its stale-spot
    // guard while still looking configured. Null opts out honestly, exactly as
    // silver already does. Revisit if a daily gold series surfaces on FRED.
    fredSeriesId: null,
    // Spot is Pyth (sub-second publishes); 5 min without a tick means the feed
    // is dead, not quiet. Demotes tier — see commodity-base.js staleness gate.
    maxSpotAgeMs: 5 * 60 * 1000,
    snapshotIntervalMarketMs: SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: SNAPSHOT_INTERVAL_EXPIRATION_MS,
    // Same as silver — OPRA dark off-hours, GLD book frozen, no new info to
    // surface. See commodities.silver.pauseSnapshotsOffHours.
    pauseSnapshotsOffHours: true,
    // Intraday history retention — see commodities.silver.intradayHistory.
    // --- Containment kit ported from bitcoin (EDGE_MARKETS §1.1, 2026-08-31) ---
    // Metals/oil shipped raw probAboveStrikePhysical with none of bitcoin's
    // post-incident guards. Observed live 2026-08-28: at T=2h, gold σ_blend
    // ≈0.14 → σ√τ ≈0.21%; a strike 0.5% OTM prints d₂=2.37 → model 99.1% vs a
    // 79¢ book → +20pp "edge" → STRONG in edge_alerts. Bitcoin's measured
    // version of the same disease: claimed 0.794, realized 0.481.
    //
    // Graduated tier ceiling by minutes-to-close — same mechanism as bitcoin's,
    // scaled to the daily/weekly settle horizon (bitcoin is hourly, so its
    // 30/10/2 ladder would sit entirely inside the window where the Aug 28 row
    // fired). STRONG needs ≥120min (the observed T=2h failure is inside it),
    // MODERATE ≥30min, SPECULATIVE ≥5min; inside 5min every row goes PASS.
    tierCeilingByMinutes: { STRONG: 120, MODERATE: 30, SPECULATIVE: 5 },
    // Post-spread, side-aware BUY gate (mechanism: commodity-base.js
    // postSpreadSideGate). YES must clear its ask-side spread by ≥5pp
    // (MIN_EDGE_PP), or ≥10pp when yesAsk ≥70¢ (favorite band, via the default
    // yesFavorite knobs — model saturation is worst exactly where the Aug 28
    // row sat); YES under 15¢ is suppressed (longshot band). NO side stays
    // ENABLED here — unlike bitcoin, there is no adverse live NO record for
    // this engine — but at the stricter 10pp post-spread bar.
    postSpreadGate: true,
    // Net of the Kalshi fee too (§1.4, 2026-08-31). The spread was already
    // charged; a fee peaking at 1.75c on a 50c contract is most of a thin edge,
    // so a tier computed without it was never a claim about money. Published
    // counts fall by design — that is the point, and it is recorded in
    // tool_changes for each of the four surfaces.
    chargeFees: true,
    // μ = 0 (EDGE_MARKETS §2.4, 2026-08-31). The 60-day trailing drift carried
    // no information at the horizons we price and only displaced the model CDF.
    // Measured, not assumed: see the backtest note in commodity-base.js.
    // Bitcoin is NOT here — its drift path is the short-horizon momentum μ,
    // already zeroed at BTC_MU_SCALE.
    driftMuScale: 0,
    minEdgePpNoSide: 0.1,
    noSideEnabled: true,
    intradayHistory: true,
    intradayBandPct: 0.10,
  },
  oil: {
    commodity: 'oil',
    seriesTicker: 'KXWTI',
    underlyingEtf: 'USO',
    pythSymbol: 'WTI', // not used when useYahooSpot is true; kept for shape parity
    spotUnit: '$/bbl',
    spotLabel: 'Yahoo CL=F (contract-aware CLM26.NYM primary, CL=F continuous fallback)',
    enabled: true,
    // V2 cutover — see commodities.silver.useV2Cutover note.
    useV2Cutover: true,
    // USO-synthetic DISABLED 2026-05-22 (same day it shipped). Databento's
    // parity-derived USO underlyingPrice has been reporting ~$142 (real
    // USO ~$77) for days — this didn't matter while spot came from Yahoo
    // CL=F because the bad number only affected IV-smile relative
    // moneyness. Once the synthetic path treated that USO as truth and
    // multiplied by wti_per_uso, every WTI snapshot ran ~15% high
    // ($111.62 vs Kalshi-implied $98), producing fake +20-50pp BUY YES
    // signals across all in-money strikes. Do NOT re-enable until
    // deriveEtfSpotByParity in feeds/databento.js returns ~real USO.
    // Tracking: handoffs/OIL_USO_SYNTHETIC_DISABLE_2026-05-22.md
    useUsoSynthetic: false,
    // NEW PRIMARY 2026-08-27: Pyth front-month WTI future, read free off Pythnet
    // (src/feeds/pythnet.js). KXWTI settles on the ICE WTI front-month, and Pyth
    // publishes exactly that contract, auto-rolling by expiry — so this tracks the
    // settled instrument instead of a 15-min-delayed continuous scrape, and needs
    // no contract-aware rollover hack. Kalshi settles the sibling KXWTI15M series
    // on Pyth WTI, and an earlier in-repo study put it at 99.5% verdict agreement
    // with the front month (src/engine/metals-15m.js header).
    //
    // Why this became worth doing now: oil had been running on the THIRD rung of a
    // three-rung ladder for at least 3 weeks — 900/900 rows `yahoo_cl_f`, with
    // rung 1 (USO-synthetic) deliberately disabled and rung 2 (contract-aware
    // Yahoo, which writes its own `yahoo_<contract>_nym` source) producing nothing.
    // Yahoo also flaps past its 17-min staleness threshold, which is what made
    // /health report unhealthy.
    //
    // ⚠️ Still a PROXY. KXWTI settles on ICE and we do not have ICE. This is a
    // better proxy, not the settlement source — do not describe it as one.
    // Yahoo stays wired below as fallback; set this false to revert in one line.
    usePythWtiSpot: true,
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
    // Intraday history retention — see commodities.silver.intradayHistory.
    // --- Containment kit ported from bitcoin (EDGE_MARKETS §1.1, 2026-08-31) ---
    // Metals/oil shipped raw probAboveStrikePhysical with none of bitcoin's
    // post-incident guards. Observed live 2026-08-28: at T=2h, gold σ_blend
    // ≈0.14 → σ√τ ≈0.21%; a strike 0.5% OTM prints d₂=2.37 → model 99.1% vs a
    // 79¢ book → +20pp "edge" → STRONG in edge_alerts. Bitcoin's measured
    // version of the same disease: claimed 0.794, realized 0.481.
    //
    // Graduated tier ceiling by minutes-to-close — same mechanism as bitcoin's,
    // scaled to the daily/weekly settle horizon (bitcoin is hourly, so its
    // 30/10/2 ladder would sit entirely inside the window where the Aug 28 row
    // fired). STRONG needs ≥120min (the observed T=2h failure is inside it),
    // MODERATE ≥30min, SPECULATIVE ≥5min; inside 5min every row goes PASS.
    tierCeilingByMinutes: { STRONG: 120, MODERATE: 30, SPECULATIVE: 5 },
    // Post-spread, side-aware BUY gate (mechanism: commodity-base.js
    // postSpreadSideGate). YES must clear its ask-side spread by ≥5pp
    // (MIN_EDGE_PP), or ≥10pp when yesAsk ≥70¢ (favorite band, via the default
    // yesFavorite knobs — model saturation is worst exactly where the Aug 28
    // row sat); YES under 15¢ is suppressed (longshot band). NO side stays
    // ENABLED here — unlike bitcoin, there is no adverse live NO record for
    // this engine — but at the stricter 10pp post-spread bar.
    postSpreadGate: true,
    // Net of the Kalshi fee too (§1.4, 2026-08-31). The spread was already
    // charged; a fee peaking at 1.75c on a 50c contract is most of a thin edge,
    // so a tier computed without it was never a claim about money. Published
    // counts fall by design — that is the point, and it is recorded in
    // tool_changes for each of the four surfaces.
    chargeFees: true,
    // μ = 0 (EDGE_MARKETS §2.4, 2026-08-31). The 60-day trailing drift carried
    // no information at the horizons we price and only displaced the model CDF.
    // Measured, not assumed: see the backtest note in commodity-base.js.
    // Bitcoin is NOT here — its drift path is the short-horizon momentum μ,
    // already zeroed at BTC_MU_SCALE.
    driftMuScale: 0,
    minEdgePpNoSide: 0.1,
    noSideEnabled: true,
    intradayHistory: true,
    intradayBandPct: 0.10,
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
    // ⚠️ RETAINED FOR REFERENCE ONLY — bitcoin no longer reads Pyth. See
    // useBrtiSpot below. Left in place because kalshi-event.js and the docs
    // still describe the symbol, and deleting it makes the diff read as if the
    // symbol were wrong rather than unused.
    pythSymbol: 'BTC/USD',
    spotUnit: '$/BTC',
    spotLabel: 'BRTI constituent basket',
    // Spot comes from the free BRTI-constituent basket (Coinbase, Kraken,
    // Bitstamp, Gemini), NOT Pyth. Kalshi settles KXBTCD on the CF Benchmarks
    // BRTI, which is COMPUTED from those exchanges — so this is a step toward
    // the settlement number, not away from it. Pyth was always a proxy, and as
    // of the 2026-08-26 Core upgrade it is also a paid one.
    // ⛔ Do NOT set this on silver/gold: Kalshi settles those on Pyth itself.
    useBrtiSpot: true,
    enabled: true,
    // V2 cutover ON (2026-07-27). The 05-21 "drift <=0.15pp at hourly T"
    // rationale was written for the +/-3.0-capped 60d drift — true but moot:
    // the TWAP path's mu is the SHORT-HORIZON Pyth-buffer momentum (see
    // resolveTwapMu in commodity-base.js), raw and horizon-capped. Zero-mu
    // risk-neutral kept printing fade-the-trend BUY NOs on trend days
    // (0-fers 7/7, 7/14, 7/24, 7/27; post-7/21 NO picks 1-for-15 live).
    // Replay on 169 settled picks 6/29-7/27: kept-pick hit 49%->64%
    // (72% YES-only), ROI positive in BOTH halves of the window. Full
    // methodology + rollback: handoffs/BITCOIN_V2_CUTOVER_2026-07-27.md.
    useV2Cutover: true,
    // Momentum shrinkage lambda + annualized cap for the TWAP-path physical mu.
    // V2.2 (2026-08-13): 0.4 -> 0. Momentum is OFF — the drift term only ever
    // displaced the CDF, never informed it. The +/-12 cap BOUND on 57% of rows
    // on a median day (99% on 8/13) with a sign that flipped daily, moving the
    // whole model distribution ~0.26 sigma; measured against the live board it
    // was ~70% of a -0.49 sigma median error. Rationale in full: thresholds.js
    // BTC_MU_SCALE. Cap kept but inert (0 x anything is 0).
    // Env-free config so a tune stays a one-line diff + redeploy.
    shortHorizonMuScale: 0,
    shortHorizonMuCapAnnual: 12,
    // FRED skip: no daily BTC spot series on FRED; CF Benchmarks BRTI
    // (Kalshi's settlement source) isn't on FRED either. The Massive-style
    // cross-check that protects oil from a frozen CL=F print doesn't apply
    // when Pyth itself is the canonical real-time feed.
    fredSeriesId: null,
    // Spot is Pyth (sub-second publishes); 5 min without a tick means the feed
    // is dead, not quiet. Demotes tier — see commodity-base.js staleness gate.
    // This is the direct instrument the FRED cross-check above could never be
    // for BTC, since no daily BTC series exists on FRED to compare against.
    maxSpotAgeMs: 5 * 60 * 1000,
    // 15s atomic full-pass cadence (2026-06-10 BITCOIN_EDGE_STRIKE_BAND handoff).
    // Both market and burst windows run at 15s so the whole market window is
    // 15s — burst (60min pre-close) must not be slower than the market cadence.
    // The pass is one Kalshi HTTP call + two in-memory reads (Databento sidecar
    // chain, Pyth spot), so 4 Kalshi req/min is the only added network cost —
    // trivially within the public API budget, and Databento has no per-request
    // cost (streaming sidecar). Off-hours stays slow (engine pauses writes).
    snapshotIntervalMarketMs: BTC_SNAPSHOT_INTERVAL_MARKET_MS,
    snapshotIntervalOffMs: SNAPSHOT_INTERVAL_OFF_MS,
    snapshotIntervalExpirationMs: BTC_SNAPSHOT_INTERVAL_MARKET_MS,
    // Strike band: persist/evaluate only strikes within ±6% of spot OR with a
    // live two-sided book (union). Drops the ~85% dead-row ladder that ±15%
    // produced on the hourly $100-spaced KXBTCD chain. Applied at persist time
    // in commodity-base.js — skipped strikes write no row at all.
    strikeBandPct: BTC_STRIKE_BAND_PCT,
    // WATCH tier: 3-5pp directional leans surface as confidence='watch' (not a
    // BUY). Keeps the public board alive in calm hours without faking signals.
    watchTierEnabled: true,
    // Post-spread, side-aware BUY gate (BITCOIN_EDGE_NO_SIDE_FIX_2026-06-16).
    // bitcoin-only. When true, the BUY gate charges each side its actual ask-side
    // spread off the live Kalshi book instead of comparing |edge| to one symmetric
    // threshold: YES needs chosenProb - yesAsk >= MIN_EDGE_PP; NO needs
    // yesBid - chosenProb >= minEdgePpNoSide. confidence/tier magnitude is then
    // driven off the NET side edge so spread cost shows up in the tier too. Rows
    // that clear MIN_EDGE_PP gross but fail their side's net floor go PASS/low.
    // Silver/gold/oil leave postSpreadGate unset -> byte-identical symmetric path.
    postSpreadGate: true,
    // Net of the Kalshi fee too (§1.4, 2026-08-31). The spread was already
    // charged; a fee peaking at 1.75c on a 50c contract is most of a thin edge,
    // so a tier computed without it was never a claim about money. Published
    // counts fall by design — that is the point, and it is recorded in
    // tool_changes for each of the four surfaces.
    chargeFees: true,
    minEdgePpNoSide: 0.1, // NO-side post-spread floor (moot while noSideEnabled=false)
    // NO side OFF (2026-07-27): the NO side is where the model error pools.
    // Live: post-7/21 NO picks went 1-for-15; every bot NO fill 7/24+7/27
    // lost 100%. Replay: kept-NO hit <=14% under EVERY mu variant including
    // v2 — there is no lambda that rescues it. Re-enable only with a fresh
    // calibration study showing NO-side edge is real (see cutover handoff).
    //
    // ⚠️ pmp-btc-bot NO LONGER DEPENDS ON THIS (2026-08-25). Setting this false on
    // 2026-07-27 silently disabled a trading structure in a different service: the
    // bot read its tradeable side from `direction`, so it could not build a NO leg,
    // so its pairing engine formed ZERO pairs for 11 days after shipping. The bot
    // now derives both sides locally from the book (pmp-btc-bot src/strategy.js
    // deriveSide()) and treats every NO leg as hedge-only. Do NOT flip this to true
    // believing it is how execution gets its NO side — it is not, and flipping it
    // would republish outright BUY NO on /tools/bitcoin-edge, where the NO record
    // is still unproven and exactly what this flag was set false to stop.
    noSideEnabled: false,
    // YES-side favorite floor (TOOL_RECALIBRATION_ROUND2_2026-07-21). YES BUYs at
    // yesAsk >= yesFavoritePrice must clear minEdgePpYesFavorite (10pp) instead of
    // the 5pp mid-band floor — the 85-92c model-saturation artifact (model 89.8%
    // vs realized 75.7%, n=37). YES BUYs under 15c are suppressed outright (longshot).
    yesFavoritePrice: 0.70,
    minEdgePpYesFavorite: 0.10,
    yesFavoriteEnabled: true, // kill switch: set false to revert to the symmetric YES floor without a redeploy
    // OPRA closes at 4pm ET. IBIT chain stops updating overnight even
    // though BTC spot keeps moving on 24/7 venues — running edge math
    // against a frozen IV smile + a moving Pyth spot would surface
    // basis-mismatch artifacts, not real edges. Burst window (60min
    // pre-close) still fires so the engine captures the final hour of
    // pre-settlement action. Pairs with requiredOffHours:false on the
    // databento_ibit readiness gate.
    pauseSnapshotsOffHours: true,
    // TWAP-aware probability model + Pyth-tick-grounded σ/μ (final form,
    // 2026-05-22). Two compounding fixes layered on top of standard BS:
    //
    //   1. Settlement is an average, not a point. probAboveTwap integrates
    //      the geometric-average variance σ²(T - 2τ/3) and drift period
    //      (T - τ/2). Tiny correction at τ << T but non-zero, and the
    //      math collapses gracefully near the averaging window instead of
    //      blowing up.
    //   2. σ and μ come from a 15-min Pyth tick buffer
    //      (src/engine/short-horizon-vol.js) — not from the IBIT IV smile
    //      (calibrated to weekly+ expiries; under-represents BTC's sub-hour
    //      realized vol by 2-3×) and not from the 60-day annualized drift
    //      (too slow to see intra-hour momentum). When the buffer is cold
    //      (first ~5 min after a Fly redeploy), the engine falls back to
    //      σ × shortHorizonVolScale and tags rows quality_flag='cold_buffer'.
    twapWindowSeconds: 60,
    useShortHorizonRv: true,
    shortHorizonLookbackMin: 15,
    shortHorizonVolScale: 3.5,        // cold-buffer fallback only
    shortHorizonVolCapHours: 1,
    // Graduated tier ceiling by minutes-to-close. Encodes calibration
    // realism: even with a better σ + μ, the engine's binary prob is less
    // reliable than Kalshi's order-flow-aware price as T shrinks. STRONG
    // requires ≥30min, MODERATE requires ≥10min, SPECULATIVE requires
    // ≥2min. Inside the 2-min averaging window, every row goes PASS with
    // quality_flag='twap_settle_window'. Replaces the old hard
    // minMinutesToClose guard.
    tierCeilingByMinutes: { STRONG: 30, MODERATE: 10, SPECULATIVE: 2 },
    // Event-level Spearman correlation between engine prob and Kalshi
    // prob across strikes. corr < 0.5 suppresses every row in the event;
    // 0.5 ≤ corr < 0.7 demotes each tier one notch. Catches "the engine's
    // surface doesn't even look like the market's" — fundamental model
    // failure for the event, not a tradeable edge.
    smileKalshiCorrCheck: true,
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
    // Spot is Pyth (sub-second publishes); 5 min without a tick means the feed
    // is dead, not quiet. Demotes tier — see commodity-base.js staleness gate.
    maxSpotAgeMs: 5 * 60 * 1000,
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
