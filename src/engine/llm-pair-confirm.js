// LLM pair confirmer — single Anthropic Messages API call per batch.
//
// Two-pass routing per handoffs/ARB_SCANNER_SWING4_FINISH_2026-05-15.md §4d:
//   - Haiku 4.5 on the full batch (cheap first pass).
//   - Sonnet 4.6 only on verdicts whose confidence lands in the ambiguous
//     band 0.6 <= c <= 0.85 — re-confirms before storing.
//
// We deliberately use raw fetch instead of @anthropic-ai/sdk so this module
// adds zero dependencies. Anthropic's REST surface for /v1/messages is small
// and stable enough; if we ever need streaming or tool-use we can revisit.
//
// JSON-only contract: every batch response is parsed strictly. A single bad
// JSON parse drops the WHOLE batch — better than fabricating verdicts. The
// fall-through is logged and the caller treats those candidates as if the
// agent never saw them (they'll be re-scored next run).

const ANTHROPIC_API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

const HAIKU_MODEL = process.env.PAIR_CONFIRM_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
const SONNET_MODEL = process.env.PAIR_CONFIRM_SONNET_MODEL || 'claude-sonnet-4-6';

// Sonnet 4.6 list pricing as of May 2026: $3/M input, $15/M output.
// Haiku 4.5 is roughly 1/4 of Sonnet. These are coarse estimates used only
// for the cost-ceiling guard — fine for "should we abort this run" decisions,
// not for billing.
const COST_PER_MTOK = {
  [HAIKU_MODEL]:  { input: 0.80, output: 4.00 },
  [SONNET_MODEL]: { input: 3.00, output: 15.00 },
};

function estimateBatchCost(usage, model) {
  const px = COST_PER_MTOK[model];
  if (!px || !usage) return 0;
  return (
    ((usage.input_tokens || 0) * px.input + (usage.output_tokens || 0) * px.output) / 1_000_000
  );
}

const SYSTEM_PROMPT = `You classify whether two prediction markets resolve to the same underlying real-world outcome.

For each pair, return one verdict object:
  match: one of "identical" | "similar" | "related" | "none"
    - identical: same event, same threshold, same window. A YES on one is YES on the other with probability 1.0.
    - similar: same direction and intent, but different trigger or window (e.g. NBER recession declaration vs 2-quarter GDP contraction).
    - related: same topic but different question (e.g. Trump approval rating vs Trump 2028 nominee).
    - none: not the same outcome at all.
  confidence: 0.00 to 1.00 — how sure you are. Reserve >= 0.9 for identical with no ambiguity.
  reason: one short sentence (max 24 words). Cite the specific resolution clause if it matters.

Use the language of prediction markets: "two prediction markets", "contract", "resolves YES". Never "bet" / "wager" / "bettor".

Output rules:
  - JSON-only. No prose. No code fences.
  - A single top-level array, same order and length as the input pairs.
  - Each element is exactly {"match": "...", "confidence": <number>, "reason": "..."}.
  - If you cannot judge a pair, return match="none" with confidence=0.5 and a reason explaining why — never omit elements.
`;

function renderUserPrompt(batch) {
  const lines = batch.map((c, i) => {
    const k = c.kalshi;
    const p = c.polymarket;
    return [
      `Pair ${i + 1}:`,
      `  A (Kalshi, ${k.ticker}): "${k.title}"`,
      `  B (Polymarket, ${p.condition_id}): "${p.question}"`,
    ].join('\n');
  });
  return [
    `Classify each of the following ${batch.length} prediction-market pairs.`,
    '',
    ...lines,
    '',
    'Respond with a JSON array of verdicts in the same order.',
  ].join('\n');
}

