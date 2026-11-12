// Database heartbeat — a freeze alarm that lives OUTSIDE the database
// (prediction-marketspicks handoffs/DB_FREEZE_ROOT_CAUSE_AND_HARDENING_2026-11-11.md U1).
//
// WHY. engine-health-watch runs on pg_cron inside Supabase, so when the database froze (Nov 7–11 2026:
// one crash, a 20-min blackout, seven 1–6 min freezes) the watcher froze with it and missed exactly those
// minutes. This loop runs on Fly: every 30 s it calls public.db_ping() (service_role only) with a 5 s abort.
//
//   ok    answered in < 2 s        slow  answered in 2–5 s        down  error or abort
//
// Alarms go to #bot-logs through postBotLog — the same poster the P0-B outage alarms use, not a second one:
//   - 3 consecutive `down` beats (≈ 90 s): "Database not answering for 90 s (last error: …)";
//     repeats at most every 10 min while it lasts;
//   - 2 consecutive `ok` beats after that: ONE recovery line with the outage length;
//   - 6 consecutive `slow` beats (3 min of degraded latency): one alarm per episode.
// /health shows it as feed `db_heartbeat`, NOT required — it must never turn /health 503.
//
// stepHeartbeat() is pure (state in, state + posts out) so the test drives it with a fake clock.

import { getClient } from '../delivery/supabase.js';
import { postBotLog } from '../delivery/discord.js';
import { registerFeed, setFeedStatus } from './health.js';

export const BEAT_MS = 30 * 1000;
export const ABORT_MS = 5 * 1000;
export const SLOW_MS = 2 * 1000;
export const DOWN_ALARM_BEATS = 3;
export const RECOVER_BEATS = 2;
export const SLOW_ALARM_BEATS = 6;
export const REPEAT_MS = 10 * 60 * 1000;
export const FEED = 'db_heartbeat';

export function initialHeartbeat() {
  return {
    state: 'unknown',
    consecDown: 0,
    consecOk: 0,
    consecSlow: 0,
    downSince: null, // ms of the first failing beat of the current run of failures
    inOutage: false,
    lastAlarmAt: null,
    slowAlarmed: false,
    lastLatencyMs: null,
    lastError: null,
  };
}

/** Classify one ping result. `latencyMs` is measured by the caller; `error` is set on failure or abort. */
export function classifyBeat({ latencyMs, error }) {
  if (error) return 'down';
  return latencyMs >= SLOW_MS ? 'slow' : 'ok';
}

const secs = (ms) => Math.round(ms / 1000);

/**
 * One beat. Returns { next, posts } — `posts` are the #bot-logs lines to send now (usually none).
 * @param {ReturnType<typeof initialHeartbeat>} prev
 * @param {{ kind: 'ok'|'slow'|'down', latencyMs?: number|null, error?: string|null }} beat
 * @param {number} nowMs
 */
export function stepHeartbeat(prev, beat, nowMs) {
  const s = { ...prev, state: beat.kind, lastLatencyMs: beat.latencyMs ?? null };
  const posts = [];

  if (beat.kind === 'down') {
    s.consecDown = prev.consecDown + 1;
    s.consecOk = 0;
    s.consecSlow = 0;
    s.lastError = beat.error ?? 'unknown error';
    s.downSince = prev.downSince ?? nowMs;
    if (s.consecDown >= DOWN_ALARM_BEATS) {
      const due = !prev.inOutage || prev.lastAlarmAt == null || nowMs - prev.lastAlarmAt >= REPEAT_MS;
      s.inOutage = true;
      if (due) {
        // The outage is counted from the last good beat: 3 failed beats ≈ 90 s.
        const forS = secs(nowMs - s.downSince + BEAT_MS);
        posts.push(`🚨 OUTAGE — Database not answering for ${forS} s (last error: ${String(s.lastError).slice(0, 300)}). db_ping from pmp-ingestion on Fly, every ${secs(BEAT_MS)} s. Check the Supabase memory/swap chart.`);
        s.lastAlarmAt = nowMs;
      }
    }
    return { next: s, posts };
  }

  // The database answered (ok or slow).
  s.consecDown = 0;
  s.lastError = null;

  if (beat.kind === 'ok') {
    s.consecOk = prev.consecOk + 1;
    s.consecSlow = 0;
    s.slowAlarmed = false;
    if (prev.inOutage) {
      if (s.consecOk >= RECOVER_BEATS) {
        const lenS = secs(nowMs - prev.downSince);
        posts.push(`✅ Database answering again — outage lasted about ${lenS} s (from the first failed db_ping to the 2nd good one).`);
        s.inOutage = false;
        s.downSince = null;
        s.lastAlarmAt = null;
      }
    } else {
      // A 1–2 beat blip that never alarmed: forget it.
      s.downSince = null;
    }
    return { next: s, posts };
  }

  // slow
  s.consecOk = 0;
  s.consecSlow = prev.consecSlow + 1;
  if (!prev.inOutage) s.downSince = null;
  if (s.consecSlow >= SLOW_ALARM_BEATS && !prev.slowAlarmed && !prev.inOutage) {
    posts.push(`⚠️ Database slow — db_ping took ${beat.latencyMs ?? '?'} ms; ${s.consecSlow} beats in a row over ${SLOW_MS} ms (≈ ${secs(s.consecSlow * BEAT_MS)} s of degraded latency).`);
    s.slowAlarmed = true;
  }
  return { next: s, posts };
}

/** One ping against the live database. Never throws. */
export async function pingDb(client = getClient()) {
  const started = Date.now();
  try {
    const { error } = await client.rpc('db_ping').abortSignal(AbortSignal.timeout(ABORT_MS));
    const latencyMs = Date.now() - started;
    return { latencyMs, error: error ? (error.message || String(error)) : null };
  } catch (err) {
    return { latencyMs: Date.now() - started, error: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `no answer in ${ABORT_MS} ms` : (err?.message || String(err)) };
  }
}

function publish(s) {
  setFeedStatus(FEED, {
    connected: s.state === 'ok' || s.state === 'slow',
    lastError: s.lastError,
    ...(s.state === 'ok' || s.state === 'slow' ? { lastTickAt: Date.now() } : {}),
    extra: { state: s.state, lastLatencyMs: s.lastLatencyMs, downSince: s.downSince ? new Date(s.downSince).toISOString() : null },
  });
}

let timer = null;

/** Start the 30 s loop. Idempotent. */
export function startDbHeartbeat({ client, post = postBotLog } = {}) {
  if (timer) return;
  registerFeed(FEED); // descriptive only — never markFeedRequired
  let s = initialHeartbeat();
  let busy = false;
  const beat = async () => {
    if (busy) return; // a beat can never overlap the next (abort is 5 s, interval 30 s)
    busy = true;
    try {
      const r = await pingDb(client ?? getClient());
      const { next, posts } = stepHeartbeat(s, { kind: classifyBeat(r), latencyMs: r.latencyMs, error: r.error }, Date.now());
      s = next;
      publish(s);
      for (const line of posts) {
        try { await post(line); } catch (err) { console.warn(`[db-heartbeat] discord post failed: ${err?.message || err}`); }
      }
    } finally {
      busy = false;
    }
  };
  beat();
  timer = setInterval(beat, BEAT_MS);
  timer.unref?.();
}

export function stopDbHeartbeat() {
  if (timer) clearInterval(timer);
  timer = null;
}
