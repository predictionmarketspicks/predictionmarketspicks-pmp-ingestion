// Canonical NFL team resolver for the external-benchmark feeds (grades / DVOA /
// power ranks / free agency). Maps the many ways an external source spells a
// team — full name, city, nickname, common abbreviations — onto the
// gridiron_edge team code (KC, LA=Rams, LAC=Chargers, SF=49ers, WAS=Commanders)
// so every ext_* row joins directly against nfl_team_ratings / nfl_* tables in
// the Phase 2 fusion. Translate to Kalshi codes only at the Kalshi boundary.
//
// The 32 codes match data/nfl-divisions.json in the site repo (the single
// source of truth). Resolution is case-insensitive and punctuation-tolerant.

export const NFL_TEAM_CODES = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE',
  'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC',
  'LA', 'LAC', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS',
];

// Each code → the aliases an external feed might use. Codes themselves resolve
// idempotently. Keys are normalized (lowercased, alnum-only) at build time.
const ALIASES = {
  ARI: ['arizona', 'cardinals', 'arizona cardinals', 'crd', 'arz'],
  ATL: ['atlanta', 'falcons', 'atlanta falcons'],
  BAL: ['baltimore', 'ravens', 'baltimore ravens', 'rav', 'blt'],
  BUF: ['buffalo', 'bills', 'buffalo bills'],
  CAR: ['carolina', 'panthers', 'carolina panthers'],
  CHI: ['chicago', 'bears', 'chicago bears'],
  CIN: ['cincinnati', 'bengals', 'cincinnati bengals'],
  CLE: ['cleveland', 'browns', 'cleveland browns', 'clv'],
  DAL: ['dallas', 'cowboys', 'dallas cowboys'],
  DEN: ['denver', 'broncos', 'denver broncos'],
  DET: ['detroit', 'lions', 'detroit lions'],
  GB: ['green bay', 'packers', 'green bay packers', 'gnb'],
  HOU: ['houston', 'texans', 'houston texans', 'hst'],
  IND: ['indianapolis', 'colts', 'indianapolis colts', 'clt'],
  JAX: ['jacksonville', 'jaguars', 'jacksonville jaguars', 'jac'],
  KC: ['kansas city', 'chiefs', 'kansas city chiefs', 'kan'],
  LA: ['los angeles rams', 'la rams', 'rams', 'lar', 'st louis rams'],
  LAC: ['los angeles chargers', 'la chargers', 'chargers', 'san diego chargers', 'sd'],
  LV: ['las vegas', 'raiders', 'las vegas raiders', 'oakland raiders', 'oak', 'lvr'],
  MIA: ['miami', 'dolphins', 'miami dolphins'],
  MIN: ['minnesota', 'vikings', 'minnesota vikings'],
  NE: ['new england', 'patriots', 'new england patriots', 'nwe'],
  NO: ['new orleans', 'saints', 'new orleans saints', 'nor'],
  NYG: ['new york giants', 'ny giants', 'giants'],
  NYJ: ['new york jets', 'ny jets', 'jets'],
  PHI: ['philadelphia', 'eagles', 'philadelphia eagles'],
  PIT: ['pittsburgh', 'steelers', 'pittsburgh steelers'],
  SEA: ['seattle', 'seahawks', 'seattle seahawks'],
  SF: ['san francisco', '49ers', 'niners', 'san francisco 49ers', 'sfo'],
  TB: ['tampa bay', 'buccaneers', 'bucs', 'tampa bay buccaneers', 'tam'],
  TEN: ['tennessee', 'titans', 'tennessee titans'],
  WAS: ['washington', 'commanders', 'washington commanders', 'washington football team', 'redskins', 'wsh'],
};

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const LOOKUP = new Map();
for (const code of NFL_TEAM_CODES) {
  LOOKUP.set(norm(code), code);
}
for (const [code, aliases] of Object.entries(ALIASES)) {
  for (const a of aliases) LOOKUP.set(norm(a), code);
}

// Resolve any external team string to its gridiron_edge code, or null if it
// can't be matched (caller should drop the row and log — never guess).
export function resolveTeamCode(input) {
  if (input == null) return null;
  return LOOKUP.get(norm(input)) ?? null;
}
