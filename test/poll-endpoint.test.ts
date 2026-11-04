import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notifier } from '../src/alerts/notifier.js';
import { Poller } from '../src/poller.js';
import { bearerMatches, createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Check } from '../src/types.js';
import { createLazyApp } from '../src/vercel.js';

const SECRET = 'test-cron-secret-0123456789';
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // libsql on Windows releases the file handle only when the client is garbage collected.
    }
  }
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vsm-poll-'));
  dirs.push(dir);
  return dir;
}
const toUrl = (path: string): string => 'file:' + path.split(String.fromCharCode(92)).join('/');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const config = {
  pollIntervalSeconds: 180,
  fetchTimeoutMs: 1000,
  alertReminderMinutes: 60,
  unknownAlertThreshold: 3,
  historyRetentionDays: 30,
};

async function setup({ cronSecret }: { cronSecret: string | undefined } = { cronSecret: SECRET }) {
  const store = await Store.open({ url: toUrl(join(tempDir(), 'status.db')) });
  stores.push(store);
  const runs: string[] = [];
  const checks: Check[] = ['a', 'b'].map((id) => ({
    id,
    name: id.toUpperCase(),
    kind: 'fake',
    run: async () => {
      runs.push(id);
      return id === 'a'
        ? { status: 'major_outage', components: [], incidents: [] }
        : { status: 'operational', components: [], incidents: [] };
    },
  }));
  const sent: string[] = [];
  const notifier: Notifier = {
    notify: async (e) => {
      sent.push(e.dedupeKey);
      return { ok: true };
    },
  };
  const poller = new Poller({ checks, store, notifier, config, log });
  const cycle = vi.spyOn(poller, 'runCycle');
  const app = createApp({
    checks,
    store,
    poller,
    basePath: '',
    poll: { runCycle: () => poller.runCycle(), cronSecret },
    log,
  });
  return { app, store, runs, sent, cycle };
}

const auth = (value: string) => ({ headers: { Authorization: value } });

