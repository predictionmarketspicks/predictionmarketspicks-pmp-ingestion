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
