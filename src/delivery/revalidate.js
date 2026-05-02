// Vercel revalidation trigger for commodity-edge ISR pages.
//
// Preferred: POST to /api/revalidate with bearer VERCEL_REVALIDATE_TOKEN —
// targets a single tag, no full deploy. The site-side handler accepts
// { tag: 'silver-edge' | 'gold-edge' | 'oil-edge' | 'copper-edge' } and
// runs revalidateTag + revalidatePath for the relevant tool page + JSON API.
// Fallback: VERCEL_DEPLOY_HOOK_URL — fires a deploy. Heavier, but works if
// the bearer endpoint is down.
//
// Either is optional. Engine still produces fresh DB rows; ISR (60s) will
// pick them up on the next natural refresh even without an explicit poke.

const SITE_BASE = process.env.SITE_BASE_URL || 'https://predictionmarketspicks.com';

const VALID_COMMODITIES = new Set(['silver', 'gold', 'oil', 'copper']);

export async function revalidateCommodityEdge(commodity) {
  if (!VALID_COMMODITIES.has(commodity)) {
    return { strategy: 'none', ok: false, note: `unknown commodity: ${commodity}` };
  }
  const tag = `${commodity}-edge`;
  const token = process.env.VERCEL_REVALIDATE_TOKEN;
  if (token) {
    try {
      const res = await fetch(`${SITE_BASE}/api/revalidate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tag }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return { strategy: 'tag', ok: true };
      console.warn(`[revalidate] tag endpoint ${res.status} — falling back to deploy hook`);
    } catch (err) {
      console.warn(`[revalidate] tag endpoint failed (${err?.message || err}) — falling back to deploy hook`);
    }
  }

  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) {
    return { strategy: 'none', ok: false, note: 'no VERCEL_REVALIDATE_TOKEN or VERCEL_DEPLOY_HOOK_URL set' };
  }
  try {
    const res = await fetch(hook, { method: 'POST', signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { strategy: 'deploy_hook', ok: false, status: res.status };
    return { strategy: 'deploy_hook', ok: true };
  } catch (err) {
    return { strategy: 'deploy_hook', ok: false, note: err?.message || String(err) };
  }
}

// Phase 1 back-compat shim.
export const revalidateSilverEdge = () => revalidateCommodityEdge('silver');
