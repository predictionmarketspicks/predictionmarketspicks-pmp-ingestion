import * as Sentry from '@sentry/node';

let initialized = false;

export function initSentry() {
  if (initialized) return Sentry;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.warn('[sentry] SENTRY_DSN not set — error capture disabled');
    return Sentry;
  }
  Sentry.init({
    dsn,
    environment: process.env.ENGINE_ENV || 'dev',
    tracesSampleRate: 0,
    profilesSampleRate: 0,
  });
  initialized = true;
  console.log('[sentry] initialized', { env: process.env.ENGINE_ENV || 'dev' });
  return Sentry;
}

export { Sentry };
