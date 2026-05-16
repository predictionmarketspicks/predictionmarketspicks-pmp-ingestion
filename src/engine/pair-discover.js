// Pair-discover engine — nightly LLM-confirmed candidate-pair sweep.
//
// Spec: handoffs/ARB_SCANNER_SWING4_FINISH_2026-05-15.md §4c.
// What it does:
//   1. Loads market_pairs rows we've already seen (active OR llm_proposed) and
//      builds a "seen" set keyed by anchor_id|mirror_id.
//   2. Pulls Kalshi political/economic/fed candidates via the existing
//      feeds/movers.js watchlist (filtered to those three categories — Sports
//      KXNBAGAME, Crypto, Weather, Entertainment intentionally excluded).
//   3. Pulls Polymarket markets via feeds/polymarket-gamma.js fetchTopMarkets,
//      then narrows to allowlist tags that overlap our three categories.
//   4. For each Kalshi market, scores the top-3 Polymarket candidates with the
//      shared matchTitles tokenizer (engine/lib/match.js). Score floor 0.25.
//   5. Skips anything already in the seen set, then chunks the survivors and
//      hands them to llm-pair-confirm (Haiku → Sonnet two-pass).
//   6. Upserts verdicts with match !== 'none' as source='llm_proposed',
//      active=false. Approved rows (active=true) are NEVER demoted by this
//      run — they are filtered out of the upsert payload before the call.
//
// Cadence: once per 24h. The run loop in src/index.js calls runPairDiscoverOnce
// inside a fast-path setTimeout, and `lastRunAt` short-circuits anything that
// fires sooner than MIN_INTERVAL_MS.
//
// Cost: capped via the cost ceiling in llm-pair-confirm. With ~150 Kalshi
// candidates × top-3 Poly each, after seen-dedup and the 0.25 score floor we
// typically send 30–80 pairs to the LLM. At Haiku rates that's well under
// $0.50/run.

import { fetchKalshiCandidates } from '../feeds/movers.js';
import { fetchTopMarkets } from '../feeds/polymarket-gamma.js';
import { getClient } from '../delivery/supabase.js';
import { matchTitles } from './lib/match.js';
import { confirmPairsTwoPass } from './llm-pair-confirm.js';
import { recordTick, registerFeed } from '../observability/health.js';

const MIN_INTERVAL_MS = Number(process.env.PAIR_DISCOVER_INTERVAL_MS || 24 * 60 * 60 * 1000);

// Hard cap on how many candidates we will LLM-confirm in a single run. Keeps
// cost predictable even if the Kalshi/Poly feeds spike. handoff §4c says 50.
const MAX_LLM_CONFIRMATIONS_PER_RUN = Number(process.env.PAIR_DISCOVER_MAX_LLM || 50);

// Minimum tokenizer score for a Kalshi×Poly pair to be worth confirming.
// 0.25 = ~3-token overlap on a 12-token title — keeps obvious noise out
// without throwing away the "Trump 2028" / "Trump nominee 2028" near-matches
// that justify the LLM step.
const MATCH_SCORE_FLOOR = 0.25;

// Top-N Polymarket candidates considered per Kalshi market. Higher = more
// LLM cost; 3 is enough to surface the right candidate in practice.
const POLY_PER_KALSHI = 3;

// Category bridges:
//   - Kalshi feeds/movers.js KALSHI_SERIES carries Economics, Politics. We
//     map both to a single side of the join.
//   - Polymarket gamma tags carry politics + us-election-2028 + economy +
//     fed-rate. The Kalshi side picks one category to write into the row —
//     we use the Kalshi watchlist's category since the anchor is Kalshi.
const KALSHI_CATEGORY_MAP = {
  Politics: 'political',
  Economics: 'economic',
};
const POLY_TAG_BRIDGE = ['politics', 'us-election-2028', 'economy', 'fed-rate'];

registerFeed('pair_discover_engine');

const state = {
  runs: 0,
  proposed: 0,
  seenSkipped: 0,
  rejectedNone: 0,
  lastRunAt: null,
  lastErrorAt: null,
  lastError: null,
  lastCostUsd: 0,
  lastVerdictBreakdown: null,
};

let stopRequested = false;

// Map a Kalshi movers candidate into the shape we feed to the LLM.
function asKalshiSide(c) {
  return {
    ticker: c.ticker,
    title: c.title,
    category: c.category,
    target_category: KALSHI_CATEGORY_MAP[c.category] || null,
    yes_price: c.yes_price,
    volume_24h: c.volume_24h,
  };
}

// Map a Polymarket Gamma row into the same.
function asPolySide(m) {
  return {
    condition_id: m.condition_id,
    slug: m.slug,
    question: m.question,
    category: m.category,
    volume_24h_usdc: m.volume_24h_usdc,
  };
}

