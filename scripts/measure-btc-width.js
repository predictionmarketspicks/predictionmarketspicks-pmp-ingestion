#!/usr/bin/env node
// §6 acceptance test for bitcoin-edge, run over HISTORY instead of one live board.
// handoffs/BITCOIN_EDGE_MU_CAP_SATURATION_2026-08-13.md §6 / §4.2 / §10
//
//   node --env-file-if-exists=.env scripts/measure-btc-width.js [--days=8] [--min-strikes=6]
//
// The version in §6 fits ONE live snapshot off the public API, so it can only be
// run during market hours and says nothing about how the error moves with the
// horizon. This reads commodity_edge_intraday — the append-only 5-minute table
// (§10.3) — so the same fit runs across every snapshot we hold and can be broken
// out by time to close, which is what actually identifies the term at fault.
//
// ⛔ Read commodity_edge_intraday, never commodity_edge_signals, for anything
// time-series: the latter upserts on (commodity, snapshot_date, event_ticker,
// strike) and is a current-state table whose snapshot_at is just the last write
// (§10.1). Fitting it would sample only the final seconds before close.
//
// THE FIT
// -------
// Both curves are one distribution each. Under a lognormal, P(S_T > K) maps to
//   z = Phi^-1(p) = (ln(median) - ln K) / sigma
// so a probit regression of z on ln K has slope -1/sigma and recovers both the
// implied median and the implied sigma-to-close. Doing it for the market's
// kalshi_yes and for our prob_physical gives two numbers that are directly
// comparable:
//   shift  = (model median - market median) / (market median * market sigma), in sigma
//   ratio  = model sigma / market sigma
// Healthy is shift within +/-0.10 and ratio 0.95-1.05 (§6).

import { getClient } from '../src/delivery/supabase.js';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : dflt;
};
const DAYS = argOf('days', 8);
const MIN_STRIKES = argOf('min-strikes', 6);

