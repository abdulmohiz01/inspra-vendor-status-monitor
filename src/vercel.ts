import { Hono } from 'hono';
import { createNotifier } from './alerts/notifier.js';
import { createVendorChecks } from './checks/vendor.js';
import { appUrlWarning, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { Poller } from './poller.js';
import type { CycleBudget } from './poller.js';
import { createApp } from './server.js';
import { isLocalDbUrl, Store } from './store.js';
import { loadVendors } from './vendors.js';

/**
 * Serverless (Vercel) wiring. No timer, jitter or signal handling: an external scheduler calls
 * /api/poll and each call runs one cycle. A cycle is held well under 10 s: vendor fetches run in
 * parallel capped at FETCH_TIMEOUT_CAP_MS, each alert send at SEND_TIMEOUT_MS, each database round
 * trip at DB_REQUEST_TIMEOUT_MS, and sends that would not finish inside the budget wait for the
 * next cycle. With a responsive database the budget leaves about 3 s of the 10 s for the cold start
 * and the bookkeeping writes after the last send. The budget only gates when a send may start, so a
 * database answering near its timeout on every call can stretch a cycle towards maxDuration (15 s);
 * if the function is killed, the lock lapses after its TTL and unsent alerts stay in the outbox (a
 * send whose delivery mark was lost is sent again: delivery is at-least-once).
 */
export const FETCH_TIMEOUT_CAP_MS = 4_000;
export const SEND_TIMEOUT_MS = 3_000;
export const DB_REQUEST_TIMEOUT_MS = 2_500;
export const CYCLE_BUDGET: CycleBudget = { budgetMs: 7_000, sendTimeoutMs: SEND_TIMEOUT_MS };

const log = createLogger();

async function build(env: NodeJS.ProcessEnv): Promise<Hono> {
  const config = loadConfig(env);
  if (env['VERCEL'] && isLocalDbUrl(config.databaseUrl)) {
    throw new Error('DATABASE_URL must point at a hosted libSQL database (Turso) on Vercel');
  }
  const urlWarning = appUrlWarning(config);
  if (urlWarning) log.warn(urlWarning, { appUrl: config.appUrl, basePath: config.basePath });

  const checks = createVendorChecks(loadVendors(config.vendorsFile));
  const store = await Store.open({
    url: config.databaseUrl,
    authToken: config.databaseAuthToken,
    requestTimeoutMs: DB_REQUEST_TIMEOUT_MS,
  });
  const notifier = createNotifier(config, { fetch, log, timeoutMs: SEND_TIMEOUT_MS });
  const poller = new Poller({
    checks,
    store,
    notifier,
    log,
    config: { ...config, fetchTimeoutMs: Math.min(config.fetchTimeoutMs, FETCH_TIMEOUT_CAP_MS) },
    budget: CYCLE_BUDGET,
  });
  return createApp({
    checks,
    store,
    poller,
    basePath: config.basePath,
    poll: { runCycle: () => poller.runCycle(), cronSecret: config.cronSecret },
    log,
  });
}

/** One app per warm instance; a failed start (bad config, database down) is retried on the next request. */
export function createLazyApp(env: NodeJS.ProcessEnv = process.env): Hono {
  let ready: Promise<Hono> | undefined;
  const get = (): Promise<Hono> =>
    (ready ??= build(env).catch((err: unknown) => {
      ready = undefined;
      throw err;
    }));

  const app = new Hono();
  app.all('*', async (c) => {
    let inner: Hono;
    try {
      inner = await get();
    } catch (err) {
      log.error('startup failed', { error: err instanceof Error ? err.message : String(err) });
      c.header('Cache-Control', 'no-store');
      return c.json({ ok: false, error: 'startup failed; see the function logs' }, 500);
    }
    return inner.fetch(c.req.raw);
  });
  return app;
}