// Load previously-seen pairs so the agent doesn't re-confirm them every night.
async function loadSeenPairKeys() {
  const sb = getClient();
  const { data, error } = await sb
    .from('market_pairs')
    .select('anchor_platform, anchor_id, mirror_platform, mirror_id, active, source');
  if (error) throw new Error(`market_pairs read: ${error.message}`);
  const seen = new Set();
  const approvedActive = new Set();
  for (const r of data ?? []) {
    const key = `${r.anchor_platform}|${r.anchor_id}|${r.mirror_platform}|${r.mirror_id}`;
    seen.add(key);
    if (r.active === true) approvedActive.add(key);
  }
  return { seen, approvedActive };
}

// Score Kalshi×Poly candidates and surface the top-N Poly matches per Kalshi
// market. Drops pairs below MATCH_SCORE_FLOOR and pairs we've already seen.
function buildCandidates(kalshiSide, polySide, seen) {
  const candidates = [];
  for (const k of kalshiSide) {
    const scored = [];
    for (const p of polySide) {
      // Cross-platform category screen: only pair Kalshi Politics rows with
      // Poly politics tags, Kalshi Economics with Poly economy/fed-rate.
      const polyTagOk =
        (k.category === 'Politics' && (p.category === 'politics' || p.category === 'us-election-2028')) ||
        (k.category === 'Economics' && (p.category === 'economy' || p.category === 'fed-rate'));
      if (!polyTagOk) continue;
      const score = matchTitles(k.title, p.question || '');
      if (score < MATCH_SCORE_FLOOR) continue;
      scored.push({ score, k, p });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const item of scored.slice(0, POLY_PER_KALSHI)) {
      const key = `kalshi|${item.k.ticker}|polymarket|${item.p.condition_id}`;
      if (seen.has(key)) continue;
      candidates.push({
        kalshi: item.k,
        polymarket: item.p,
        score: item.score,
        key,
      });
    }
  }
  return candidates;
}

function buildPairRow({ candidate, verdict }) {
  const category = candidate.kalshi.target_category;
  return {
    anchor_platform: 'kalshi',
    anchor_id: candidate.kalshi.ticker,
    mirror_platform: 'polymarket',
    mirror_id: candidate.polymarket.condition_id,
    mirror_slug: candidate.polymarket.slug || null,
    race_label: candidate.kalshi.title.slice(0, 200),
    category,
    resolution_match: verdict.match,
    confidence: Number(verdict.confidence.toFixed(2)),
    resolution_notes: `[${verdict._model}] ${verdict.reason}`.slice(0, 480),
    source: 'llm_proposed',
    active: false,
  };
}

async function upsertProposed(rows, approvedActive) {
  if (rows.length === 0) return { written: 0 };
  // Idempotency guard — drop any row whose unique key matches an approved
  // active=true pair. The DB's UNIQUE constraint would also catch this on
  // INSERT...ON CONFLICT, but explicit filtering keeps the upsert payload
  // honest in logs and avoids touching approved metadata accidentally.
  const safe = rows.filter((r) => {
    const key = `${r.anchor_platform}|${r.anchor_id}|${r.mirror_platform}|${r.mirror_id}`;
    return !approvedActive.has(key);
  });
  if (safe.length === 0) return { written: 0, droppedApprovedClash: rows.length };
  const sb = getClient();
  const { data, error } = await sb
    .from('market_pairs')
    .upsert(safe, {
      onConflict: 'anchor_platform,anchor_id,mirror_platform,mirror_id',
      ignoreDuplicates: false,
    })
    .select('id');
  if (error) throw new Error(`market_pairs upsert: ${error.message}`);
  return { written: data?.length ?? 0, droppedApprovedClash: rows.length - safe.length };
}

