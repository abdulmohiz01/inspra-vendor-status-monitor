import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Logger } from './log.js';
import type { CycleReport, Poller } from './poller.js';
import type { Store } from './store.js';
import type { Check } from './types.js';
import { APP_CSS, FAVICON_SVG } from './web/assets.js';
import { renderDashboard } from './web/dashboard.js';
import { buildStatusView } from './web/view.js';

export interface AppDeps {
  checks: Check[];
  store: Store;
  poller: Pick<Poller, 'liveness' | 'isHealthy'>;
  basePath: string;
  /** Enables /api/poll. Without a `cronSecret` the endpoint answers 503. */
  poll?: {
    runCycle: () => Promise<CycleReport>;
    cronSecret: string | undefined;
  };
  log?: Pick<Logger, 'error'>;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time check of an `Authorization: Bearer <secret>` header. Hashing first equalises lengths. */
export function bearerMatches(header: string | undefined, secret: string): boolean {
  const presented = /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '';
  const ok = timingSafeEqual(sha256(presented), sha256(secret));
  return ok && presented.length > 0;
}

export function pollResponse(r: CycleReport) {
  return {
    ok: true,
    ...(r.skipped ? { skipped: r.skipped } : {}),
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    checks: r.results.length,
    alerts: r.alerts,
    results: r.results.map((x) => ({
      id: x.checkId,
      status: x.status,
      durationMs: x.durationMs,
      ...(x.error !== undefined ? { error: x.error } : {}),
    })),
  };
}

export function createApp(deps: AppDeps): Hono {
  const { basePath } = deps;
  const app = new Hono();
  const view = () => buildStatusView(deps);

  const dashboard = async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    return c.html(renderDashboard(await view(), basePath));
  };
  app.get(`${basePath}/`, dashboard);
  if (basePath !== '') app.get(basePath, dashboard);
  app.get(`${basePath}/api/status`, async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await view());
  });
  app.get(`${basePath}/healthz`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const liveness = await deps.poller.liveness();
    if (deps.poller.isHealthy(liveness)) return c.json({ ok: true, ...liveness });
    const reason = liveness.lastCycleCompletedAt === null ? 'awaiting first poll' : 'poller stalled';
    return c.json({ ok: false, reason, ...liveness }, 503);
  });

  // Triggered by an external scheduler (cron-job.org); each authorised request runs one poll cycle.
  const poll = async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    // Hono answers HEAD with the GET route; a HEAD probe must not run a cycle.
    if (c.req.method === 'HEAD') {
      c.header('Allow', 'GET, POST');
      return c.body(null, 405);
    }
    const secret = deps.poll?.cronSecret;
    if (!deps.poll || !secret) return c.json({ ok: false, error: 'polling endpoint disabled: CRON_SECRET is not set' }, 503);
    if (!bearerMatches(c.req.header('authorization'), secret)) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
    try {
      return c.json(pollResponse(await deps.poll.runCycle()));
    } catch (err) {
      deps.log?.error('poll cycle failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({ ok: false, error: 'poll failed; see the function logs' }, 500);
    }
  };
  app.get(`${basePath}/api/poll`, poll);
  app.post(`${basePath}/api/poll`, poll);

  const asset = (body: string, type: string) => (c: Context) => {
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Content-Type', type);
    return c.body(body);
  };
  app.get(`${basePath}/assets/app.css`, asset(APP_CSS, 'text/css; charset=utf-8'));
  app.get(`${basePath}/assets/favicon.svg`, asset(FAVICON_SVG, 'image/svg+xml'));

  if (basePath !== '') {
    app.get('/', (c) => c.redirect(`${basePath}/`, 302));
  }
  return app;
}