async function callAnthropic({ apiKey, model, system, user, maxTokens = 1024 }) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status}: ${text.slice(0, 240)}`);
  }
  return await res.json();
}

function parseVerdicts(responseJson, expectedLen) {
  const block = responseJson?.content?.[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('no text block in response');
  }
  let text = block.text.trim();
  // Defensive — strip a code fence if the model emits one despite the prompt.
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('verdicts not array');
  if (parsed.length !== expectedLen) {
    throw new Error(`verdict length ${parsed.length} !== ${expectedLen}`);
  }
  for (const v of parsed) {
    if (!v || typeof v !== 'object') throw new Error('verdict not object');
    if (!['identical', 'similar', 'related', 'none'].includes(v.match)) {
      throw new Error(`bad verdict.match: ${v.match}`);
    }
    if (!Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) {
      throw new Error(`bad verdict.confidence: ${v.confidence}`);
    }
    v.reason = typeof v.reason === 'string' ? v.reason.slice(0, 240) : '';
  }
  return parsed;
}

// confirmBatch — single round trip. Returns { verdicts, model, usage, costUsd }.
// Throws on transport or parse failures so the caller can decide whether to
// skip the whole batch.
export async function confirmBatch(batch, { apiKey, model }) {
  if (!Array.isArray(batch) || batch.length === 0) {
    return { verdicts: [], model, usage: null, costUsd: 0 };
  }
  const user = renderUserPrompt(batch);
  const response = await callAnthropic({
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    user,
    maxTokens: Math.max(512, batch.length * 120),
  });
  const verdicts = parseVerdicts(response, batch.length);
  const usage = response?.usage ?? null;
  return { verdicts, model, usage, costUsd: estimateBatchCost(usage, model) };
}

// confirmPairsTwoPass — full Haiku→Sonnet flow over an array of candidates.
//
// Step 1: run Haiku on chunks of `chunkSize`.
// Step 2: re-run Sonnet on any verdict whose confidence lands in
//         [SONNET_BAND_LOW, SONNET_BAND_HIGH] (default 0.6–0.85).
// Step 3: merge — Sonnet's verdict replaces Haiku's for the same index.
//
// Aborts early if cost ceiling trips (cap defaults to $0.50 / run).
export async function confirmPairsTwoPass(
  candidates,
  {
    apiKey,
    chunkSize = 10,
    sonnetBandLow = 0.6,
    sonnetBandHigh = 0.85,
    costCeilingUsd = 0.5,
  } = {},
) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
  if (candidates.length === 0) {
    return { verdicts: [], model_breakdown: { haiku: 0, sonnet: 0 }, costUsd: 0, batches: 0, aborted: false };
  }

  const verdicts = new Array(candidates.length).fill(null);
  let totalCost = 0;
  let batches = 0;
  let haikuBatches = 0;
  let sonnetBatches = 0;
  let consecutiveExpensive = 0;
  let aborted = false;

  // --- Pass 1: Haiku ---
  for (let i = 0; i < candidates.length; i += chunkSize) {
    if (aborted) break;
    const chunk = candidates.slice(i, i + chunkSize);
    try {
      const { verdicts: vs, usage, costUsd } = await confirmBatch(chunk, {
        apiKey,
        model: HAIKU_MODEL,
      });
      vs.forEach((v, j) => { verdicts[i + j] = { ...v, _model: HAIKU_MODEL }; });
      totalCost += costUsd;
      batches += 1;
      haikuBatches += 1;
      if (costUsd > 0.05) {
        consecutiveExpensive += 1;
        if (consecutiveExpensive >= 5) {
          console.warn(`[pair-confirm] 5 consecutive batches > $0.05 — aborting run (cost=$${totalCost.toFixed(3)})`);
          aborted = true;
          break;
        }
      } else {
        consecutiveExpensive = 0;
      }
      if (totalCost > costCeilingUsd) {
        console.warn(`[pair-confirm] cost ceiling $${costCeilingUsd} reached — aborting (totalCost=$${totalCost.toFixed(3)})`);
        aborted = true;
        break;
      }
      console.log(
        `[pair-confirm] haiku batch ${haikuBatches}: ${chunk.length} pairs, $${costUsd.toFixed(4)}, tokens=${usage?.input_tokens ?? '?'}/${usage?.output_tokens ?? '?'}`,
      );
    } catch (err) {
      console.warn(`[pair-confirm] haiku batch ${haikuBatches + 1} failed — skipping ${chunk.length} pairs:`, err?.message || err);
      batches += 1;
    }
  }

  if (aborted) {
    return {
      verdicts: verdicts.filter(Boolean),
      indices: verdicts.map((v, i) => (v ? i : -1)).filter((i) => i >= 0),
      model_breakdown: { haiku: haikuBatches, sonnet: sonnetBatches },
      costUsd: totalCost,
      batches,
      aborted: true,
    };
  }

  // --- Pass 2: Sonnet on ambiguous-band verdicts ---
  const ambiguousIdx = [];
  verdicts.forEach((v, i) => {
    if (!v) return;
    if (v.confidence >= sonnetBandLow && v.confidence <= sonnetBandHigh) {
      ambiguousIdx.push(i);
    }
  });

  for (let cursor = 0; cursor < ambiguousIdx.length; cursor += chunkSize) {
    if (aborted) break;
    const indices = ambiguousIdx.slice(cursor, cursor + chunkSize);
    const chunk = indices.map((i) => candidates[i]);
    try {
      const { verdicts: vs, usage, costUsd } = await confirmBatch(chunk, {
        apiKey,
        model: SONNET_MODEL,
      });
      vs.forEach((v, j) => { verdicts[indices[j]] = { ...v, _model: SONNET_MODEL }; });
      totalCost += costUsd;
      batches += 1;
      sonnetBatches += 1;
      if (totalCost > costCeilingUsd) {
        console.warn(`[pair-confirm] cost ceiling $${costCeilingUsd} reached during sonnet pass`);
        aborted = true;
        break;
      }
      console.log(
        `[pair-confirm] sonnet batch ${sonnetBatches}: ${chunk.length} ambiguous pairs, $${costUsd.toFixed(4)}, tokens=${usage?.input_tokens ?? '?'}/${usage?.output_tokens ?? '?'}`,
      );
    } catch (err) {
      console.warn(`[pair-confirm] sonnet batch ${sonnetBatches + 1} failed:`, err?.message || err);
      batches += 1;
    }
  }

  // Pair each non-null verdict back to its source-candidate index so the
  // caller can reconstruct ordering after skipped batches.
  const out = [];
  const outIndices = [];
  verdicts.forEach((v, i) => {
    if (!v) return;
    out.push(v);
    outIndices.push(i);
  });

  return {
    verdicts: out,
    indices: outIndices,
    model_breakdown: { haiku: haikuBatches, sonnet: sonnetBatches },
    costUsd: totalCost,
    batches,
    aborted,
  };
}

export const __test__ = { parseVerdicts, renderUserPrompt, estimateBatchCost };
