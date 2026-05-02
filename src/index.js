import 'dotenv/config';
import http from 'node:http';

import { initSentry, Sentry } from './observability/sentry.js';
import { snapshot, registerFeed } from './observability/health.js';
import { startKalshi, stopKalshi } from './feeds/kalshi.js';

initSentry();

const PORT = Number(process.env.PORT || 8080);

registerFeed('kalshi');

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    const snap = snapshot();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snap));
    return;
  }

  if (url.pathname === '/dev/throw') {
    // Deliberate error to exercise Sentry capture. Phase 0 verification only.
    const err = new Error('dev/throw — deliberate Sentry test capture');
    Sentry.captureException(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'captured', message: err.message }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
});

server.listen(PORT, () => {
  console.log(`[http] listening on :${PORT}`);
});

startKalshi().catch((err) => {
  console.error('[kalshi] startup failed', err);
  Sentry.captureException(err);
});

async function shutdown(signal) {
  console.log(`[shutdown] ${signal} received`);
  stopKalshi();
  server.close(() => {
    console.log('[shutdown] http closed');
    process.exit(0);
  });
  // Hard exit if shutdown takes too long
  setTimeout(() => {
    console.warn('[shutdown] forced exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  Sentry.captureException(reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  Sentry.captureException(err);
});
