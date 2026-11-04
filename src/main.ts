import { serve } from '@hono/node-server';
import { createNotifier } from './alerts/notifier.js';
import { createVendorChecks } from './checks/vendor.js';
import { appUrlWarning, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { Poller } from './poller.js';
import { createApp } from './server.js';
import { Store } from './store.js';
import { loadVendors } from './vendors.js';

/** Long-running mode (`pnpm dev`, `pnpm start`, Docker): an in-process loop polls every interval. */
const log = createLogger();

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  let vendors: ReturnType<typeof loadVendors>;
  let store: Store;
  try {
    config = loadConfig();
    vendors = loadVendors(config.vendorsFile);
    store = await Store.open({ url: config.databaseUrl, authToken: config.databaseAuthToken });
  } catch (err) {
    log.error('startup failed', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
  const urlWarning = appUrlWarning(config);
  if (urlWarning) log.warn(urlWarning, { appUrl: config.appUrl, basePath: config.basePath });

  const checks = createVendorChecks(vendors);
  const notifier = createNotifier(config, { fetch, log });
  const poller = new Poller({ checks, store, notifier, config, log });
  const app = createApp({
    checks,
    store,
    poller,
    basePath: config.basePath,
    poll: { runCycle: () => poller.runCycle(), cronSecret: config.cronSecret },
    log,
  });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  poller.start();
  log.info('listening', { port: config.port, basePath: config.basePath, vendors: vendors.length });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    if ('closeAllConnections' in server) server.closeAllConnections();
    void poller
      .stop()
      .then(() => closed)
      .catch((err: unknown) => log.error('shutdown error', { error: String(err) }))
      .finally(() => {
        store.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
