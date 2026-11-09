// Loop-engine rule consumption at signal generation.
// handoffs/LOOP_ENGINE_RULES_2026-06-24.md §PR6
// handoffs/BITCOIN_EDGE_V21_CALIBRATED_RELAUNCH_2026-08-05.md §7.1
//
// PR 6 of the loop-engine plan was never built — `engine_rules` appeared
// nowhere in this repo until now, so `consumption_enabled` has been guarding
// code that did not exist since 2026-06-24. This is that code.
//
// SAFETY MODEL — every branch fails toward publishing the signal unchanged:
//   * kill switch off (or unreadable)      -> no rules applied
//   * rules table unreadable               -> keep last known set, warn once
//   * unknown ACTION                       -> rule skipped + warned
//   * unknown CONDITION KEY                -> rule skipped + warned
//   * no active rules                      -> no-op
//
// The unknown-condition-key rule is the important one and it is deliberately
// stricter than "ignore what you don't understand". A rule reading
// {dow: 2, regime: "crowded_equilibrium"} means BOTH; an engine that only
// understands `dow` and applies the rule anyway would suppress every Tuesday
// instead of the narrow slice the miner actually justified. Partial evaluation
// of a conjunction is not conservative — it is strictly broader than intended.
// So a rule is applied only when EVERY key in its condition is understood and
// satisfied.

import { getClient } from '../delivery/supabase.js';

// Loop v2 (EDGE_LOOP_V2_2026-11-09 §2 / U4a). The engine HONOURS suppress, downgrade, promote,
// unsuppress and alert; size_cap, size_rung and retire_lane are the bots' and the lane
// graders' actions — recognised so a row carrying them is never "unknown", tagged, never acted on.
const KNOWN_ACTIONS = new Set(['suppress', 'downgrade', 'size_cap', 'promote', 'unsuppress', 'alert', 'size_rung', 'retire_lane']);
const ENGINE_ACTIONS = new Set(['suppress', 'downgrade', 'promote', 'unsuppress', 'alert']);

// Condition keys this engine can evaluate at signal-gen. Adding a key here is
// the ONLY way to make the engine honour it — see the note above.
const PREDICATE_KEYS = new Set([
  'commodity',
  'dow', // 0=Sunday..6=Saturday, UTC — matches EXTRACT(DOW FROM snapshot_at)
  'hour_utc',
  // ENTRY band — the price of the SIDE taken (YES = kalshi_yes, NO = 1 − kalshi_yes), 0–1.
  // Loop v2 fixed this to the side cost; a row with no side (PASS) is evaluated on the YES
  // price, which is what every rule before 2026-11-09 saw. The one active rule (oil-edge
  // suppress BUY YES 20–39¢) is a YES rule, so its meaning is unchanged.
  'implied_prob_min',
  'implied_prob_max',
  // The side the engine is about to publish ('BUY YES' / 'BUY NO'), evaluated
  // against the row's computed direction BEFORE rules apply. Added 2026-08-29:
  // the oil-edge bleed is YES-specific (YES 20-39c ran 18% win / -$5.58 while
  // NO 20-39c made +$4.79), and without this key a price-band rule cannot help
  // but suppress the profitable side along with the losing one.
  'direction',
  // Loop v2 keys (§2). edge_pp_* are in PERCENTAGE POINTS on the gross |fused edge| (7 = 7pp);
  // tier_in is the fused tier int (1 SPECULATIVE · 2 MODERATE · 3 STRONG) BEFORE rules;
  // hour_et_in / dow_in are America/New_York ("Fri"); pot_key is the miner's
  // `<scope>|<dim>=<value>` label, parsed by parsePotKey (a label with no `=` always matches).
  'edge_pp_min',
  'edge_pp_max',
  'tier_in',
  'hour_et_in',
  'dow_in',
  'pot_key',
]);

// Action PARAMETERS, not predicates. `engine_rules` has no params column, so a
// size_cap rule has to carry its magnitude inside `condition`. These keys are
// recognised (they do not trip the unknown-key guard) but are never evaluated
// as a match test — treating a parameter as a predicate would make the rule
// never fire, which is how size_cap rules would silently die.
//   supersedes   unsuppress: the rule id whose suppress/downgrade this cancels
//   rung / unit / per_position   size_rung (bots)
//   lift_side_gate   promote (EDGE_LOOP_V2 U5, S8): also lift the post-spread SIDE gate on a row whose
//                    gross |edge| matched — the September metals publish path (side from the edge
//                    sign, tier from the gross). Never a quality flag, never the 40¢ entry floor.
const PARAM_KEYS = new Set(['size_cap_pct', 'supersedes', 'rung', 'unit', 'per_position', 'lift_side_gate']);

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ET_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', weekday: 'short', hourCycle: 'h23' });

