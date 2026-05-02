// Brand word-swap guard for outbound user-facing copy.
//
// CLAUDE.md non-negotiable: prediction markets are NOT sportsbooks. Discord
// embeds, Realtime payloads, and any string the user sees must not contain
// betting-derived words. This module is used both at test time (Vitest assertion
// over representative payloads) and at runtime (Discord delivery refuses to
// send a payload that fails the lint).

const BANNED = /\b(bet|bets|betting|bettor|bettors|wager|wagers|wagering|sportsbook|sportsbooks|bookmaker|bookmakers|bookie|bookies|gambling|gambler|gamblers)\b/i;

export function findBannedWord(text) {
  if (text == null) return null;
  const m = String(text).match(BANNED);
  return m ? m[0] : null;
}

// Walks an arbitrary value and returns { ok, offender, path } on first hit.
export function lintPayload(value, path = '$') {
  if (value == null) return { ok: true };
  if (typeof value === 'string') {
    const hit = findBannedWord(value);
    return hit ? { ok: false, offender: hit, path } : { ok: true };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = lintPayload(value[i], `${path}[${i}]`);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const r = lintPayload(value[k], `${path}.${k}`);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  return { ok: true };
}

export class BannedWordError extends Error {
  constructor(offender, path) {
    super(`banned word "${offender}" at ${path} — see CLAUDE.md word-swap table`);
    this.name = 'BannedWordError';
    this.offender = offender;
    this.path = path;
  }
}

export function assertBrandSafe(payload) {
  const r = lintPayload(payload);
  if (!r.ok) throw new BannedWordError(r.offender, r.path);
}
