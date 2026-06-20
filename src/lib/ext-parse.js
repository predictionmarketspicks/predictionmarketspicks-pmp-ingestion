// Shared coercion helpers for the external-benchmark feed normalizers. External
// captures arrive as strings ("18.2%", "$12.5M", "11th/119", "—") regardless of
// whether they came from a Claude-in-Chrome scrape or a licensed CSV export, so
// every numeric goes through one of these. All return null on missing/garbage —
// never NaN, never a guessed 0 (a real 0 and a missing value must stay distinct
// downstream for the fusion math).

// "—", "-", "", "N/A", null all read as missing.
function isBlank(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return s === '' || s === '-' || s === '—' || /^n\/?a$/i.test(s);
}

// Plain number. Strips $ , % and whitespace. "18.2%" → 18.2, "$1,250,000" → 1250000.
export function num(v) {
  if (isBlank(v)) return null;
  const s = String(v).replace(/[$,%\s]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Integer (rounds). "11" → 11, "11th" → 11, "R2" → 2 (first run of digits).
export function int(v) {
  if (isBlank(v)) return null;
  const m = String(v).match(/-?\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

// Percentage → fraction. "62%" → 0.62, "0.62" → 0.62 (already a fraction passes
// through unchanged when ≤ 1). Anything > 1 is treated as a whole percent.
export function pct(v) {
  const n = num(v);
  if (n == null) return null;
  // Whole-percent (incl. negative, e.g. "-9.4%") → fraction; values already in
  // [-1, 1] pass through unchanged.
  return Math.abs(n) > 1 ? n / 100 : n;
}

// Dollar amount with M/K/B suffix. "$12.5M" → 12500000, "900K" → 900000.
export function dollars(v) {
  if (isBlank(v)) return null;
  const s = String(v).replace(/[$,\s]/g, '');
  const m = s.match(/^(-?\d*\.?\d+)\s*([kmb])?$/i);
  if (!m) return num(v);
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return base * mult;
}

// Boolean from a flag cell. true for "y"/"yes"/"true"/"1"/"x".
export function bool(v) {
  if (isBlank(v)) return null;
  return /^(y|yes|true|1|x)$/i.test(String(v).trim());
}

// Trimmed string, or null if blank.
export function str(v) {
  if (isBlank(v)) return null;
  return String(v).trim();
}

// Stable synthetic player id when no vendor id is captured: name + team + pos,
// normalized. e.g. ("Patrick Mahomes", "KC", "QB") → "patrick-mahomes-kc-qb".
export function playerSlug(name, team, position) {
  const parts = [name, team, position]
    .map((p) => String(p ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  return parts.join('-');
}