// Acklam's inverse normal CDF — plenty for a probit regression, no dependency.
function probit(p) {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -probit(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Returns { median, sigma } or null when the points can't identify a line.
function fitLognormal(pairs) {
  const xs = [];
  const ys = [];
  for (const [K, p] of pairs) {
    // Saturated probabilities carry no slope information and blow up the probit.
    if (p == null || p <= 0.02 || p >= 0.98 || !(K > 0)) continue;
    xs.push(Math.log(K));
    ys.push(probit(p));
  }
  const n = xs.length;
  if (n < MIN_STRIKES) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0 || num === 0) return null;
  const slope = num / den;
  if (slope >= 0) return null;            // z must fall as the strike rises
  const sigma = -1 / slope;
  if (!(sigma > 0) || !Number.isFinite(sigma)) return null;
  return { median: Math.exp((my - slope * mx) * sigma), sigma, n };
}

const BUCKETS = [
  { label: '< 2 min', lo: 0, hi: 120 },
  { label: '2-5 min', lo: 120, hi: 300 },
  { label: '5-15 min', lo: 300, hi: 900 },
  { label: '15-30 min', lo: 900, hi: 1800 },
  { label: '30-45 min', lo: 1800, hi: 2700 },
  { label: '> 45 min', lo: 2700, hi: Infinity },
];

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main() {
  const sb = getClient();
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();

  // PostgREST caps every read at 1000 rows; page explicitly.
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('commodity_edge_intraday')
      .select('snapshot_at, event_ticker, event_close_at, strike, spot_price, kalshi_yes, prob_physical, options_prob, options_iv, quality_flag')
      .eq('commodity', 'bitcoin')
      .gte('snapshot_at', since)
      .order('snapshot_at', { ascending: true })
      .order('strike', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`read intraday: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  console.log(`read ${rows.length} bitcoin intraday rows since ${since.slice(0, 10)}`);

  // Group into ladders. A pass can straddle a second boundary, so key on the
  // event plus the snapshot rounded to the minute rather than the exact stamp
  // (same defect lib/tools/bitcoin-edge.ts documents in its PR 4 comment).
  const ladders = new Map();
  for (const r of rows) {
    const key = `${r.event_ticker}|${r.snapshot_at.slice(0, 16)}`;
    if (!ladders.has(key)) ladders.set(key, []);
    ladders.get(key).push(r);
  }

  const results = [];
  for (const [key, ls] of ladders) {
    const first = ls[0];
    const secs = (new Date(first.event_close_at) - new Date(first.snapshot_at)) / 1000;
    if (!(secs > 0)) continue;
    // ⛔ Fit BOTH curves on the SAME strikes. 23% of intraday rows are
    // kalshi_no_book, and those carry kalshi_yes = 0 (commodity-base.js:1425),
    // so they drop out of the market fit but NOT the model fit. Fitting each
    // curve over whatever strikes it happened to have meant comparing a sigma
    // estimated over a narrow ATM window against one estimated over the full
    // banded ladder. Neither distribution is truly lognormal — there is a smile
    // — so that difference alone moves the ratio, and it is not a model error.
    // Intersect first: a strike counts only when both curves are present and
    // unsaturated there.
    const usable = ls.filter((r) => {
      const m = r.kalshi_yes == null ? null : Number(r.kalshi_yes);
      const d = r.prob_physical == null ? null : Number(r.prob_physical);
      const ok = (v) => v != null && v > 0.02 && v < 0.98;
      return ok(m) && ok(d) && Number(r.strike) > 0 && (r.quality_flag == null);
    });
    const mkt = fitLognormal(usable.map((r) => [Number(r.strike), Number(r.kalshi_yes)]));
    const mdl = fitLognormal(usable.map((r) => [Number(r.strike), Number(r.prob_physical)]));
    if (!mkt || !mdl) continue;
    const spot = Number(first.spot_price);
    results.push({
      key,
      secs,
      spot,
      shift: (mdl.median - mkt.median) / (mkt.median * mkt.sigma),
      ratio: mdl.sigma / mkt.sigma,
      mktSigma: mkt.sigma,
      mdlSigma: mdl.sigma,
      iv: median(ls.map((r) => (r.options_iv == null ? null : Number(r.options_iv))).filter((v) => v != null)),
      n: Math.min(mkt.n, mdl.n),
    });
  }

  console.log(`fitted ${results.length} of ${ladders.size} ladders (rest lacked ${MIN_STRIKES}+ clean strikes priced on BOTH curves)\n`);
  if (!results.length) return;

  const fmt = (v, d = 3) => (v == null ? '   —  ' : v.toFixed(d).padStart(6));
  console.log('time to close   ladders   median shift(σ)   median width ratio   mkt σ     model σ');
  console.log('─'.repeat(84));
  for (const b of BUCKETS) {
    const g = results.filter((r) => r.secs >= b.lo && r.secs < b.hi);
    if (!g.length) continue;
    console.log(
      `${b.label.padEnd(14)}  ${String(g.length).padStart(6)}   ${fmt(median(g.map((r) => r.shift)))}           ${fmt(median(g.map((r) => r.ratio)))}         ` +
      `${fmt(median(g.map((r) => r.mktSigma)) * 100, 3)}%  ${fmt(median(g.map((r) => r.mdlSigma)) * 100, 3)}%`,
    );
  }
  // Annualised view. sigma_to_close = sigma_annual * sqrt(T), so dividing out
  // sqrt(T) puts every horizon on one scale and shows whether the IBIT IV we
  // feed the smile agrees with the vol Kalshi is actually pricing. alpha is the
  // engine's blend weight: 1 = all short-horizon realized vol, 0 = all IV smile
  // (commodity-base.js, shortHorizonVolCapHours = 1).
  console.log('\ntime to close   mkt σ annual   model σ annual   IBIT IV   IV/mkt   alpha(T)');
  console.log('─'.repeat(84));
  for (const b of BUCKETS) {
    const g = results.filter((r) => r.secs >= b.lo && r.secs < b.hi);
    if (!g.length) continue;
    const ann = (r, key) => r[key] / Math.sqrt(r.secs / (365 * 24 * 3600));
    const mA = median(g.map((r) => ann(r, 'mktSigma')));
    const dA = median(g.map((r) => ann(r, 'mdlSigma')));
    const iv = median(g.map((r) => r.iv).filter((v) => v != null));
    const alpha = median(g.map((r) => Math.max(0, Math.min(1, 1 - r.secs / 3600))));
    console.log(
      `${b.label.padEnd(14)}  ${fmt(mA * 100, 1)}%        ${fmt(dA * 100, 1)}%       ${iv == null ? '   —  ' : fmt(iv * 100, 1) + '%'}  ` +
      `${iv == null || !mA ? '   —  ' : fmt(iv / mA)}   ${fmt(alpha, 2)}`,
    );
  }
  console.log('─'.repeat(84));
  console.log(
    `${'ALL'.padEnd(14)}  ${String(results.length).padStart(6)}   ${fmt(median(results.map((r) => r.shift)))}           ${fmt(median(results.map((r) => r.ratio)))}`,
  );
  // Per-day, so a single volatile session can't masquerade as a term-structure
  // finding. Split at 30 min because that is where the ratio crosses 1.0.
  console.log('\nday          ladders   ratio <30min   ratio >30min   shift');
  console.log('─'.repeat(84));
  const days = [...new Set(results.map((r) => r.key.split('|')[1].slice(0, 10)))].sort();
  for (const d of days) {
    const g = results.filter((r) => r.key.includes(`|${d}`));
    const near = g.filter((r) => r.secs < 1800);
    const far = g.filter((r) => r.secs >= 1800);
    console.log(
      `${d}   ${String(g.length).padStart(6)}   ${fmt(median(near.map((r) => r.ratio)))}         ${fmt(median(far.map((r) => r.ratio)))}       ${fmt(median(g.map((r) => r.shift)))}`,
    );
  }

  console.log('\n§6 healthy band: shift within ±0.10σ, width ratio 0.95–1.05.');
}

main().catch((err) => {
  console.error('measure-btc-width failed:', err.message);
  process.exit(1);
});
