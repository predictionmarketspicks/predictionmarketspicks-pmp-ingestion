// #edge-feed budget for the Fly commodity alerts
// (site repo handoffs/DISCORD_CLEANUP_AUTOPILOT_2026-10-25.md F4).
//
// The commodity alerts were 57 of 122 #edge-feed posts in a week because they
// bypassed the site's shared poster (supabase/functions/_shared/discord.ts
// postWithBudget), so the 12/day cap never saw them. This is the same contract,
// in Node:
//   • before posting: RPC discord_budget_remaining(p_channel_id, p_daily_cap)
//   • after a CONFIRMED send: insert discord_posts_log
//     { channel_id, feed: 'commodity', tier, title, message_id, subject_key }
//     subject_key = '<subjectPrefix>:<direction>' (same shape as _shared, so
//     discord_recent_flip reads these rows too)
// plus the commodity rules:
//   • ≤ MAX_POSTS_PER_UNDERLYING_PER_DAY per underlying per ET day
//   • none with < MIN_MINUTES_TO_CLOSE to close
//   • never the same strike + direction twice in a session (ET trading day)
//
// Budget and ledger reads FAIL OPEN like _shared (a dead ledger must not
// silence the feed). The in-process session set still blocks a repeat when the
// ledger is unreadable.

import { sanitize } from '../lib/sanitize.js';
import { etDateKey, etDayStart } from '../lib/et-time.js';

export const EDGE_FEED_CHANNEL_ID = '1487857830391451750';
export const ORACLE_PICKS_CHANNEL_ID = '1487857828084584528';
// Daily caps per channel — mirror _shared/discord.ts CHANNEL_CAPS.
export const CHANNEL_DAILY_CAP = {
  [EDGE_FEED_CHANNEL_ID]: 12,
  [ORACLE_PICKS_CHANNEL_ID]: 5,
};
export const COMMODITY_FEED = 'commodity';
export const MAX_POSTS_PER_UNDERLYING_PER_DAY = 2;
export const MIN_MINUTES_TO_CLOSE = 45;

export function commoditySubjectPrefix(commodity, strike) {
  return `commodity:${commodity}:${Number(strike).toFixed(2)}`;
}

export function directionSide(direction) {
  return String(direction ?? '').toUpperCase().includes('NO') ? 'NO' : 'YES';
}

export function commoditySubjectKey(commodity, edge) {
  return `${commoditySubjectPrefix(commodity, edge.strike)}:${directionSide(edge.direction)}`;
}

export function minutesToClose(meta, now = new Date()) {
  if (meta?.eventCloseAt) {
    const t = new Date(meta.eventCloseAt).getTime();
    if (Number.isFinite(t)) return (t - now.getTime()) / 60_000;
  }
  if (Number.isFinite(meta?.hoursToClose)) return meta.hoursToClose * 60;
  return null;
}

// Pure gate. Returns { ok: true } or { ok: false, reason }.
//   todayKeys     — subject_keys this underlying posted today (ET), or null if
//                   the ledger read failed (fail open on the count)
//   budgetLeft    — RPC result, or null if it failed (fail open)
//   sessionKeys   — in-process Set of `${etDate}|${subject_key}` already sent
export function commodityGate({ meta, edge, todayKeys, budgetLeft, sessionKeys, now = new Date() }) {
  const mins = minutesToClose(meta, now);
  if (mins != null && mins < MIN_MINUTES_TO_CLOSE) return { ok: false, reason: 'near_close' };
  const subject = commoditySubjectKey(meta.commodity, edge);
  if (sessionKeys?.has(`${etDateKey(now)}|${subject}`)) return { ok: false, reason: 'repeat_session' };
  if (Array.isArray(todayKeys)) {
    if (todayKeys.includes(subject)) return { ok: false, reason: 'repeat_session' };
    if (todayKeys.length >= MAX_POSTS_PER_UNDERLYING_PER_DAY) return { ok: false, reason: 'underlying_cap' };
  }
  if (typeof budgetLeft === 'number' && budgetLeft <= 0) return { ok: false, reason: 'budget' };
  return { ok: true };
}

export async function fetchBudgetRemaining(sb, channelId) {
  const cap = CHANNEL_DAILY_CAP[channelId];
  if (cap == null) return null;
  try {
    const { data, error } = await sb.rpc('discord_budget_remaining', {
      p_channel_id: channelId,
      p_daily_cap: cap,
    });
    if (error) throw error;
    return typeof data === 'number' ? data : null;
  } catch (err) {
    console.warn('[discord-budget] budget read failed, posting open:', err?.message || err);
    return null;
  }
}

// subject_keys this underlying posted to Discord since 00:00 ET, or null.
export async function fetchUnderlyingKeysToday(sb, commodity, now = new Date()) {
  try {
    const { data, error } = await sb
      .from('discord_posts_log')
      .select('subject_key')
      .eq('feed', COMMODITY_FEED)
      .like('subject_key', `commodity:${commodity}:%`)
      .gte('posted_at', etDayStart(now).toISOString());
    if (error) throw error;
    return (data ?? []).map((r) => r.subject_key).filter(Boolean);
  } catch (err) {
    console.warn('[discord-budget] ledger read failed, posting open:', err?.message || err);
    return null;
  }
}

export async function logCommodityPost(sb, { channelId, tier, title, messageId, subjectKey }) {
  try {
    const { error } = await sb.from('discord_posts_log').insert({
      channel_id: channelId,
      feed: COMMODITY_FEED,
      tier: tier ?? null,
      title: sanitize(title ?? '', 300),
      message_id: messageId ?? null,
      subject_key: subjectKey ?? null,
    });
    if (error) throw error;
    return true;
  } catch (err) {
    // A ledger write must not un-send a message.
    console.warn('[discord-budget] posts_log insert failed:', err?.message || err);
    return false;
  }
}
