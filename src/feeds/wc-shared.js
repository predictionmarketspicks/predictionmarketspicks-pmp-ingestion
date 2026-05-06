// World Cup 2026 — shared maps + helpers used by every WC feed.
//
// CANONICAL ENTITY IDS (must match the seed in
// prediction-marketspicks/scripts/seed-wc-simulation.sql + PR 2 Python sim):
//   - team:<slug>            e.g. team:bosnia (NOT bosnia-and-herzegovina),
//                                 team:united-states (NOT usa).
//   - match:<G>-MD<n>-<H>-<A> e.g. match:A-MD1-MEX-KOR — 3-letter codes,
//                                 home then away. MD = matchday 1/2/3.
//   - player:<slug>          golden-boot top-25 + extension.
//
// The slugs and codes here are the source of truth for the writer. If Kalshi
// or Polymarket spell a team name we don't recognize, the row is dropped (and
// logged) — better to skip than write the wrong entity_id, since PR 4
// mispricing reads on (entity_id, kind) and a typo makes a row invisible.

// 48-team table. Group letter is informational; not stored on the row but
// useful when group_winner Kalshi titles say "win Group X".
export const WC_TEAMS = [
  { slug: 'mexico', code: 'MEX', name: 'Mexico', group: 'A' },
  { slug: 'korea-republic', code: 'KOR', name: 'Korea Republic', group: 'A', aliases: ['South Korea', 'Republic of Korea'] },
  { slug: 'south-africa', code: 'RSA', name: 'South Africa', group: 'A' },
  { slug: 'czechia', code: 'CZE', name: 'Czechia', group: 'A', aliases: ['Czech Republic'] },
  { slug: 'canada', code: 'CAN', name: 'Canada', group: 'B' },
  { slug: 'switzerland', code: 'SUI', name: 'Switzerland', group: 'B' },
  { slug: 'qatar', code: 'QAT', name: 'Qatar', group: 'B' },
  { slug: 'bosnia', code: 'BIH', name: 'Bosnia & Herzegovina', group: 'B', aliases: ['Bosnia and Herzegovina', 'Bosnia-Herzegovina'] },
  { slug: 'brazil', code: 'BRA', name: 'Brazil', group: 'C' },
  { slug: 'morocco', code: 'MOR', name: 'Morocco', group: 'C' },
  { slug: 'scotland', code: 'SCO', name: 'Scotland', group: 'C' },
  { slug: 'haiti', code: 'HAI', name: 'Haiti', group: 'C' },
  { slug: 'united-states', code: 'USA', name: 'United States', group: 'D', aliases: ['USA', 'US', 'U.S.A.'] },
  { slug: 'paraguay', code: 'PAR', name: 'Paraguay', group: 'D' },
  { slug: 'australia', code: 'AUS', name: 'Australia', group: 'D' },
  { slug: 'turkiye', code: 'TUR', name: 'Türkiye', group: 'D', aliases: ['Turkey', 'Turkiye'] },
  { slug: 'germany', code: 'GER', name: 'Germany', group: 'E' },
  { slug: 'cote-divoire', code: 'CIV', name: "Côte d'Ivoire", group: 'E', aliases: ['Ivory Coast', 'Cote d\'Ivoire', 'Cote dIvoire', 'Cote d Ivoire'] },
  { slug: 'ecuador', code: 'ECU', name: 'Ecuador', group: 'E' },
  { slug: 'curacao', code: 'CUW', name: 'Curaçao', group: 'E', aliases: ['Curacao'] },
  { slug: 'netherlands', code: 'NED', name: 'Netherlands', group: 'F', aliases: ['Holland'] },
  { slug: 'japan', code: 'JPN', name: 'Japan', group: 'F' },
  { slug: 'tunisia', code: 'TUN', name: 'Tunisia', group: 'F' },
  { slug: 'sweden', code: 'SWE', name: 'Sweden', group: 'F' },
  { slug: 'belgium', code: 'BEL', name: 'Belgium', group: 'G' },
  { slug: 'iran', code: 'IRN', name: 'Iran', group: 'G' },
  { slug: 'egypt', code: 'EGY', name: 'Egypt', group: 'G' },
  { slug: 'new-zealand', code: 'NZL', name: 'New Zealand', group: 'G' },
  { slug: 'spain', code: 'ESP', name: 'Spain', group: 'H' },
  { slug: 'uruguay', code: 'URU', name: 'Uruguay', group: 'H' },
  { slug: 'saudi-arabia', code: 'KSA', name: 'Saudi Arabia', group: 'H' },
  { slug: 'cape-verde', code: 'CPV', name: 'Cape Verde', group: 'H' },
  { slug: 'france', code: 'FRA', name: 'France', group: 'I' },
  { slug: 'senegal', code: 'SEN', name: 'Senegal', group: 'I' },
  { slug: 'norway', code: 'NOR', name: 'Norway', group: 'I' },
  { slug: 'iraq', code: 'IRQ', name: 'Iraq', group: 'I' },
  { slug: 'argentina', code: 'ARG', name: 'Argentina', group: 'J' },
  { slug: 'austria', code: 'AUT', name: 'Austria', group: 'J' },
  { slug: 'algeria', code: 'ALG', name: 'Algeria', group: 'J' },
  { slug: 'jordan', code: 'JOR', name: 'Jordan', group: 'J' },
  { slug: 'portugal', code: 'POR', name: 'Portugal', group: 'K' },
  { slug: 'colombia', code: 'COL', name: 'Colombia', group: 'K' },
  { slug: 'uzbekistan', code: 'UZB', name: 'Uzbekistan', group: 'K' },
  { slug: 'dr-congo', code: 'COD', name: 'DR Congo', group: 'K', aliases: ['Democratic Republic of the Congo', 'Congo DR', 'DRC'] },
  { slug: 'england', code: 'ENG', name: 'England', group: 'L' },
  { slug: 'croatia', code: 'CRO', name: 'Croatia', group: 'L' },
  { slug: 'ghana', code: 'GHA', name: 'Ghana', group: 'L' },
  { slug: 'panama', code: 'PAN', name: 'Panama', group: 'L' },
];

