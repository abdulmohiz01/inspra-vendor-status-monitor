import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertEvent } from '../src/alerts/decide.js';
import type { Notifier } from '../src/alerts/notifier.js';
import { nextDelayMs, Poller } from '../src/poller.js';
import { Store } from '../src/store.js';
import type { Check, CheckOutcome, Status } from '../src/types.js';

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const config = {
  pollIntervalSeconds: 180,
  fetchTimeoutMs: 50,
  alertReminderMinutes: 60,
  unknownAlertThreshold: 3,
  historyRetentionDays: 30,
};
const fakeFetch = vi.fn() as never;

function mem(): Store {
  const s = new Store(':memory:');
  stores.push(s);
  return s;
}

function notifier(): Notifier & { events: AlertEvent[] } {
  const events: AlertEvent[] = [];
  return {
    events,
    notify: async (e) => {
      events.push(e);
    },
  };
}

function check(id: string, get: () => Status | 'hang'): Check {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'fake',
    run: async (): Promise<CheckOutcome> => {
      const s = get();
      if (s === 'hang') return new Promise<CheckOutcome>(() => undefined);
      return {
        status: s,
        components: s === 'operational' ? [] : [{ name: 'API', status: s }],
        incidents: [],
      };
    },
  };
}

function clock(start = '2026-11-04T10:00:00Z') {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

function poller(checks: Check[], store: Store, n: Notifier, extra: object = {}) {
  return new Poller({ checks, store, notifier: n, config, log, fetch: fakeFetch, ...extra });
}

describe('nextDelayMs', () => {
  it('adds bounded jitter', () => {
    expect(nextDelayMs(180, () => 0)).toBe(180000);
    expect(nextDelayMs(180, () => 0.999)).toBeLessThan(180000 + 15000);
    expect(nextDelayMs(600, () => 0.999)).toBeLessThan(615000);
  });
});

describe('Poller', () => {
  it('completes a cycle with a hanging check recorded as unknown', async () => {
    const store = mem();
    const p = poller([check('ok', () => 'operational'), check('slow', () => 'hang')], store, notifier());
    const results = await p.runCycle();
    expect(results).toHaveLength(2);
    expect(store.latestResults().get('slow')?.status).toBe('unknown');
    expect(store.latestResults().get('ok')?.status).toBe('operational');
    expect(p.liveness().cycles).toBe(1);
    expect(p.liveness().running).toBe(false);
  });

  it('notifies exactly one degraded event across cycles', async () => {
    let s: Status = 'operational';
    const n = notifier();
    const p = poller([check('a', () => s)], mem(), n);
    await p.runCycle();
    s = 'major_outage';
    await p.runCycle();
    await p.runCycle();
    expect(n.events.filter((e) => e.kind === 'degraded')).toHaveLength(1);
    expect(n.events).toHaveLength(1);
  });

  it('does not re-notify after a restart on the same database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'poller-'));
    dirs.push(dir);
    const file = join(dir, 'db.sqlite');
    const n1 = notifier();
    const s1 = new Store(file);
    stores.push(s1);
    await poller([check('a', () => 'major_outage')], s1, n1).runCycle();
    expect(n1.events).toHaveLength(1);
    s1.close();

    const n2 = notifier();
    const s2 = new Store(file);
    stores.push(s2);
    await poller([check('a', () => 'major_outage')], s2, n2).runCycle();
    expect(n2.events).toHaveLength(0);
  });

  it('reports health from the last completed cycle', async () => {
    const c = clock();
    const p = poller([check('a', () => 'operational')], mem(), notifier(), { now: c.now });
    expect(p.isHealthy(c.now())).toBe(true);
    await p.runCycle();
    expect(p.isHealthy(c.now())).toBe(true);
    const windowS = 2 * config.pollIntervalSeconds + config.fetchTimeoutMs / 1000 + 30;
    c.advance((windowS + 1) * 1000);
    expect(p.isHealthy(c.now())).toBe(false);
  });

  it('is unhealthy when no cycle ever completes within the window', () => {
    const c = clock();
    const p = poller([], mem(), notifier(), { now: c.now });
    c.advance(10 * 60 * 1000);
    expect(p.isHealthy(c.now())).toBe(false);
  });

  it('skips an overlapping cycle', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Check = {
      id: 'g',
      name: 'G',
      kind: 'fake',
      run: async () => {
        await gate;
        return { status: 'operational', components: [], incidents: [] };
      },
    };
    const p = new Poller({
      checks: [slow],
      store: mem(),
      notifier: notifier(),
      config: { ...config, fetchTimeoutMs: 5000 },
      log,
      fetch: fakeFetch,
    });
    const first = p.runCycle();
    expect(p.liveness().running).toBe(true);
    expect(await p.runCycle()).toEqual([]);
    release();
    expect(await first).toHaveLength(1);
    expect(p.liveness().cycles).toBe(1);
  });

  it('isolates a failing record and continues with other results', async () => {
    const store = mem();
    const orig = store.recordResult.bind(store);
    vi.spyOn(store, 'recordResult').mockImplementation((r) => {
      if (r.checkId === 'a') throw new Error('disk');
      orig(r);
    });
    const p = poller([check('a', () => 'operational'), check('b', () => 'operational')], store, notifier());
    await p.runCycle();
    expect(store.latestResults().has('b')).toBe(true);
  });

  it('prunes at most once per hour', async () => {
    const c = clock();
    const store = mem();
    const prune = vi.spyOn(store, 'prune');
    const p = poller([check('a', () => 'operational')], store, notifier(), { now: c.now });
    await p.runCycle();
    await p.runCycle();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(30, expect.any(Date));
    c.advance(3_600_001);
    await p.runCycle();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('stop() waits for the in-flight cycle and cancels the timer', async () => {
    const p = poller([check('a', () => 'operational')], mem(), notifier(), { random: () => 0 });
    p.start();
    await p.stop();
    expect(p.liveness().cycles).toBe(1);
    expect(p.liveness().running).toBe(false);
  });
});
