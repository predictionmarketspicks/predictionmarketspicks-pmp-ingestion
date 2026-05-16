// Shared title matcher — mirror of the tokenize + matchTitles helpers in
// app/api/arb-scanner/route.ts. The pair-discover agent uses this to pre-score
// Kalshi×Polymarket candidates before sending the survivors to the LLM
// confirmer. Keeping these in sync with the request-time fallback in the site
// route prevents the registry from disagreeing with the live-match path on
// what "looks like" a candidate.

const STOP_WORDS = new Set([
  'will', 'the', 'who', 'what', 'when', 'which', 'yes', 'for', 'and',
  'win', 'wins', 'beat', 'beats', 'over', 'under', 'hit', 'hits',
  'this', 'that', 'with', 'from', 'have', 'been', 'more', 'than',
  'before', 'after', 'between', 'during', 'within',
]);

const MONTH_WORDS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]);

export function tokenize(title) {
  const raw = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');
  let year = null;
  let month = null;
  const content = new Set();
  for (const w of raw) {
    if (w.length <= 2) continue;
    if (STOP_WORDS.has(w)) continue;
    if (/^20\d{2}$/.test(w)) { year ??= w; continue; }
    if (MONTH_WORDS.has(w)) { month ??= w; continue; }
    if (/^\d+$/.test(w)) continue;
    content.add(w);
  }
  return { content, year, month };
}

export function matchTitles(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.year && tb.year && ta.year !== tb.year) return 0;
  if (ta.month && tb.month && ta.month !== tb.month) return 0;
  const sharedLong = [...ta.content].filter((w) => w.length >= 4 && tb.content.has(w));
  if (sharedLong.length === 0) return 0;
  const intersection = new Set([...ta.content].filter((w) => tb.content.has(w)));
  const union = new Set([...ta.content, ...tb.content]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}