const TEAM_BY_SLUG = new Map(WC_TEAMS.map((t) => [t.slug, t]));
const TEAM_BY_CODE = new Map(WC_TEAMS.map((t) => [t.code, t]));

// Lowercase-name lookup including aliases. Names are normalized to a
// punctuation-stripped lowercase form so "Côte d'Ivoire" and "Cote dIvoire"
// both match.
const TEAM_BY_NORMALIZED_NAME = new Map();
for (const t of WC_TEAMS) {
  TEAM_BY_NORMALIZED_NAME.set(normalizeTeamName(t.name), t);
  for (const a of t.aliases || []) {
    TEAM_BY_NORMALIZED_NAME.set(normalizeTeamName(a), t);
  }
  // also key by slug so "Korea-Republic" or just the slug as-is matches
  TEAM_BY_NORMALIZED_NAME.set(normalizeTeamName(t.slug), t);
}

export function normalizeTeamName(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[À-ſ]/g, (ch) => {
      // strip basic latin diacritics
      const map = { ç: 'c', é: 'e', è: 'e', ê: 'e', à: 'a', â: 'a', ô: 'o', ö: 'o', ü: 'u', ñ: 'n', ã: 'a', á: 'a', í: 'i', ó: 'o', ú: 'u', ş: 's', ı: 'i', ğ: 'g', ü: 'u' };
      return map[ch] || ch;
    })
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function lookupTeamBySlug(slug) {
  return TEAM_BY_SLUG.get(slug) || null;
}

export function lookupTeamByCode(code) {
  return TEAM_BY_CODE.get((code || '').toUpperCase()) || null;
}

export function lookupTeamByName(name) {
  if (!name) return null;
  return TEAM_BY_NORMALIZED_NAME.get(normalizeTeamName(name)) || null;
}

