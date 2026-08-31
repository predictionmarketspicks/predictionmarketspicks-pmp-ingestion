#!/usr/bin/env node
// Fit a pooled Platt calibration map for bitcoin-edge from our own settled record.
// handoffs/BITCOIN_EDGE_V21_CALIBRATED_RELAUNCH_2026-08-05.md §4.1
//
// Usage:
//   node scripts/fit-btc-calibration.js            # fit + write a shadow row
//   node scripts/fit-btc-calibration.js --dry-run  # fit + print, write nothing
//
// No axios (banned repo-wide). Uses the engine's existing supabase-js client.
//
// WHAT IT FITS
// ------------
// Every settled bitcoin-edge pick is YES-side and stores predicted_prob =
// model P(YES) and market_price_at_pick = market P(YES), so this is a single-
// basis problem: map model P(YES) -> calibrated P(YES) against the realized
// YES outcome. We fit
//     p_cal = sigmoid(a * logit(p_model) + b)
// by Newton-Raphson on the log-loss, then shrink (a,b) toward the identity map
// (1,0) so a thin sample cannot produce a violent correction.
//
// SHRINKAGE USES EFFECTIVE SAMPLE SIZE, NOT ROW COUNT
// ---------------------------------------------------
// The plan says lambda = n/(n+100). It does not say which n, and the
// difference is large: the pre-reset era is 81 picks across only 18 distinct
// hourly events (~4.5 near-perfectly correlated strikes per ladder — the same
// double-counting PR B's mint gate just closed). Treating those as 81
// independent observations would overstate our confidence by ~4.5x, which is
// the precise error that produced this whole incident. We use n_events.
// Both counts are stored; the schema carries n_samples AND n_events.
//
// THE MAP IS FITTED ON THE OLD MODEL
// ----------------------------------
// The only settled data available describes the PRE-shrink engine (mu 1.0/50).
// The new engine (0.4/12) produces a differently-distributed prob, so this map
// is expected to over-correct it. That is exactly why the row is written
// shadow/inactive: promotion is gated on OUT-OF-SAMPLE Brier over the new era
// (see promote-btc-calibration.js). Never promote on the fit-window numbers
// below — brier_cal is in-sample and is fitted to beat brier_raw by
// construction, so it is not evidence of anything.

import { getClient } from '../src/delivery/supabase.js';
import { logit, sigmoid } from '../src/engine/calibration.js';
import { sanitize } from '../src/lib/sanitize.js';

const BOT_LOGS_CHANNEL_ID = '1487857846111567952';

// Alert on fit failure or Brier regression (§4.4). Never throws — a Discord
// outage must not fail the refit.
async function postBotLog(content) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[calib] DISCORD_BOT_TOKEN not set — skipping Discord notification');
    return;
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${BOT_LOGS_CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: sanitize(content, 1900),
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn(`[calib] discord ${res.status}`);
  } catch (err) {
    console.warn(`[calib] discord post failed: ${err?.message || err}`);
  }
}

// ── Commodity/slug selection (EDGE_MARKETS §1.1, 2026-08-31) ─────────────────
// Was hardcoded to bitcoin. Metals and oil now sit under the same tier ceiling
// (src/delivery/tier-ceiling.js), and a ceiling only lifts when that
// commodity's OWN map is active — so both scripts must be runnable per
// commodity or gold/silver can never be promoted out of the cap.
//
// Defaults are unchanged (bitcoin), so every existing invocation and cron line
// behaves exactly as before. Fitting is safe to run; PROMOTION stays manual and
// gated on out-of-sample Brier (§9 governance) — this only chooses the target.
//   node scripts/{script} --commodity gold [--tool-slug gold-edge]
const argValue = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : null;
};
const COMMODITY = (argValue('commodity') || 'bitcoin').toLowerCase();
// Slug convention is `<commodity>-edge` across the tool registry; override only
// if a surface ever breaks it.
const TOOL_SLUG = argValue('tool-slug') || `${COMMODITY}-edge`;
const MODEL_VERSION = 'v2_physical';
const SHRINK_PRIOR = 100; // lambda = n_eff / (n_eff + 100)
const MIN_EVENTS = 8; // below this a 2-parameter fit is not worth writing

