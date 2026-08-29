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

const KNOWN_ACTIONS = new Set(['suppress', 'downgrade', 'size_cap']);

// Condition keys this engine can evaluate at signal-gen. Adding a key here is
// the ONLY way to make the engine honour it — see the note above.
const PREDICATE_KEYS = new Set([
  'commodity',
  'dow', // 0=Sunday..6=Saturday, UTC — matches EXTRACT(DOW FROM snapshot_at)
  'hour_utc',
  'implied_prob_min',
  'implied_prob_max',
  // The side the engine is about to publish ('BUY YES' / 'BUY NO'), evaluated
  // against the row's computed direction BEFORE rules apply. Added 2026-08-29:
  // the oil-edge bleed is YES-specific (YES 20-39c ran 18% win / -$5.58 while
  // NO 20-39c made +$4.79), and without this key a price-band rule cannot help
  // but suppress the profitable side along with the losing one.
  'direction',
]);

// Action PARAMETERS, not predicates. `engine_rules` has no params column, so a
// size_cap rule has to carry its magnitude inside `condition`. These keys are
// recognised (they do not trip the unknown-key guard) but are never evaluated
// as a match test — treating a parameter as a predicate would make the rule
// never fire, which is how size_cap rules would silently die.
const PARAM_KEYS = new Set(['size_cap_pct']);

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

  const res = await sb
    .from('engine_rules')
    .select('id, scope, condition, action, status')
    .eq('status', 'active');
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
 * Returns { suppress, downgrade, sizeCapPct, matched, note } — the caller
 * decides how to render them. `note` is an audit string appended to the row's
 * rationale so every suppression is traceable to a rule id.
 *
 * No-op (all false/null) when consumption is disabled — the kill switch is
 * honoured on EVERY pass, not just at boot.
 */
export function applyEngineRules(ctx, opts = {}) {
  const none = { suppress: false, downgrade: false, sizeCapPct: null, matched: [], note: null };
  const enabled = opts.enabled ?? _enabled;
  if (!enabled) return none;
  const matched = matchingRules(ctx, opts.rules ?? _rules);
  if (matched.length === 0) return none;

  let suppress = false;
  let downgrade = false;
  let sizeCapPct = null;
  for (const r of matched) {
    if (r.action === 'suppress') suppress = true;
    else if (r.action === 'downgrade') downgrade = true;
    else if (r.action === 'size_cap') {
      const pct = Number(r.condition?.size_cap_pct);
      if (Number.isFinite(pct)) sizeCapPct = sizeCapPct == null ? pct : Math.min(sizeCapPct, pct);
    }
  }
  const ids = matched.map((r) => String(r.id).slice(0, 8)).join(',');
  const actions = [suppress ? 'suppress' : null, downgrade ? 'downgrade' : null]
    .filter(Boolean)
    .join('+');
  return {
    suppress,
    downgrade,
    sizeCapPct,
    matched,
    note: actions ? `[rule:${actions} ${ids}]` : `[rule:matched ${ids}]`,
  };
}

// Test seam.
export function __setRulesForTest(rules, enabled = true) {
  _rules = rules;
  _enabled = enabled;
}