/** { hourEt, dowEt } of an instant in America/New_York (DST-aware). */
export function etClock(now = new Date()) {
  const o = {};
  for (const p of ET_PARTS.formatToParts(now)) if (p.type !== 'literal') o[p.type] = p.value;
  return { hourEt: Number(o.hour) % 24, dowEt: String(o.weekday).slice(0, 3) };
}

/**
 * The rule context for one engine row — everything a Loop v2 condition can read.
 *   commodity      'bitcoin' | 'gold' | 'silver' | 'oil'
 *   now            the snapshot instant
 *   direction      the engine's pre-rules direction ('BUY YES' | 'BUY NO' | 'PASS')
 *   kalshiYes      the YES price (0–1), null when there is no book
 *   chosenEdge     the gross edge that drove the row (fraction, signed), null when none
 *   fusedTier      the pre-rules fused tier string
 */
export function ruleContext({ commodity, now, direction, kalshiYes, chosenEdge, fusedTier }) {
  const d = now instanceof Date ? now : new Date(now);
  const yes = kalshiYes == null || !Number.isFinite(Number(kalshiYes)) ? null : Number(kalshiYes);
  const sideCost = yes == null ? null : direction === 'BUY NO' ? 1 - yes : yes;
  const tierInt = fusedTier === 'STRONG' ? 3 : fusedTier === 'MODERATE' ? 2 : fusedTier === 'SPECULATIVE' ? 1 : 0;
  return {
    commodity,
    dow: d.getUTCDay(),
    hourUtc: d.getUTCHours(),
    ...etClock(d),
    impliedProb: sideCost,
    yesPrice: yes,
    edgePp: chosenEdge == null || !Number.isFinite(Number(chosenEdge)) ? null : Math.abs(Number(chosenEdge)) * 100,
    tier: tierInt,
    direction,
  };
}

/**
 * `<scope>|<dim>=<value>` → { scope, dim, value } ; a key with no `=` is a plain label
 * ({ label }). Dims the engine can evaluate: hour (ET), dow (ET name), tier, side, edge (band
 * "7-9" = [7, 9) pp, "12+" = ≥ 12), entry (band in cents on the side cost, "35-50" = [35, 50)).
 */
export function parsePotKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const bar = s.indexOf('|');
  const scope = bar >= 0 ? s.slice(0, bar) : null;
  const rest = bar >= 0 ? s.slice(bar + 1) : s;
  const eq = rest.indexOf('=');
  if (eq < 0) return { scope, label: rest };
  return { scope, dim: rest.slice(0, eq).trim().toLowerCase(), value: rest.slice(eq + 1).trim() };
}

function bandMatches(value, x) {
  if (x == null) return false;
  const m = /^(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?)|\+)$/.exec(String(value));
  if (!m) return false;
  const lo = Number(m[1]);
  if (m[2] == null) return x >= lo;
  return x >= lo && x < Number(m[2]);
}

function potKeyMatches(raw, ctx) {
  const pk = parsePotKey(raw);
  if (!pk) return false;
  if (pk.label != null) return true; // a label carries no predicate; the other keys decide
  switch (pk.dim) {
    case 'hour': return ctx.hourEt != null && Number(pk.value) === ctx.hourEt;
    case 'dow': return ctx.dowEt != null && String(pk.value).slice(0, 3).toLowerCase() === String(ctx.dowEt).toLowerCase();
    case 'tier': return ctx.tier != null && Number(pk.value) === ctx.tier;
    case 'side': return ctx.direction != null && String(pk.value).toUpperCase().replace(/^BUY\s+/, '') === String(ctx.direction).toUpperCase().replace(/^BUY\s+/, '');
    case 'edge': return bandMatches(pk.value, ctx.edgePp);
    case 'entry': return ctx.impliedProb != null && bandMatches(pk.value, ctx.impliedProb * 100);
    default:
      warnOnce(`pot:${pk.dim}`, `pot_key dimension "${pk.dim}" is not one this engine can evaluate — rule skipped`);
      return false;
  }
}

const inList = (raw, v, norm = (x) => x) => Array.isArray(raw) && v != null && raw.some((r) => norm(r) === norm(v));

const KNOWN_CONDITION_KEYS = new Set([...PREDICATE_KEYS, ...PARAM_KEYS]);

const COMMODITY_TO_SLUG = {
  silver: 'silver-edge',
  gold: 'gold-edge',
  oil: 'oil-edge',
  bitcoin: 'bitcoin-edge',
};