function brier(ps, ys) {
  let s = 0;
  for (let i = 0; i < ps.length; i += 1) s += (ps[i] - ys[i]) ** 2;
  return s / ps.length;
}

// log(1 + e^x), overflow-safe.
function softplus(x) {
  return x > 30 ? x : Math.log1p(Math.exp(x));
}

// Damped Newton for 2-parameter logistic regression on z = logit(p_model).
//
// Two things here are load-bearing; a plain Newton loop diverges on this data
// and the first version of this script did (a -> 9e7 on the era-C sample):
//
// 1. PLATT'S SOFT TARGETS (Platt 1999; Lin, Lin & Weng 2007). Fitting to hard
//    0/1 labels pushes the optimum toward infinity whenever the sample is
//    separable or nearly so. Targets of (N+ + 1)/(N+ + 2) and 1/(N- + 2) keep
//    the optimum finite and are the standard fix. Brier is still scored
//    against the TRUE 0/1 outcomes afterwards.
// 2. BACKTRACKING LINE SEARCH. Once an iterate saturates, p(1-p) -> 0, the
//    Hessian goes near-singular and the undamped step explodes. Halving the
//    step until the objective actually decreases makes each iteration a
//    guaranteed improvement and bounds the whole run.
function fitPlatt(z, y, { maxIter = 200, ridge = 1e-4, tol = 1e-9 } = {}) {
  const nPos = y.reduce((s, v) => s + v, 0);
  const nNeg = y.length - nPos;
  const hiT = (nPos + 1) / (nPos + 2);
  const loT = 1 / (nNeg + 2);
  const t = y.map((v) => (v === 1 ? hiT : loT));

  // NLL = softplus(-f) + (1 - t) * f, plus a ridge pulling toward identity.
  const objective = (aa, bb) => {
    let s = 0;
    for (let i = 0; i < z.length; i += 1) {
      const f = aa * z[i] + bb;
      s += softplus(-f) + (1 - t[i]) * f;
    }
    return s / z.length + 0.5 * ridge * ((aa - 1) ** 2 + bb ** 2);
  };

  let a = 1;
  let b = 0;
  let fCur = objective(a, b);

  for (let iter = 0; iter < maxIter; iter += 1) {
    let g0 = ridge * (a - 1);
    let g1 = ridge * b;
    let h00 = ridge;
    let h01 = 0;
    let h11 = ridge;
    for (let i = 0; i < z.length; i += 1) {
      const p = sigmoid(a * z[i] + b);
      const r = p - t[i];
      const w = Math.max(p * (1 - p), 1e-10);
      g0 += (r * z[i]) / z.length;
      g1 += r / z.length;
      h00 += (w * z[i] * z[i]) / z.length;
      h01 += (w * z[i]) / z.length;
      h11 += w / z.length;
    }
    const gnorm = Math.hypot(g0, g1);
    if (gnorm < tol) return { a, b, converged: true, iters: iter };

    const det = h00 * h11 - h01 * h01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-14) break;
    let da = (h11 * g0 - h01 * g1) / det;
    let db = (h00 * g1 - h01 * g0) / det;
    if (!Number.isFinite(da) || !Number.isFinite(db)) break;

    // Backtrack until the objective actually decreases.
    let step = 1;
    let improved = false;
    for (let k = 0; k < 60; k += 1) {
      const na = a - step * da;
      const nb = b - step * db;
      const fNew = objective(na, nb);
      if (Number.isFinite(fNew) && fNew < fCur) {
        a = na;
        b = nb;
        fCur = fNew;
        improved = true;
        break;
      }
      step /= 2;
    }
    if (!improved) return { a, b, converged: true, iters: iter };
  }
  return { a, b, converged: false, iters: maxIter };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sb = getClient();

  // tool_picks carries the model prob AND the market price frozen at the
  // crossing moment; tool_settles carries the outcome. Those are immutable —
  // unlike commodity_edge_signals, whose rows are updated in place all day and
  // decay to NO_EDGE (docs/lessons/readiness-probe-must-be-able-to-fail.md #13).
  const { data, error } = await sb
    .from('tool_picks')
    .select(
      'pick_id, picked_at, market_id, predicted_side, predicted_prob, market_price_at_pick, regime_tags, tool_settles!inner(resolution)',
    )
    .eq('tool_slug', TOOL_SLUG)
    .order('picked_at', { ascending: true });

  if (error) throw new Error(`read settled picks: ${error.message}`);

  const rows = (data ?? []).filter((r) => r.regime_tags?.model_version === MODEL_VERSION);

  const pModel = [];
  const pMarket = [];
  const y = [];
  const events = new Set();
  let firstAt = null;
  let lastAt = null;

  for (const r of rows) {
    const res = r.tool_settles?.resolution ?? r.tool_settles?.[0]?.resolution;
    if (res !== 'won' && res !== 'lost') continue;
    const pm = Number(r.predicted_prob);
    const mk = Number(r.market_price_at_pick);
    if (!Number.isFinite(pm) || pm <= 0 || pm >= 1) continue;
    if (!Number.isFinite(mk)) continue;
    // predicted_prob and market_price_at_pick are both P(YES); every v2 pick is
    // YES-side. Guard anyway so a future NO pick can't silently invert the fit.
    if (r.predicted_side !== 'YES') continue;
    pModel.push(pm);
    pMarket.push(mk);
    y.push(res === 'won' ? 1 : 0);
    events.add(r.market_id);
    firstAt = firstAt ?? r.picked_at;
    lastAt = r.picked_at;
  }

  const nSamples = pModel.length;
  const nEvents = events.size;
  if (nEvents < MIN_EVENTS) {
    console.error(`refusing to fit: only ${nEvents} distinct events (need >= ${MIN_EVENTS})`);
    process.exit(1);
  }

  const z = pModel.map(logit);
  const raw = fitPlatt(z, y);

  // Shrink toward identity (a=1, b=0) using EFFECTIVE sample size.
  const lambda = nEvents / (nEvents + SHRINK_PRIOR);
  const a = lambda * raw.a + (1 - lambda) * 1;
  const b = lambda * raw.b + (1 - lambda) * 0;

  const pCal = pModel.map((p) => sigmoid(a * logit(p) + b));

  const brierRaw = brier(pModel, y);
  const brierCal = brier(pCal, y);
  const brierMarket = brier(pMarket, y);
  const realized = y.reduce((s, v) => s + v, 0) / y.length;

  const knots = {
    a,
    b,
    a_raw: raw.a,
    b_raw: raw.b,
    lambda,
    converged: raw.converged,
    n_effective: nEvents,
    basis: 'logit_yes',
    era: 'pre_v21_reset',
    shrink_prior: SHRINK_PRIOR,
    // Persisted so the shrinkage choice stays auditable rather than being an
    // undocumented constant someone has to re-derive later.
    shrinkage_sensitivity: null, // filled in below
  };

  const report = {
    n_samples: nSamples,
    n_events: nEvents,
    lambda: Number(lambda.toFixed(4)),
    a: Number(a.toFixed(4)),
    b: Number(b.toFixed(4)),
    a_raw: Number(raw.a.toFixed(4)),
    b_raw: Number(raw.b.toFixed(4)),
    converged: raw.converged,
    avg_claimed: Number((pModel.reduce((s, v) => s + v, 0) / nSamples).toFixed(4)),
    avg_calibrated: Number((pCal.reduce((s, v) => s + v, 0) / nSamples).toFixed(4)),
    avg_market: Number((pMarket.reduce((s, v) => s + v, 0) / nSamples).toFixed(4)),
    realized: Number(realized.toFixed(4)),
    brier_raw: Number(brierRaw.toFixed(4)),
    brier_cal_IN_SAMPLE: Number(brierCal.toFixed(4)),
    brier_market: Number(brierMarket.toFixed(4)),
    window: [firstAt, lastAt],
  };

  // Shrinkage is the single most consequential arbitrary choice in this fit, so
  // make its cost visible instead of burying it. lambda=1 is the unshrunk MLE;
  // n_samples is what the plan's literal "lambda = n/(n+100)" would give if you
  // read n as the row count. All Brier figures here are IN SAMPLE.
  const lambdaSamples = nSamples / (nSamples + SHRINK_PRIOR);
  report.shrinkage_sensitivity = [
    { basis: 'n_events (used)', lambda: Number(lambda.toFixed(4)) },
    { basis: 'n_samples', lambda: Number(lambdaSamples.toFixed(4)) },
    { basis: 'unshrunk MLE', lambda: 1 },
  ].map((row) => {
    const aa = row.lambda * raw.a + (1 - row.lambda) * 1;
    const bb = row.lambda * raw.b;
    const ps = pModel.map((p) => sigmoid(aa * logit(p) + bb));
    return {
      ...row,
      a: Number(aa.toFixed(4)),
      b: Number(bb.toFixed(4)),
      avg_calibrated: Number((ps.reduce((s, v) => s + v, 0) / ps.length).toFixed(4)),
      brier_in_sample: Number(brier(ps, y).toFixed(4)),
    };
  });

  knots.shrinkage_sensitivity = report.shrinkage_sensitivity;

  console.log(JSON.stringify(report, null, 2));

  if (brierCal >= brierRaw) {
    console.warn('[warn] calibration does not beat the raw model even IN SAMPLE — suspect fit');
  }
  if (brierCal > brierMarket + 0.01) {
    console.warn(
      `[warn] in-sample brier_cal ${brierCal.toFixed(4)} is worse than the market's ` +
        `${brierMarket.toFixed(4)}; out-of-sample will be worse still, so this map is ` +
        'very unlikely to pass the promotion gate. That is a finding, not a bug.',
    );
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written');
    return;
  }

  const { data: written, error: writeErr } = await sb
    .from('edge_calibration_maps')
    .insert({
      commodity: COMMODITY,
      method: 'platt_pooled',
      knots,
      n_samples: nSamples,
      n_events: nEvents,
      shrink_lambda: lambda,
      brier_raw: brierRaw,
      brier_cal: brierCal,
      brier_market: brierMarket,
      fit_window_start: firstAt ? firstAt.slice(0, 10) : null,
      fit_window_end: lastAt ? lastAt.slice(0, 10) : null,
      shadow: true,
      active: false,
      notes:
        `Pooled Platt on ${nSamples} settled YES picks across ${nEvents} events ` +
        `(${firstAt?.slice(0, 10)}..${lastAt?.slice(0, 10)}). Shrunk toward identity with ` +
        `lambda=n_events/(n_events+${SHRINK_PRIOR})=${lambda.toFixed(4)} — EFFECTIVE sample ` +
        'size, not row count, because a ladder contributes ~4.5 correlated rows. ' +
        'FITTED ON THE PRE-V2.1 ENGINE (mu 1.0/50): it describes the old model and is ' +
        'expected to over-correct the new one. brier_cal here is IN-SAMPLE and beats ' +
        'brier_raw by construction — it is not evidence. Promotion is gated on ' +
        'out-of-sample Brier over the post-reset era; see promote-btc-calibration.js.',
    })
    .select('id')
    .single();

  if (writeErr) throw new Error(`write map: ${writeErr.message}`);
  console.log(`\nwrote edge_calibration_maps id=${written.id} (shadow, inactive)`);

  const regression = brierCal >= brierRaw;
  const cannotMatchMarket = brierCal > brierMarket + 0.01;
  if (regression || cannotMatchMarket || !raw.converged) {
    const flags = [
      !raw.converged ? 'fit did not converge' : null,
      regression ? 'calibrated Brier does not beat raw IN SAMPLE' : null,
      cannotMatchMarket ? "calibrated Brier cannot match the market's" : null,
    ].filter(Boolean);
    await postBotLog(
      `Bitcoin calibration refit #${written.id} (shadow) — ATTENTION\n` +
        `${flags.join('; ')}\n` +
        `n=${nSamples} over ${nEvents} events | raw ${brierRaw.toFixed(4)} | ` +
        `cal ${brierCal.toFixed(4)} (in-sample) | market ${brierMarket.toFixed(4)}\n` +
        'Map stays inactive. If this persists, it is the §9 kill-criteria signal.',
    );
  }
}

main().catch(async (err) => {
  console.error(err.message);
  await postBotLog(`Bitcoin calibration refit FAILED: ${err.message}`);
  process.exit(1);
});
