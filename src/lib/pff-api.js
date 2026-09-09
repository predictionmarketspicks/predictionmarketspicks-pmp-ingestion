// Thin client for the official PFF Developer API (https://developer.pff.com).
// Native fetch only — no axios, matching the repo-wide rule.
//
// Auth: `Authorization: Bearer <PFF_API_KEY>` against https://api.pff.com.
// Requires a PFF Pro subscription; the key is read from process.env.PFF_API_KEY
// only — never hardcode it, never log it, never put it in a query string.
//
// Rate limit is 100 reads + 20 exports per MINUTE, PER ACCOUNT (shared across
// every key/session the account holds, not per-key). Every counted response
// carries x-ratelimit-remaining / x-ratelimit-reset; going over answers 429
// with Retry-After. whoami is never counted. This client paces itself against
// the remaining-count header and backs off on 429 rather than hammering.

const BASE = 'https://api.pff.com';

function apiKey() {
  const key = process.env.PFF_API_KEY;
  if (!key) throw new Error('PFF_API_KEY is not set (check .env)');
  return key;
}

let rateState = { remaining: null, resetAt: null };

async function throttleIfLow() {
  // If we're down to single digits of budget, wait out the reset window
  // rather than risk a 429 mid-batch.
  if (rateState.remaining != null && rateState.remaining <= 3 && rateState.resetAt) {
    const waitMs = rateState.resetAt * 1000 - Date.now() + 250;
    if (waitMs > 0) {
      console.warn(`  [pff-api] rate budget low (${rateState.remaining} left) — waiting ${(waitMs / 1000).toFixed(1)}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// GET a PFF Developer API path (e.g. "/v1/teams/overview") with query params.
// Returns the parsed JSON body. Throws with the vendor's own error shape
// ({error:{code,message,request_id,details}}) attached when the API refuses.
export async function pffGet(pathAndQuery, { retries = 3 } = {}) {
  await throttleIfLow();
  const url = pathAndQuery.startsWith('http') ? pathAndQuery : `${BASE}${pathAndQuery}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });

  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (remaining != null) rateState.remaining = Number(remaining);
  if (reset != null) rateState.resetAt = Number(reset);

  if (res.status === 429 && retries > 0) {
    const retryAfter = Number(res.headers.get('retry-after')) || 5;
    console.warn(`  [pff-api] 429 rate_limited on ${pathAndQuery} — retrying after ${retryAfter}s`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return pffGet(pathAndQuery, { retries: retries - 1 });
  }

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`[pff-api] ${pathAndQuery} returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const err = body?.error || {};
    const e = new Error(`[pff-api] ${pathAndQuery} → ${res.status} ${err.code || ''} ${err.message || ''}`.trim());
    e.status = res.status;
    e.code = err.code;
    e.reason = err.details?.reason;
    e.requestId = err.request_id;
    throw e;
  }
  return body;
}

// Small pacing delay between calls in a loop (e.g. per-team roster fetches)
// so a 32-call batch doesn't front-load the per-minute budget.
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Pack height as "F-I" from PFF's packed integer (feet*100 + inches). 603 → "6-3".
export function packedHeightToFeetInches(packed) {
  if (packed == null) return null;
  const feet = Math.floor(packed / 100);
  const inches = packed % 100;
  if (!Number.isFinite(feet) || !Number.isFinite(inches)) return null;
  return `${feet}-${inches}`;
}

// Age in whole years from an ISO "YYYY-MM-DD" birth date, as of `asOf` (default now).
export function ageFromBirthDate(birthDate, asOf = new Date()) {
  if (!birthDate) return null;
  const dob = new Date(birthDate);
  if (Number.isNaN(dob.getTime())) return null;
  let age = asOf.getFullYear() - dob.getFullYear();
  const monthDiff = asOf.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < dob.getDate())) age--;
  return age;
}

// ── Regular-season week resolution ───────────────────────────────────────────
//
// ⛔ The season aggregates on /v1/teams/overview and /v1/facet/*/summary are
// PRESEASON-INCLUSIVE when no `week` filter is passed. Measured 2026-09-09 on
// season 2025: unfiltered ARZ reads 5-15 over 20 games / 402 PF, while the
// regular-season union `week=1,2,…,18` reads 3-14 over 17 games / 355 PF —
// three preseason games and 47 points of contamination, and a team grade of
// 68.0 vs 67.2. In September, BEFORE week 1 is played, the unfiltered call is
// *nothing but* preseason (2026 read 1-3 / 3-0 records on 2026-09-09).
//
// So every capture MUST pass the explicit week union. `week=1,2` unions
// correctly (ARZ pf 20 + 27 = 47, verified); `weeks[]=`, `min_week`,
// `season_type` and friends are all silently IGNORED and hand back the
// contaminated full-season number, which is the dangerous failure mode.
//
// This account's week filter reaches the REGULAR SEASON ONLY — weeks 19-22
// return rows with no stats in every season tested, and the max games any team
// shows over a 1..22 union is 17. Postseason is not addressable here.

export const NFL_REG_WEEKS = 18;

// Highest regular-season week that is fully graded, or 0 if none are.
// `has_stats` on /v1/games is the ground truth and is monotone in week:
// season 2025 weeks 1-18 all read has_stats:true with real scores, while
// season 2026 week 1 reads has_stats:false with null scores (unplayed).
// Binary search costs ~5 calls instead of 18.
export async function lastGradedRegWeek(season) {
  const graded = async (week) => {
    const body = await pffGet(`/v1/games?league=nfl&season=${season}&week=${week}`);
    const key = Object.keys(body).find((k) => k !== 'restricted');
    const rows = body[key] || [];
    return rows.length > 0 && rows.every((r) => r.has_stats === true);
  };
  if (!(await graded(1))) return 0;
  let lo = 1;
  let hi = NFL_REG_WEEKS;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (await graded(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// "1,2,…,N" — the query value that makes a season aggregate regular-season-only.
export function regWeekUnion(throughWeek) {
  return Array.from({ length: throughWeek }, (_, i) => i + 1).join(',');
}
