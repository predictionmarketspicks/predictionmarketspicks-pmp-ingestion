// Kalshi RSA-PSS request signing — the one copy.
//
// Extracted from kalshi.js (2026-09-08) because the CF Benchmarks adapter needs
// the identical handshake on its OWN socket: kalshi.js tears its socket down and
// rebuilds it every hour at HH:00:30 UTC for the KXBTCD resubscribe, i.e. thirty
// seconds after every hourly settlement print, which is precisely the moment the
// index feed must not drop. Two sockets, one signer.
//
// Behavior is byte-identical to what kalshi.js did inline; it now imports these.
// `pmp-btc-bot/src/kalshi-auth.js` carries the same scheme independently.
//
// The signed message is `${timestampMs}${METHOD}${path}` and the path is signed
// WITHOUT its query string — a signature over `?id=BRTI` is rejected.
import crypto from 'node:crypto';

export const KALSHI_API_BASE =
  process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
export const KALSHI_WS_URL =
  process.env.KALSHI_WS_URL || 'wss://api.elections.kalshi.com/trade-api/ws/v2';
export const KALSHI_WS_PATH = '/trade-api/ws/v2';

export function rsaPssSign(timestampMs, method, path) {
  const pem = process.env.KALSHI_PRIVATE_KEY;
  if (!pem) throw new Error('KALSHI_PRIVATE_KEY not set');
  const msg = `${timestampMs}${method}${path}`;
  const sig = crypto.sign('sha256', Buffer.from(msg), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString('base64');
}

export function authHeaders(method, path) {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId) throw new Error('KALSHI_API_KEY_ID not set');
  const ts = Date.now().toString();
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-SIGNATURE': rsaPssSign(ts, method, path),
    'KALSHI-ACCESS-TIMESTAMP': ts,
  };
}