// 72 group-stage matches in canonical (G, MD, home_slug, away_slug) tuples.
// Built off the seed in prediction-marketspicks/scripts/seed-wc-simulation.sql.
// Knockout matches are not included here — those entity_ids are minted as
// the draw resolves (PR 4 will extend this).
export const WC_GROUP_MATCHES = [
  ['A', 1, 'mexico', 'korea-republic'],
  ['A', 1, 'south-africa', 'czechia'],
  ['A', 2, 'mexico', 'south-africa'],
  ['A', 2, 'korea-republic', 'czechia'],
  ['A', 3, 'mexico', 'czechia'],
  ['A', 3, 'korea-republic', 'south-africa'],
  ['B', 1, 'canada', 'switzerland'],
  ['B', 1, 'qatar', 'bosnia'],
  ['B', 2, 'canada', 'qatar'],
  ['B', 2, 'switzerland', 'bosnia'],
  ['B', 3, 'canada', 'bosnia'],
  ['B', 3, 'switzerland', 'qatar'],
  ['C', 1, 'brazil', 'morocco'],
  ['C', 1, 'scotland', 'haiti'],
  ['C', 2, 'brazil', 'scotland'],
  ['C', 2, 'morocco', 'haiti'],
  ['C', 3, 'brazil', 'haiti'],
  ['C', 3, 'morocco', 'scotland'],
  ['D', 1, 'united-states', 'paraguay'],
  ['D', 1, 'australia', 'turkiye'],
  ['D', 2, 'united-states', 'australia'],
  ['D', 2, 'paraguay', 'turkiye'],
  ['D', 3, 'united-states', 'turkiye'],
  ['D', 3, 'paraguay', 'australia'],
  ['E', 1, 'germany', 'cote-divoire'],
  ['E', 1, 'ecuador', 'curacao'],
  ['E', 2, 'germany', 'ecuador'],
  ['E', 2, 'cote-divoire', 'curacao'],
  ['E', 3, 'germany', 'curacao'],
  ['E', 3, 'cote-divoire', 'ecuador'],
  ['F', 1, 'netherlands', 'japan'],
  ['F', 1, 'tunisia', 'sweden'],
  ['F', 2, 'netherlands', 'tunisia'],
  ['F', 2, 'japan', 'sweden'],
  ['F', 3, 'netherlands', 'sweden'],
  ['F', 3, 'japan', 'tunisia'],
  ['G', 1, 'belgium', 'iran'],
  ['G', 1, 'egypt', 'new-zealand'],
  ['G', 2, 'belgium', 'egypt'],
  ['G', 2, 'iran', 'new-zealand'],
  ['G', 3, 'belgium', 'new-zealand'],
  ['G', 3, 'iran', 'egypt'],
  ['H', 1, 'spain', 'uruguay'],
  ['H', 1, 'saudi-arabia', 'cape-verde'],
  ['H', 2, 'spain', 'saudi-arabia'],
  ['H', 2, 'uruguay', 'cape-verde'],
  ['H', 3, 'spain', 'cape-verde'],
  ['H', 3, 'uruguay', 'saudi-arabia'],
  ['I', 1, 'france', 'senegal'],
  ['I', 1, 'norway', 'iraq'],
  ['I', 2, 'france', 'norway'],
  ['I', 2, 'senegal', 'iraq'],
  ['I', 3, 'france', 'iraq'],
  ['I', 3, 'senegal', 'norway'],
  ['J', 1, 'argentina', 'austria'],
  ['J', 1, 'algeria', 'jordan'],
  ['J', 2, 'argentina', 'algeria'],
  ['J', 2, 'austria', 'jordan'],
  ['J', 3, 'argentina', 'jordan'],
  ['J', 3, 'austria', 'algeria'],
  ['K', 1, 'portugal', 'colombia'],
  ['K', 1, 'uzbekistan', 'dr-congo'],
  ['K', 2, 'portugal', 'uzbekistan'],
  ['K', 2, 'colombia', 'dr-congo'],
  ['K', 3, 'portugal', 'dr-congo'],
  ['K', 3, 'colombia', 'uzbekistan'],
  ['L', 1, 'england', 'croatia'],
  ['L', 1, 'ghana', 'panama'],
  ['L', 2, 'england', 'ghana'],
  ['L', 2, 'croatia', 'panama'],
  ['L', 3, 'england', 'panama'],
  ['L', 3, 'croatia', 'ghana'],
];