export async function runPairDiscoverOnce({ force = false } = {}) {
  const now = Date.now();
  if (!force && state.lastRunAt) {
    const sinceMs = now - new Date(state.lastRunAt).getTime();
    if (sinceMs < MIN_INTERVAL_MS) {
      return {
        skipped: true,
        reason: `last run ${Math.round(sinceMs / 60000)}m ago < ${Math.round(MIN_INTERVAL_MS / 60000)}m`,
      };
    }
  }
  state.runs += 1;
  state.lastRunAt = new Date(now).toISOString();
  state.lastError = null;
  state.lastErrorAt = null;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    state.lastError = 'ANTHROPIC_API_KEY missing';
    state.lastErrorAt = state.lastRunAt;
    console.warn('[pair-discover] ANTHROPIC_API_KEY missing — skipping run');
    return { skipped: true, reason: 'no_api_key' };
  }

  try {
    // 1. Load existing pairs and dedup keys.
    const { seen, approvedActive } = await loadSeenPairKeys();

    // 2. Fetch both sides.
    const [kalshiAll, polyAll] = await Promise.all([
      fetchKalshiCandidates({ timeoutMs: 30_000 }),
      fetchTopMarkets({ limit: 200, timeoutMs: 30_000 }),
    ]);

    const kalshiSide = kalshiAll
      .filter((c) => c.source === 'kalshi')
      .filter((c) => KALSHI_CATEGORY_MAP[c.category])
      .map(asKalshiSide);

    const polySide = polyAll
      .filter((m) => m.category && POLY_TAG_BRIDGE.includes(m.category))
      .map(asPolySide);

    console.log(
      `[pair-discover] candidates: ${kalshiSide.length} Kalshi × ${polySide.length} Poly (seen=${seen.size})`,
    );

    // 3. Score + dedup + cap.
    const allCandidates = buildCandidates(kalshiSide, polySide, seen);
    state.seenSkipped += Math.max(0, (kalshiSide.length * POLY_PER_KALSHI) - allCandidates.length);
    if (allCandidates.length === 0) {
      console.log('[pair-discover] no new candidates after match-floor + seen dedup');
      recordTick('pair_discover_engine');
      return {
        runs: state.runs,
        kalshiCandidates: kalshiSide.length,
        polyCandidates: polySide.length,
        scored: 0,
        proposed: 0,
        costUsd: 0,
      };
    }

    // Sort by score desc, keep top N — the most-likely matches go first so
    // the cost ceiling abort still lands the best candidates if we trip it.
    allCandidates.sort((a, b) => b.score - a.score);
    const capped = allCandidates.slice(0, MAX_LLM_CONFIRMATIONS_PER_RUN);
    console.log(
      `[pair-discover] scored ${allCandidates.length} candidates → sending ${capped.length} to LLM`,
    );

    // 4. LLM two-pass.
    const result = await confirmPairsTwoPass(capped, {
      apiKey,
      chunkSize: 10,
      sonnetBandLow: 0.6,
      sonnetBandHigh: 0.85,
      costCeilingUsd: Number(process.env.PAIR_DISCOVER_COST_CEILING_USD || 0.5),
    });
    state.lastCostUsd = result.costUsd;
    state.lastVerdictBreakdown = result.model_breakdown;

    // 5. Filter to keepers and upsert.
    const rows = [];
    let rejectedNone = 0;
    for (let i = 0; i < result.verdicts.length; i++) {
      const v = result.verdicts[i];
      const candidate = capped[result.indices[i]];
      if (!candidate) continue;
      if (v.match === 'none') { rejectedNone += 1; continue; }
      rows.push(buildPairRow({ candidate, verdict: v }));
    }
    state.rejectedNone += rejectedNone;

    const { written, droppedApprovedClash = 0 } = await upsertProposed(rows, approvedActive);
    state.proposed += written;
    recordTick('pair_discover_engine');

    const log = [
      `[pair-discover] run #${state.runs} done`,
      `kalshi=${kalshiSide.length} poly=${polySide.length} scored=${allCandidates.length}`,
      `sent=${capped.length} keepers=${rows.length} written=${written} rejected_none=${rejectedNone}`,
      `dropped_approved_clash=${droppedApprovedClash} cost=$${result.costUsd.toFixed(4)}`,
      `haiku=${result.model_breakdown.haiku} sonnet=${result.model_breakdown.sonnet} aborted=${result.aborted}`,
    ].join(' · ');
    console.log(log);

    return {
      runs: state.runs,
      kalshiCandidates: kalshiSide.length,
      polyCandidates: polySide.length,
      scored: allCandidates.length,
      sent: capped.length,
      keepers: rows.length,
      written,
      droppedApprovedClash,
      rejectedNone,
      costUsd: result.costUsd,
      aborted: result.aborted,
      modelBreakdown: result.model_breakdown,
    };
  } catch (err) {
    state.lastErrorAt = new Date().toISOString();
    state.lastError = (err?.message || String(err)).slice(0, 240);
    console.error('[pair-discover] run failed', err?.message || err);
    throw err;
  }
}

function schedulePairDiscover() {
  if (stopRequested) return;
  // Wake every hour and let runPairDiscoverOnce decide whether to actually
  // fire based on lastRunAt + MIN_INTERVAL_MS. This is cheap and tolerates
  // process restarts mid-day without skipping the daily window.
  setTimeout(async () => {
    try {
      const result = await runPairDiscoverOnce();
      if (result?.skipped) {
        // Quiet path — the day hasn't elapsed yet.
      }
    } catch {
      /* runPairDiscoverOnce already logged */
    }
    schedulePairDiscover();
  }, 60 * 60 * 1000);
}

export function bootstrapPairDiscover() {
  // Wait 60s after process start so the rest of the engine settles before
  // the first Kalshi/Poly REST burst. On a fresh boot this will run the first
  // sweep immediately (lastRunAt is null), then quiet down to the 24h cadence.
  setTimeout(() => {
    runPairDiscoverOnce().catch(() => {});
    schedulePairDiscover();
  }, 60_000);
}

export function stopPairDiscover() {
  stopRequested = true;
}

export function getPairDiscoverState() {
  return {
    runs: state.runs,
    proposed: state.proposed,
    seenSkipped: state.seenSkipped,
    rejectedNone: state.rejectedNone,
    lastRunAt: state.lastRunAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
    lastCostUsd: state.lastCostUsd,
    lastVerdictBreakdown: state.lastVerdictBreakdown,
    minIntervalMs: MIN_INTERVAL_MS,
  };
}
