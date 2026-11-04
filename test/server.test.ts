import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Check, CheckResult } from '../src/types.js';

const NOW = new Date().toISOString();
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

const checks: Check[] = ['northflank', 'supabase'].map((id) => ({
  id,
  name: `Vendor ${id}`,
  kind: 'statuspage',
  pageUrl: `https://${id}.example.com`,
  run: async () => ({ status: 'operational', components: [], incidents: [] }),
}));

const liveness = {
  startedAt: NOW,
  lastCycleStartedAt: NOW,
  lastCycleCompletedAt: NOW,
  cycles: 1,
  running: false,
  intervalSeconds: 180,
};

function setup(healthy = true, basePath = '') {
  const store = new Store(':memory:');
  stores.push(store);
  const r: CheckResult = {
    checkId: 'northflank',
    checkedAt: NOW,
    durationMs: 1,
    status: 'degraded',
    components: [],
    incidents: [{ id: 'i1', title: 'Bad <script>alert(1)</script>', status: 'degraded', url: 'https://x.test/i1' }],
  };
  store.recordResult(r);
  return createApp({ checks, store, poller: { liveness: () => liveness, isHealthy: () => healthy }, basePath });
}

describe('createApp (root)', () => {
  it('serves escaped HTML dashboard', async () => {
    const res = await setup().request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('Vendor northflank');
    expect(html).toContain('Vendor supabase');
    expect(html).toContain('id="northflank"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('serves /api/status', async () => {
    const res = await setup().request('/api/status');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { checks: unknown[]; overall: string };
    expect(body.checks).toHaveLength(2);
    expect(body.overall).toBe('degraded');
  });

  it('healthz 200 when healthy, 503 when stalled', async () => {
    const ok = await setup(true).request('/healthz');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.json()).toMatchObject({ ok: true, cycles: 1 });
    const bad = await setup(false).request('/healthz');
    expect(bad.status).toBe(503);
    expect(bad.headers.get('cache-control')).toBe('no-store');
    expect(await bad.json()).toMatchObject({ ok: false, reason: 'poller stalled' });
  });

  it('serves assets at root', async () => {
    const res = await setup().request('/assets/app.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });
});
