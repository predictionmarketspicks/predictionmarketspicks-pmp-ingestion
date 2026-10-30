// Polymarket US new-horizon detector — W3-lite of
// prediction-marketspicks/handoffs/POLYMARKET_REFERRAL_CODE_AND_POLY_US_REAL_ESTATE_2026-10-29.md.
//
// Polymarket US's 2026-10-20 CFTC filing adds 30-minute and 4-hour bitcoin windows, listing "no earlier
// than November 3, 2026". Whoever has a page the day they list owns those searches, so this watches for
// the first one and tells #bot-logs; Claude Code then flips the site pages on the same day.
//
// How: once an hour, page through the public gateway's active-events census
// (GET /v1/events?active=true&closed=false, 500 a page, ~12 pages) and collect every
// `<coin>-updown-<horizon>-…` slug. Any horizon outside KNOWN_HORIZONS is new. Reading the census, not
// guessed slugs, means an unexpected slug format or window alignment can't hide a listing.
//
// Alerts once per horizon per process (a restart re-alerts once — acceptable for a once-ever event).
// Information only: nothing prices off it, not a required feed. POLY_US_HORIZON_DETECTOR_ENABLED=0 off.

import { postBotLog } from '../delivery/discord.js';
import { registerFeed, recordTick, setFeedStatus } from '../observability/health.js';

export const FEED = 'poly_us_horizon_detector';
const GATEWAY = 'https://gateway.polymarket.us';
/** Horizons the site already covers or Polymarket US already lists (census 2026-10-30: 5m 15m 1h 1d). */
export const KNOWN_HORIZONS = new Set(['5m', '15m', '1h', '1d']);
const PAGE = 500;
const MAX_PAGES = 40;
const EVERY_MS = 60 * 60_000;

const SLUG_RE = /^([a-z]+)-updown-([0-9]+[a-z]+)-/;

/** `{ horizon: [slug, …] }` for every up/down slug whose horizon isn't known yet. */
export function newHorizons(slugs) {
  const found = {};
  for (const slug of slugs) {
    const m = SLUG_RE.exec(slug ?? '');
    if (!m || KNOWN_HORIZONS.has(m[2])) continue;
    (found[m[2]] ??= []).push(slug);
  }
  return found;
}

async function censusSlugs() {
  const slugs = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(`${GATEWAY}/v1/events?active=true&closed=false&limit=${PAGE}&offset=${page * PAGE}`, {
      headers: { 'User-Agent': 'PredictionMarketsPicks/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`gateway census ${res.status} at offset ${page * PAGE}`);
    const events = (await res.json())?.events ?? [];
    for (const e of events) slugs.push(e?.slug);
    if (events.length < PAGE) break;
  }
  return slugs;
}

const alerted = new Set();

export async function detectOnce() {
  const found = newHorizons(await censusSlugs());
  for (const [horizon, slugs] of Object.entries(found)) {
    if (alerted.has(horizon)) continue;
    alerted.add(horizon);
    await postBotLog(
      `Polymarket US just listed a new up/down horizon: ${horizon} (${slugs.length} active, e.g. ${slugs[0]}). ` +
        'Flip the site pages today (handoff POLYMARKET_REFERRAL_CODE_AND_POLY_US_REAL_ESTATE_2026-10-29 W3), ' +
        'then add the horizon to polymarket-us-updown.js HORIZONS.',
    ).catch((err) => console.warn('[poly-us-horizon] bot-log post failed', err?.message ?? err));
  }
  return found;
}

export function startPolymarketUsHorizonDetector() {
  if (process.env.POLY_US_HORIZON_DETECTOR_ENABLED === '0') {
    registerFeed(FEED);
    setFeedStatus(FEED, { enabled: false });
    console.log('[poly-us-horizon] disabled (POLY_US_HORIZON_DETECTOR_ENABLED=0)');
    return;
  }
  registerFeed(FEED);
  setFeedStatus(FEED, { enabled: true });
  const run = () =>
    detectOnce()
      .then((found) => { recordTick(FEED); setFeedStatus(FEED, { newHorizons: Object.keys(found), lastError: null }); })
      .catch((err) => {
        setFeedStatus(FEED, { lastError: err?.message ?? String(err), lastErrorAt: Date.now() });
        console.warn('[poly-us-horizon]', err?.message ?? err);
      });
  run();
  setInterval(run, EVERY_MS).unref?.();
}
