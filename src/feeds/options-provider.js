// Options-chain provider switch. One env var (OPTIONS_PROVIDER) chooses
// between Databento (default, real-time via Python sidecar) and Massive
// (the 15-min REST poller). commodity-base.js imports getChain/fetchPrevClose
// from here so the engine's compute path never sees a provider-specific
// detail.
//
// Phase 1 ships env-var switching only. Auto-failover (Databento sidecar
// disconnect → fall through to Massive) is deferred — runtime flip via
// fly secrets set OPTIONS_PROVIDER=massive + machine restart is good
// enough until we soak the sidecar.

import * as databento from './databento.js';
import * as massive from './massive.js';

const PROVIDER = (process.env.OPTIONS_PROVIDER || 'databento').toLowerCase();
const impls = { databento, massive };
const impl = impls[PROVIDER];
if (!impl) {
  throw new Error(
    `OPTIONS_PROVIDER=${PROVIDER} not supported. Use 'databento' or 'massive'.`,
  );
}

export const OPTIONS_PROVIDER = PROVIDER;

export const getChain = (...args) => impl.getChain(...args);
export const fetchPrevClose = (...args) => impl.fetchPrevClose(...args);

// Lifecycle. Massive takes (underlying, expirationDateRef); Databento only
// needs the underlying (the sidecar pulls the whole parent chain). The
// engine doesn't care — it calls startOptionsFeed(state) with the
// EngineState row and the provider unwraps what it needs.
export function startOptionsFeed(state) {
  if (PROVIDER === 'databento') {
    databento.startDatabentoPoller(state.config.underlyingEtf);
  } else {
    massive.startMassivePoller(state.config.underlyingEtf, state.expirationDateRef);
  }
}

export function stopAllOptionsFeeds() {
  if (PROVIDER === 'databento') {
    databento.stopAllDatabentoPollers();
  } else {
    massive.stopAllMassivePollers();
  }
}

// Required-feed name surfaced via observability/health.js. Branches per
// provider so the /health JSON reads `databento_slv` vs `massive_slv`
// matching the active source.
export function requiredFeedName(underlyingEtf) {
  return `${PROVIDER}_${underlyingEtf.toLowerCase()}`;
}