// Index unordered (home_slug, away_slug) → match_id. Markets sometimes list
// "Brazil vs Morocco" and sometimes "Morocco vs Brazil" depending on source —
// both must resolve to match:C-MD1-BRA-MOR.
const MATCH_BY_PAIR = new Map();
for (const [grp, md, h, a] of WC_GROUP_MATCHES) {
  const home = lookupTeamBySlug(h);
  const away = lookupTeamBySlug(a);
  if (!home || !away) continue;
  const id = `match:${grp}-MD${md}-${home.code}-${away.code}`;
  // canonical home-first key
  MATCH_BY_PAIR.set(`${h}|${a}`, { id, group: grp, matchday: md, home: h, away: a });
  // reverse alias for parsers that don't know home/away ordering
  MATCH_BY_PAIR.set(`${a}|${h}`, { id, group: grp, matchday: md, home: h, away: a });
}

export function lookupGroupMatchId(slugA, slugB) {
  if (!slugA || !slugB) return null;
  return MATCH_BY_PAIR.get(`${slugA}|${slugB}`) || null;
}

// Reach-round Kalshi titles use "Round of 16", "Quarterfinals", etc. Map to
// the wc_market_kind enum labels.
const ROUND_PHRASES = [
  { kind: 'reach_r16', patterns: [/round of 16/i, /\br16\b/i, /knockout round/i] },
  { kind: 'reach_qf', patterns: [/quarter[\s-]?final/i, /\bqf\b/i] },
  { kind: 'reach_sf', patterns: [/semi[\s-]?final/i, /\bsf\b/i] },
  { kind: 'reach_final', patterns: [/reach (?:the )?final/i, /make (?:the )?final/i, /\bthe final\b/i] },
];

export function detectReachKind(title) {
  if (typeof title !== 'string') return null;
  for (const r of ROUND_PHRASES) {
    if (r.patterns.some((p) => p.test(title))) return r.kind;
  }
  return null;
}

// Match prop kinds keyed off Kalshi/Polymarket subtitle text.
export function detectMatchPropKind(title) {
  if (typeof title !== 'string') return null;
  if (/\b(both teams to score|btts)\b/i.test(title)) return 'match_btts';
  if (/over 2\.?5/i.test(title)) return 'match_o25';
  if (/\bdraw\b/i.test(title) && /\b(?:winner|outcome|result)\b/i.test(title)) return 'match_winner_draw';
  return null;
}

// American odds → implied probability percent (0–100). Mirrors
// engine/agents/world-cup-odds.ts logic for consistency. Returns null on
// invalid input.
export function americanOddsToImpliedPct(odds) {
  if (typeof odds !== 'number' || !Number.isFinite(odds) || odds === 0) return null;
  const abs = Math.abs(odds);
  const p = odds > 0 ? 100 / (odds + 100) : abs / (abs + 100);
  return p * 100;
}

// 0..1 / 0..100 → integer cents 1–99. Returns null if input is out of band.
// yes_price_cents column is INT NOT NULL with a 1–99 implicit expectation
// (mirrors daily_plays.current_price); we clamp on write.
export function priceToCents(p) {
  if (p == null || !Number.isFinite(p)) return null;
  const pct = p <= 1 ? p * 100 : p; // accept 0..1 or 0..100
  const c = Math.round(pct);
  if (c < 1 || c > 99) return null;
  return c;
}

export const KALSHI_REFERRAL_PARAM = 'b07a96ab-4b91-4bdc-8285-5ae1927b7000';

// Per CLAUDE.md sitemap-locked URL format:
// API tickers have 4+ segments; site routes only on 3-segment event level.
export function kalshiMarketUrl(eventTicker) {
  if (!eventTicker) return null;
  const segments = String(eventTicker).split('-');
  // Drop trailing market segments to land on the 3-segment event ticker.
  const event = segments.slice(0, 3).join('-');
  return `https://kalshi.com/markets/${event}?referral=${KALSHI_REFERRAL_PARAM}&m=true`;
}

export function polymarketMarketUrl(slug) {
  if (!slug) return null;
  return `https://polymarket.com/market/${slug}`;
}

export const __test__ = {
  TEAM_BY_NORMALIZED_NAME,
  MATCH_BY_PAIR,
};
