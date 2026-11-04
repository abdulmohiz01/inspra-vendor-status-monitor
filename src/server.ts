import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Poller } from './poller.js';
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
}

export function createApp(deps: AppDeps): Hono {
  const { basePath } = deps;
  const app = new Hono();
  const view = () => buildStatusView(deps);

  const dashboard = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    return c.html(renderDashboard(view(), basePath));
  };
  app.get(`${basePath}/`, dashboard);
  if (basePath !== '') app.get(basePath, dashboard);
  app.get(`${basePath}/api/status`, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(view());
  });
  app.get(`${basePath}/healthz`, (c) => {
    c.header('Cache-Control', 'no-store');
    const liveness = deps.poller.liveness();
    return deps.poller.isHealthy()
      ? c.json({ ok: true, ...liveness })
      : c.json({ ok: false, reason: 'poller stalled', ...liveness }, 503);
  });
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