let _enabled = false;
let _rules = [];
let _lastRefreshMs = 0;
let _lastError = null;
const _warned = new Set();

function warnOnce(key, msg) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`[engine-rules] ${msg}`);
}

export async function refreshEngineRules() {
  let sb;
  try {
    sb = getClient();
  } catch (err) {
    _lastError = err.message;
    return { ok: false, error: err.message };
  }

  const cfg = await sb.from('engine_rules_config').select('consumption_enabled').limit(1);
  if (cfg.error) {
    // Kill switch unreadable => treat as OFF. "Rules off" is the safe default.
    _enabled = false;
    _lastError = cfg.error.message;
    console.warn('[engine-rules] config unreadable, consumption OFF:', cfg.error.message);
    return { ok: false, error: cfg.error.message };
  }
  _enabled = cfg.data?.[0]?.consumption_enabled === true;

  // pot_key is the Loop v2 column (EDGE_LOOP_V2 U1); until that migration lands the select
  // without it keeps every existing rule readable.
  let res = await sb
    .from('engine_rules')
    .select('id, scope, condition, action, status, pot_key')
    .eq('status', 'active');
  if (res.error && /pot_key/.test(res.error.message || '')) {
    res = await sb.from('engine_rules').select('id, scope, condition, action, status').eq('status', 'active');
  }
  if (res.error) {
    // Keep the previous set rather than dropping rules mid-session.
    _lastError = res.error.message;
    console.warn('[engine-rules] rules unreadable, keeping previous set:', res.error.message);
    return { ok: false, error: res.error.message };
  }

  _rules = res.data ?? [];
  _lastRefreshMs = Date.now();
  _lastError = null;
  console.log(
    `[engine-rules] consumption=${_enabled ? 'ON' : 'OFF'}, ${_rules.length} active rule(s)`,
  );
  return { ok: true, enabled: _enabled, count: _rules.length };
}

export function engineRulesStatus() {
  return {
    consumptionEnabled: _enabled,
    activeRules: _rules.length,
    lastRefreshMs: _lastRefreshMs,
    lastError: _lastError,
  };
}

function scopeMatches(scope, commodity) {
  if (scope === 'all') return true;
  return scope === COMMODITY_TO_SLUG[commodity];
}