describe('bearerMatches', () => {
  it('accepts only the exact bearer token', () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(bearerMatches(undefined, SECRET)).toBe(false);
    expect(bearerMatches('', SECRET)).toBe(false);
    expect(bearerMatches('Bearer ', SECRET)).toBe(false);
    expect(bearerMatches(SECRET, SECRET)).toBe(false);
    expect(bearerMatches(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(bearerMatches(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(bearerMatches(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(bearerMatches(`bearer ${SECRET}`, SECRET)).toBe(false);
  });
});

describe('/api/poll', () => {
  it.each([
    ['no header', undefined],
    ['a wrong token', 'Bearer not-the-secret-at-all-000'],
    ['the secret without the Bearer scheme', SECRET],
    ['another scheme', `Basic ${SECRET}`],
  ])('returns 401 and runs nothing with %s', async (_label, header) => {
    const { app, runs, cycle } = await setup();
    for (const method of ['GET', 'POST']) {
      const res = await app.request('/api/poll', { method, ...(header ? auth(header) : {}) });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
    }
    expect(cycle).not.toHaveBeenCalled();
    expect(runs).toEqual([]);
  });

  it('returns 503 when CRON_SECRET is not configured, even with a header', async () => {
    const { app, cycle } = await setup({ cronSecret: undefined });
    const res = await app.request('/api/poll', auth('Bearer anything-at-all-123456'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(cycle).not.toHaveBeenCalled();
  });

  it('GET with the right token runs exactly one cycle against the file database and reports it', async () => {
    const { app, store, runs, sent, cycle } = await setup();
    const res = await app.request('/api/poll', auth(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      checks: 2,
      alerts: { sent: 1, failed: 0, deferred: 0 },
      results: [
        { id: 'a', status: 'major_outage' },
        { id: 'b', status: 'operational' },
      ],
    });
    expect(body['skipped']).toBeUndefined();
    expect(typeof body['durationMs']).toBe('number');
    expect(typeof body['startedAt']).toBe('string');
    expect(cycle).toHaveBeenCalledTimes(1);
    expect(runs.sort()).toEqual(['a', 'b']);
    expect(sent).toEqual(['a:state:major_outage']);
    expect((await store.pollerRecord(new Date())).cycles).toBe(1);
  });

  it('POST works the same and each request is one more cycle', async () => {
    const { app, store, cycle } = await setup();
    for (let i = 0; i < 2; i++) {
      const res = await app.request('/api/poll', { method: 'POST', ...auth(`Bearer ${SECRET}`) });
      expect(res.status).toBe(200);
    }
    expect(cycle).toHaveBeenCalledTimes(2);
    expect((await store.pollerRecord(new Date())).cycles).toBe(2);
  });

  it('reports a skipped cycle when another invocation holds the lock', async () => {
    const { app, store, runs } = await setup();
    await store.tryStartCycle(new Date(), 60_000);
    const res = await app.request('/api/poll', auth(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, skipped: 'locked', checks: 0, results: [] });
    expect(runs).toEqual([]);
  });

  it('answers HEAD with 405 and runs nothing, even with the right token', async () => {
    const { app, runs, cycle } = await setup();
    const res = await app.request('/api/poll', { method: 'HEAD', ...auth(`Bearer ${SECRET}`) });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(cycle).not.toHaveBeenCalled();
    expect(runs).toEqual([]);
  });

  it('answers 500 and logs when the cycle throws', async () => {
    const { app, cycle } = await setup();
    cycle.mockRejectedValueOnce(new Error('database unreachable'));
    const res = await app.request('/api/poll', auth(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: false, error: 'poll failed; see the function logs' });
    expect(log.error).toHaveBeenCalledWith('poll cycle failed', { error: 'database unreachable' });
    // The next call is a normal cycle.
    expect((await app.request('/api/poll', auth(`Bearer ${SECRET}`))).status).toBe(200);
  });

  it('turns /healthz healthy once a poll has completed', async () => {
    const { app } = await setup();
    const before = await app.request('/healthz');
    expect(before.status).toBe(503);
    expect(await before.json()).toMatchObject({ ok: false, reason: 'awaiting first poll', cycles: 0 });
    await app.request('/api/poll', auth(`Bearer ${SECRET}`));
    const after = await app.request('/healthz');
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ ok: true, cycles: 1 });
  });
});

describe('createLazyApp (Vercel entry)', () => {
  const vendorsFile = join(import.meta.dirname, '..', 'vendors.yaml');

  it('opens the database on first request and serves the app without polling', async () => {
    const dir = tempDir();
    const env = { DATABASE_URL: toUrl(join(dir, 'lazy.db')), VENDORS_FILE: vendorsFile, CRON_SECRET: SECRET };
    const app = createLazyApp(env);
    const health = await app.request('/healthz');
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ reason: 'awaiting first poll' });
    expect((await app.request('/api/status')).status).toBe(200);
    expect((await app.request('/api/poll')).status).toBe(401);
  });

  it('answers 500 when startup fails, and retries startup on the next request', async () => {
    const dir = tempDir();
    const env: Record<string, string> = {
      DATABASE_URL: toUrl(join(dir, 'lazy.db')),
      VENDORS_FILE: vendorsFile,
      CRON_SECRET: 'too-short',
    };
    const app = createLazyApp(env);
    const bad = await app.request('/healthz');
    expect(bad.status).toBe(500);
    expect(await bad.json()).toEqual({ ok: false, error: 'startup failed; see the function logs' });
    env['CRON_SECRET'] = SECRET;
    expect((await app.request('/healthz')).status).toBe(503);
  });

  it('refuses a local file database on Vercel', async () => {
    const app = createLazyApp({ VERCEL: '1', VENDORS_FILE: vendorsFile, CRON_SECRET: SECRET });
    expect((await app.request('/healthz')).status).toBe(500);
  });
});
