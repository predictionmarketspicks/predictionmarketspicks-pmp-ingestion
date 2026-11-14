// The "Why" block on a commodity Discord alert (bitcoin first, 2026-11-13).
//
// Benny: "It's not just we think it goes up. To differentiate ourselves, we need the why."
// Every alert explains itself in plain sentences built ONLY from numbers that exist on
// the alert at fire time. A line whose inputs are missing or insane is OMITTED — never
// defaulted, never invented. No line may print NaN/Infinity.
//
// ⛔ PUBLIC NUMBERS ONLY.
//   · Spot is meta.publicPrice (the public exchange basket on bitcoin), NEVER
//     edge.ref_spot: that is the CF Benchmarks index we price on, OPRA-class,
//     internal only (src/feeds/btc-spot.js, src/feeds/cfbenchmarks.js). Naming the
//     index as the settlement METHOD is fine; printing its value is not.
//   · Volatility is said as a dollar "typical move" derived from sigma_blend — never
//     "implied volatility", never an IV/option number, never a feed or vendor name.
//
// Adding a commodity: write buildWhy<Name>() on the shared helpers below and register
// it in WHY_BUILDERS + RECORD_TOOL_SLUG. buildCommodityEmbed only uses the Why layout
// for commodities registered here; every other commodity keeps today's embed.

const YEAR_MS = 365 * 24 * 3600 * 1000; // the engine's year (yearFraction / T_hours use 365)
export const RECORD_DAYS = 90;
export const MIN_RECORD_N = 20;
export const WHY_CHAR_BUDGET = 900; // 700 → 900 (2026-11-14): room for the calibration line; the embed caps the description at 1000
export const DISCLAIMER = 'Market analysis, not financial advice';

// ---------- formatting (prices may carry commas; American ODDS never do) ----------

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (x) => (x == null || x === '' ? NaN : Number(x));