// Returns true only when EVERY condition key is understood AND satisfied.
export function conditionMatches(condition, ctx) {
  const entries = Object.entries(condition ?? {}).filter(([k]) => !PARAM_KEYS.has(k));
  // No PREDICATE at all means "everything" — never honour that. A rule whose
  // condition is only action parameters would suppress the entire tool.
  if (entries.length === 0) return false;
  // A pot_key LABEL (no `dim=value`) is a name, not a test: it must ride beside a real
  // predicate, or the rule would match every row of its scope (the same hazard as above).
  const labelsOnly = entries.every(([k, v]) => k === 'pot_key' && parsePotKey(v)?.label != null);
  if (labelsOnly) return false;
  for (const [key, raw] of entries) {
    if (!PREDICATE_KEYS.has(key)) return false;
    switch (key) {
      case 'commodity':
        if (String(raw) !== String(ctx.commodity)) return false;
        break;
      case 'dow':
        if (Number(raw) !== ctx.dow) return false;
        break;
      case 'hour_utc':
        if (Number(raw) !== ctx.hourUtc) return false;
        break;
      case 'implied_prob_min':
        if (!(ctx.impliedProb != null && ctx.impliedProb >= Number(raw))) return false;
        break;
      case 'implied_prob_max':
        if (!(ctx.impliedProb != null && ctx.impliedProb <= Number(raw))) return false;
        break;
      case 'direction':
        // Exact, case-insensitive match on the engine's publish direction.
        // A ctx without a direction never matches a direction-keyed rule --
        // same fail-toward-publishing posture as a null impliedProb above.
        if (ctx.direction == null) return false;
        if (String(raw).toUpperCase() !== String(ctx.direction).toUpperCase()) return false;
        break;
      // Loop v2 keys — every one fails toward publishing when the ctx lacks the value.
      case 'edge_pp_min':
        if (!(ctx.edgePp != null && ctx.edgePp >= Number(raw))) return false;
        break;
      case 'edge_pp_max':
        if (!(ctx.edgePp != null && ctx.edgePp <= Number(raw))) return false;
        break;
      case 'tier_in':
        if (!inList(raw, ctx.tier, Number)) return false;
        break;
      case 'hour_et_in':
        if (!inList(raw, ctx.hourEt, Number)) return false;
        break;
      case 'dow_in':
        if (!inList(raw, ctx.dowEt, (x) => String(x).slice(0, 3).toLowerCase())) return false;
        break;
      case 'pot_key':
        if (!potKeyMatches(raw, ctx)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

// Which rules apply to this signal. Pure over the cached set.
export function matchingRules(ctx, rules = _rules) {
  const out = [];
  for (const r of rules) {
    if (!scopeMatches(r.scope, ctx.commodity)) continue;
    if (!KNOWN_ACTIONS.has(r.action)) {
      warnOnce(`action:${r.action}`, `unknown action "${r.action}" on rule ${r.id} — ignoring`);
      continue;
    }
    const keys = Object.keys(r.condition ?? {});
    const unknown = keys.filter((k) => !KNOWN_CONDITION_KEYS.has(k));
    if (unknown.length > 0) {
      warnOnce(
        `cond:${r.id}`,
        `rule ${r.id} uses condition key(s) [${unknown.join(', ')}] this engine cannot evaluate — ` +
          'rule SKIPPED (partially applying a conjunction would be broader than intended)',
      );
      continue;
    }
    if (!conditionMatches(r.condition, ctx)) continue;
    out.push(r);
  }
  return out;
}

/**
 * Apply active rules to one signal.
 *
 * Returns { suppress, downgrade, promote, liftSideGate, alert, hotPot, sizeCapPct, matched, ruleIds, note } —
 * the caller decides how to render them. `note` is an audit string appended to the row's
 * rationale so every suppression is traceable to a rule id; `ruleIds` (full ids of every
 * matched rule) is what the pick carries in regime_tags.rules.
 *
 * Loop v2 semantics (§2):
 *   unsuppress  cancels the effect of the rule named in its `supersedes` param (suppress or
 *               downgrade) for rows it matches; it is itself recorded in matched/ruleIds.
 *   promote     asks the engine to publish the row as a PLAY past its local soft gates; a
 *               surviving suppress ALWAYS wins over a promote (narrowing beats widening), and a
 *               surviving downgrade still applies after the promote.
 *   alert       hotPot = the rule's pot_key column, else its condition.pot_key, else its id.
 *
 * No-op (all false/null) when consumption is disabled — the kill switch is
 * honoured on EVERY pass, not just at boot.
 */
export function applyEngineRules(ctx, opts = {}) {
  const none = { suppress: false, downgrade: false, promote: false, liftSideGate: false, alert: false, hotPot: null, sizeCapPct: null, matched: [], ruleIds: [], note: null };
  const enabled = opts.enabled ?? _enabled;
  if (!enabled) return none;
  const matched = matchingRules(ctx, opts.rules ?? _rules);
  if (matched.length === 0) return none;

  const superseded = new Set(
    matched.filter((r) => r.action === 'unsuppress' && r.condition?.supersedes != null).map((r) => String(r.condition.supersedes)),
  );
  let suppress = false;
  let downgrade = false;
  let promote = false;
  let liftSideGate = false;
  let alert = false;
  let hotPot = null;
  let sizeCapPct = null;
  for (const r of matched) {
    if (superseded.has(String(r.id))) continue;
    if (r.action === 'suppress') suppress = true;
    else if (r.action === 'downgrade') downgrade = true;
    else if (r.action === 'promote') {
      promote = true;
      if (r.condition?.lift_side_gate === true) liftSideGate = true;
    }
    else if (r.action === 'alert') {
      alert = true;
      hotPot = hotPot ?? r.pot_key ?? r.condition?.pot_key ?? String(r.id);
    } else if (r.action === 'size_cap') {
      const pct = Number(r.condition?.size_cap_pct);
      if (Number.isFinite(pct)) sizeCapPct = sizeCapPct == null ? pct : Math.min(sizeCapPct, pct);
    }
  }
  if (suppress) promote = false;
  if (!promote) liftSideGate = false;
  const ids = matched.map((r) => String(r.id).slice(0, 8)).join(',');
  const actions = [suppress ? 'suppress' : null, downgrade ? 'downgrade' : null, promote ? 'promote' : null, alert ? 'alert' : null]
    .filter(Boolean)
    .join('+');
  return {
    suppress,
    downgrade,
    promote,
    liftSideGate,
    alert,
    hotPot,
    sizeCapPct,
    matched,
    ruleIds: matched.map((r) => String(r.id)),
    note: actions ? `[rule:${actions} ${ids}]` : `[rule:matched ${ids}]`,
  };
}

// Test seam.
export function __setRulesForTest(rules, enabled = true) {
  _rules = rules;
  _enabled = enabled;
}
