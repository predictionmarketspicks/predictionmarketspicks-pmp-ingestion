// Shared staging loader for the external-benchmark feeds (NFL grades/DVOA
// fusion Phase 1, handoffs/NFL_GRADES_DVOA_FUSION_2026-06-20.md).
//
// SWAPPABLE FETCH LAYER (§5a): today fetchOnce() reads a staging JSON file that
// a Claude-in-Chrome session drops under data/ext-staging/<feed>.json (driven
// through Benny's logins, like gsc-wc-indexing-daily). Once the source is
// licensed, only this loader's body flips to a CSV/API pull — the normalizers,
// delivery upserts, and runner downstream do not change. Real staging files are
// gitignored (raw external data is internal-only); committed *.example.json
// templates document the expected row shape.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/feeds/ → repo-root/data/ext-staging
const STAGING_DIR = path.resolve(__dirname, '..', '..', 'data', 'ext-staging');

export function stagingPathFor(feed) {
  return path.join(STAGING_DIR, `${feed}.json`);
}

// mtime of a staging file in epoch ms, or null when it doesn't exist. Staging
// files are never cleared, so a capture that failed entirely leaves the PREVIOUS
// run's file on disk — which then normalizes to exactly the expected row count
// and reads as a healthy feed. That is how a dead PFF session went unnoticed for
// six weeks (handoffs/NFL_EXT_FEEDS_RELIABILITY_FIXES_2026-08-03.md §3). mtime is
// the only signal separating a fresh capture from a fossil, since the count can't.
export function stagingMtimeMs(feed, stagingPath) {
  const file = stagingPath || stagingPathFor(feed);
  if (!fs.existsSync(file)) return null;
  return fs.statSync(file).mtimeMs;
}

// Age in hours, or null when the file doesn't exist. Can read a hair NEGATIVE —
// the filesystem's mtime occasionally lands a fraction of a millisecond ahead of
// Date.now(). Callers gate on `age > limit`, so that's harmless.
export function stagingAgeHours(feed, stagingPath) {
  const mtime = stagingMtimeMs(feed, stagingPath);
  return mtime == null ? null : (Date.now() - mtime) / 3_600_000;
}

// Was this file written TODAY (local time)? This is the DAY boundary, matching
// the `find -daystart -mtime +0` gate in skills/nfl-ext-feeds-capture/SKILL.md §5
// — deliberately NOT a rolling window. A capture session legitimately runs for
// hours, so a rolling window false-flags a file that same session just wrote
// (verified 8/3: a 60-minute gate marked that morning's own dvoa-team.json
// stale). False positives are not harmless here — they train the operator to
// wave the gate through, which is exactly how a real fossil gets in.
export function isCapturedToday(feed, stagingPath, now = new Date()) {
  const mtime = stagingMtimeMs(feed, stagingPath);
  if (mtime == null) return null;
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return mtime >= startOfDay;
}

// Decide the season for a feed. The staging file WINS over --season: in the
// offseason the feeds straddle two seasons (grades/DVOA describe the completed
// one, power-ranks/free-agency the upcoming one), so a single --season applied
// across a multi-feed run silently rewrites one of them. A disagreement is a
// hard error rather than a silent preference, because the operator passing
// --season believes something about the file that isn't true.
export function resolveSeason(feed, cliSeason, fileSeason) {
  if (fileSeason != null && cliSeason != null && Number(fileSeason) !== Number(cliSeason)) {
    const err = new Error(
      `[${feed}] season mismatch: --season=${cliSeason} but the staging file says ${fileSeason}. ` +
        `The file wins — drop --season for this feed, or fix the file. ` +
        `Offseason feeds straddle seasons: grades/DVOA are the completed season, power-ranks/free-agency the upcoming one.`,
    );
    // Tagged so the runner can exit non-zero on it rather than logging it as an
    // ordinary skip — writing one season's rows under another's label is silent
    // cross-season corruption, not a missing-file no-op.
    err.code = 'SEASON_MISMATCH';
    throw err;
  }
  const yr = fileSeason ?? cliSeason;
  if (!yr) throw new Error(`[${feed}] season is required (pass --season or set "season" in the staging file)`);
  return Number(yr);
}

// Read + parse a staging file into an array of raw row objects. Throws a
// pointed error (not a bare ENOENT) when the file is missing or malformed so the
// runner output tells the operator exactly what to capture next.
export function loadStagingRows(feed, stagingPath) {
  const file = stagingPath || stagingPathFor(feed);
  if (!fs.existsSync(file)) {
    throw new Error(
      `[${feed}] no staging file at ${file}. Capture this season into it (see ${feed}.example.json for the shape), then re-run.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`[${feed}] staging file ${file} is not valid JSON: ${err.message}`);
  }
  // Accept either a bare array or { rows: [...] } / { season, rows: [...] }.
  const rows = Array.isArray(parsed) ? parsed : parsed?.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`[${feed}] staging file ${file} must be a JSON array or { rows: [...] }`);
  }
  const season = Array.isArray(parsed) ? undefined : parsed?.season;
  return { rows, season };
}