export function usd(x) {
  // Whole dollars from $10 up (a BTC gap of $49.76 reads as $50); cents below that.
  const v = Math.abs(x);
  const d = v >= 10 ? 0 : 2;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

// Strikes print exactly as Kalshi lists them ($71,399.99), whole strikes without cents.
export function strikeUsd(k) {
  const whole = Number.isInteger(k);
  return `$${k.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
}

export function pct(fraction) {
  const p = Math.abs(fraction) * 100;
  return `${p < 0.1 ? p.toFixed(2) : p.toFixed(1)}%`;
}

export function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const moves = (r) => `about ${r < 10 ? r.toFixed(1) : Math.round(r)}× a typical move`;

// ---------- inputs ----------

// The SAME prob buildCommodityEmbed has always shown: physical for the v2_physical
// family, the legacy model otherwise.
export function modelProbOf(edge) {
  const v2 = String(edge?.model_version ?? '').startsWith('v2_physical') && edge?.prob_physical != null;
  return num(v2 ? edge.prob_physical : edge?.options_prob);
}

export function sideOf(edge) {
  return String(edge?.direction ?? '').toUpperCase().includes('NO') ? 'NO' : 'YES';
}

// Price of the side the alert says to take, 0–1 (Kalshi YES mid, mirrored for NO).
export function sidePriceOf(edge) {
  const yes = num(edge?.kalshi_yes);
  if (!isNum(yes) || yes <= 0 || yes >= 1) return null;
  return sideOf(edge) === 'NO' ? 1 - yes : yes;
}

function inputs({ meta, edge, now }) {
  const strike = num(edge?.strike);
  // Public price only — see the header. Row spot_price is the same public basket.
  let spot = num(meta?.publicPrice);
  if (!isNum(spot) || spot <= 0) spot = num(edge?.spot_price);
  const closeMs = new Date(edge?.event_close_at ?? meta?.eventCloseAt ?? NaN).getTime();
  const nowMs = (now instanceof Date ? now : new Date(now ?? Date.now())).getTime();
  const leftMs = isNum(closeMs) ? closeMs - nowMs : NaN;
  const sigma = num(edge?.sigma_blend);
  const okSpot = isNum(spot) && spot > 0;
  const okStrike = isNum(strike) && strike > 0;
  const okLeft = isNum(leftMs) && leftMs > 0;
  // Sane annualized vol: (0, 500%]. Anything outside is a broken input, not a market.
  const okSigma = isNum(sigma) && sigma > 0 && sigma <= 5;
  const typical = okSpot && okLeft && okSigma ? sigma * spot * Math.sqrt(leftMs / YEAR_MS) : null;
  return {
    strike: okStrike ? strike : null,
    spot: okSpot ? spot : null,
    leftMs: okLeft ? leftMs : null,
    typical: isNum(typical) && typical > 0 ? typical : null,
    side: sideOf(edge),
  };
}

// ---------- lines ----------

function setupLine(x, { asset, settleOn }) {
  if (x.spot == null || x.strike == null) return null;
  const d = x.spot - x.strike;
  const where = Math.abs(d) < 1
    ? `right at the ${strikeUsd(x.strike)} strike`
    : `${usd(d)} (${pct(d / x.spot)}) ${d > 0 ? 'above' : 'below'} the ${strikeUsd(x.strike)} strike`;
  const time = x.leftMs != null ? `, with ${duration(x.leftMs)} until it settles on ${settleOn}` : '';
  return `${asset} is ${usd(x.spot)} — ${where}${time}.`;
}

function volLine(x, { asset }) {
  if (x.typical == null) return null;
  return `At current volatility a typical ${asset} move over that window is about ±${usd(Math.round(x.typical))}.`;
}

function disagreementLine(x, edge, { asset }) {
  if (x.strike == null) return null;
  const p = modelProbOf(edge);
  const yes = num(edge?.kalshi_yes);
  if (!isNum(p) || p <= 0 || p >= 1 || !isNum(yes) || yes <= 0 || yes >= 1) return null;
  const no = x.side === 'NO';
  // NO = 100 − the rounded YES figure, so the two sides always sum to 100 (no float drift
  // on half-cent mids like 78.5¢).
  const modelPct = no ? 100 - Math.round(p * 100) : Math.round(p * 100);
  const mktPct = no ? 100 - Math.round(yes * 100) : Math.round(yes * 100);
  const pts = modelPct - mktPct;
  // The numbers must back the direction; if they don't, say nothing rather than contradict it.
  if (pts <= 0) return null;
  const k = strikeUsd(x.strike);
  return no
    ? `Our model puts the chance ${asset} finishes below ${k} at ${modelPct}%; Kalshi prices NO at ${mktPct}% — NO is underpriced by ${pts} pts.`
    : `Our model puts the chance ${asset} finishes above ${k} at ${modelPct}%; Kalshi prices it at ${mktPct}% — YES is underpriced by ${pts} pts.`;
}

/**
 * Benny 2026-11-14 ("yes on 3"): when the calibrated probability (the model adjusted for its own
 * past accuracy — shadow mode, so it never drove this alert) is at least 3 pts MORE CAUTIOUS
 * than the model, say so. Silence when it agrees or is more bullish: there is no doubt to disclose.
 */
export const CALIBRATION_GAP_PTS = 3;
function calibrationLine(x, edge) {
  const p = modelProbOf(edge);
  const c = num(edge?.calibrated_prob);
  const yes = num(edge?.kalshi_yes);
  if (![p, c, yes].every((v) => isNum(v) && v > 0 && v < 1)) return null;
  const no = x.side === 'NO';
  const side = (v) => (no ? 100 - Math.round(v * 100) : Math.round(v * 100));
  const m = side(p);
  const k = side(yes);
  const cal = side(c);
  if (m - cal < CALIBRATION_GAP_PTS) return null;
  const head = `Our calibration — the model adjusted for its own track record — is more cautious at ${cal}%`;
  if (cal < k) return `${head}, below Kalshi's price: on that read there is no edge here.`;
  if (cal - k <= 2) return `${head}, about where Kalshi is, so treat this edge as unconfirmed.`;
  return `${head}; on that read the edge is ${cal - k} pts, not ${m - k}.`;
}

function needsLine(x, { asset }) {
  if (x.spot == null || x.strike == null) return null;
  const d = x.spot - x.strike; // > 0: spot above the strike
  if (Math.abs(d) < 1) return `${asset} is sitting on the strike — the next move decides it.`;
  const wantUp = x.side === 'YES';
  const favorable = wantUp ? d > 0 : d < 0;
  const gap = `${usd(d)} (${pct(d / x.spot)})`;
  const r = x.typical != null ? Math.abs(d) / x.typical : null;
  if (favorable) {
    const tail = r != null ? `, ${moves(r)}` : '';
    return `Holds if ${asset} stays ${wantUp ? 'above' : 'below'} ${strikeUsd(x.strike)} — a ${gap} ${wantUp ? 'drop' : 'rise'} flips it${tail}.`;
  }
  const when = x.leftMs != null ? ` in ${duration(x.leftMs)}` : '';
  const tail = r != null ? ` — ${moves(r)}` : '';
  return `Needs a ${gap} ${wantUp ? 'rise' : 'drop'}${when}${tail}.`;
}

// mu_used is the annualized drift that actually moved this row's prob. Bitcoin runs it at
// 0 today (BTC_MU_SCALE), so this line is normally absent — by design.
function momentumLine(x, edge) {
  const mu = num(edge?.mu_used);
  if (!isNum(mu) || mu === 0 || Math.abs(mu) > 50 || x.spot == null || x.leftMs == null) return null;
  const shift = x.spot * (Math.exp(mu * (x.leftMs / YEAR_MS)) - 1);
  const floor = Math.max(1, x.typical != null ? 0.1 * x.typical : 0.0005 * x.spot);
  if (!isNum(shift) || Math.abs(shift) < floor) return null;
  return `Recent momentum points ${shift > 0 ? 'up' : 'down'} — the model leans about ${usd(Math.round(shift))} ${shift > 0 ? 'higher' : 'lower'} by the settle.`;
}

// ---------- track record ----------

export function bandOf(sidePrice) {
  if (!isNum(sidePrice) || sidePrice < 0 || sidePrice > 1) return null;
  return Math.min(9, Math.floor(Math.round(sidePrice * 100) / 10));
}

/**
 * Graded picks → { days, bands: { [0..9]: { n, wins, netCents } } }. Pure.
 * rows: [{ predicted_side, market_price_at_pick (YES price), resolution, net_pnl_cents }]
 * Side price = market_price_at_pick for YES, 1 − it for NO (tool_settles pnl agrees).
 */
export function summarizeBands(rows, days = RECORD_DAYS) {
  const bands = {};
  for (const r of rows ?? []) {
    if (r?.resolution !== 'won' && r?.resolution !== 'lost') continue;
    const px = num(r.market_price_at_pick);
    const net = num(r.net_pnl_cents);
    if (!isNum(px) || !isNum(net)) continue;
    const side = String(r.predicted_side ?? '').toUpperCase() === 'NO' ? 1 - px : px;
    const b = bandOf(side);
    if (b == null) continue;
    const s = (bands[b] ??= { n: 0, wins: 0, netCents: 0 });
    s.n += 1;
    s.wins += r.resolution === 'won' ? 1 : 0;
    s.netCents += net;
  }
  return { days, bands };
}

/** One sentence on how this tool did at this alert's entry price. Pure; null when unknown. */
export function bandRecordLine({ record, sidePrice, label = 'Bitcoin' }) {
  const b = bandOf(sidePrice);
  if (b == null || !record || typeof record !== 'object' || !record.bands) return null;
  const s = record.bands[b] ?? { n: 0, wins: 0, netCents: 0 };
  if (!isNum(s.n) || !isNum(s.wins) || !isNum(s.netCents) || s.n < 0) return null;
  if (s.n < MIN_RECORD_N) return `Thin history at this price (n=${s.n}).`;
  const days = isNum(record.days) ? record.days : RECORD_DAYS;
  const per = s.netCents / s.n / 100;
  const perText = Math.abs(per) < 0.005
    ? 'about break-even per contract after fees'
    : `${per > 0 ? '+' : '−'}$${Math.abs(per).toFixed(2)} per contract after fees`;
  const body = `${label} picks entered at ${b * 10}–${b * 10 + 10}¢ won ${Math.round((s.wins / s.n) * 100)}% (${s.wins} of ${s.n}) over the last ${days} days, ${perText}.`;
  return s.netCents < 0 ? `This price range has lost money: ${body.charAt(0).toLowerCase()}${body.slice(1)}` : body;
}

// ---------- builders ----------

function fitBudget(lines, dropOrder, budget = WHY_CHAR_BUDGET) {
  const out = [...lines];
  const len = () => out.filter(Boolean).join('\n').length;
  for (const i of dropOrder) {
    if (len() <= budget) break;
    out[i] = null;
  }
  return out.filter(Boolean);
}

/**
 * Lines of the bitcoin "Why" block, in order: setup, volatility, disagreement,
 * calibration (only when more cautious), what it needs / what breaks it, momentum, track record. Pure.
 * record: summarizeBands() output, or null (line omitted).
 */
export function buildWhyBitcoin({ meta, edge, record = null, now = new Date() }) {
  const ctx = { asset: 'BTC', settleOn: 'the CF Benchmarks index Kalshi uses' };
  const x = inputs({ meta, edge, now });
  const lines = [
    setupLine(x, ctx),
    volLine(x, ctx),
    disagreementLine(x, edge, ctx),
    calibrationLine(x, edge),
    needsLine(x, ctx),
    momentumLine(x, edge),
    bandRecordLine({ record, sidePrice: sidePriceOf(edge), label: 'Bitcoin' }),
  ];
  // Over budget: momentum goes first, then the volatility sentence. The calibration and
  // track-record lines are never dropped — they are the honesty.
  return fitBudget(lines, [5, 1]);
}

export const WHY_BUILDERS = { bitcoin: buildWhyBitcoin };
export const RECORD_TOOL_SLUG = { bitcoin: 'bitcoin-edge' };

export function hasWhy(commodity) {
  return Object.hasOwn(WHY_BUILDERS, String(commodity ?? ''));
}

// ---------- record fetch (impure; cached one hour per process) ----------

const RECORD_TTL_MS = 60 * 60 * 1000;
const RECORD_TIMEOUT_MS = 4000;
const _recordCache = new Map(); // slug -> { at, record }

/**
 * Band record for a commodity's tool, or null. Never throws: a failed or slow read
 * omits the record line, it never holds the alert. A failure is cached too (as null)
 * for the hour so a dead read doesn't add latency to every alert.
 */
export async function fetchBandRecord(sb, commodity, { now = new Date() } = {}) {
  const slug = RECORD_TOOL_SLUG[commodity];
  if (!slug || !sb) return null;
  const t = now.getTime();
  const hit = _recordCache.get(slug);
  if (hit && t - hit.at < RECORD_TTL_MS) return hit.record;
  let record = null;
  try {
    const since = new Date(t - RECORD_DAYS * 86_400_000).toISOString();
    const query = sb
      .from('tool_settles')
      .select('resolution, net_pnl_cents, tool_picks!inner(tool_slug, predicted_side, market_price_at_pick, picked_at)')
      .in('resolution', ['won', 'lost'])
      .eq('tool_picks.tool_slug', slug)
      .gte('tool_picks.picked_at', since)
      .limit(5000);
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('timeout')), RECORD_TIMEOUT_MS);
    });
    const { data, error } = await Promise.race([query, timeout]).finally(() => clearTimeout(timer));
    if (error) throw error;
    record = summarizeBands(
      (data ?? []).map((r) => ({
        resolution: r.resolution,
        net_pnl_cents: r.net_pnl_cents,
        predicted_side: r.tool_picks?.predicted_side,
        market_price_at_pick: r.tool_picks?.market_price_at_pick,
      })),
    );
  } catch (err) {
    console.warn(`[why] ${slug} band record read failed, line omitted:`, err?.message || err);
    record = null;
  }
  _recordCache.set(slug, { at: t, record });
  return record;
}

// Test-only.
export function _resetRecordCache() {
  _recordCache.clear();
}
