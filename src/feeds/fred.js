// FRED daily-close client. Used by commodity-base.js to cross-check Pyth /
// Yahoo realtime spot against FRED's authoritative daily settle. When the two
// diverge > 150bp, the realtime feed is probably stale and the engine demotes
// the signal one tier (or suppresses it). This is a stale-feed false-signal
// suppressor — not a new edge source.
//
// FRED publishes once per business day, so a 4-hour in-process cache is all
// we need. Fail open: any fetch error returns null and the engine treats
// "no cross-check this round" as benign.

import { setFeedStatus, recordTick } from '../observability/health.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

const cache = new Map(); // seriesId → { price, observation_date, age_hours, fetchedAt }

function feedKey(seriesId) {
  return `fred_${seriesId.toLowerCase()}`;
}

export async function getFredDailyClose(seriesId) {
  if (!seriesId) return null;
  if (!process.env.FRED_API_KEY) {
    setFeedStatus(feedKey(seriesId), {
      connected: false,
      lastError: 'FRED_API_KEY not set',
    });
    return null;
  }

  const now = Date.now();
  const hit = cache.get(seriesId);
  if (hit && now - hit.fetchedAt < CACHE_TTL_MS) {
    return hit;
  }

  const url = new URL(FRED_BASE);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', process.env.FRED_API_KEY);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', '1');

  const key = feedKey(seriesId);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'pmp-ingestion/0.1',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`FRED ${res.status}`);
    const json = await res.json();
    const obs = json?.observations?.[0];
    // FRED uses "." as a sentinel for missing observations.
    if (!obs || obs.value == null || obs.value === '.') {
      setFeedStatus(key, { connected: false, lastError: 'no observation' });
      return null;
    }
    const price = Number(obs.value);
    if (!Number.isFinite(price) || price <= 0) {
      setFeedStatus(key, { connected: false, lastError: `bad value: ${obs.value}` });
      return null;
    }
    const observationDate = obs.date;
    const result = {
      seriesId,
      price,
      observation_date: observationDate,
      age_hours: (now - new Date(observationDate).getTime()) / 3_600_000,
      fetchedAt: now,
    };
    cache.set(seriesId, result);
    recordTick(key);
    setFeedStatus(key, { connected: true, lastError: null });
    return result;
  } catch (err) {
    const msg = (err?.message || String(err)).slice(0, 240);
    setFeedStatus(key, { connected: false, lastError: msg });
    console.warn(`[fred] ${seriesId} fetch failed: ${msg}`);
    return null;
  }
}

export function __clearFredCacheForTest() {
  cache.clear();
}
