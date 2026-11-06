import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertEvent } from '../src/alerts/decide.js';
import { createNotifier, type DeliveryResult, type Notifier } from '../src/alerts/notifier.js';
import { CYCLE_LOCK_TTL_MS, LONG_CYCLE_LOCK_TTL_MS, nextDelayMs, Poller } from '../src/poller.js';
import { Store } from '../src/store.js';
import type { Check, CheckOutcome, Status } from '../src/types.js';
import { CYCLE_BUDGET } from '../src/vercel.js';

const stores: Store[] = [];
const dirs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // libsql on Windows releases the file handle only when the client is garbage collected.
    }
  }
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

async function open(url: string): Promise<Store> {
  const s = await Store.open({ url });
  stores.push(s);
  return s;
}
const mem = (): Promise<Store> => open(':memory:');
function tempDbUrl(): string {
  const dir = mkdtempSync(join(tmpdir(), 'poller-'));
  dirs.push(dir);
  return 'file:' + join(dir, 'db.sqlite').split(String.fromCharCode(92)).join('/');
}

function notifier(): Notifier & { events: AlertEvent[] } {
  const events: AlertEvent[] = [];
  return {
    events,
    notify: async (e) => {
      events.push(e);
      return { ok: true };
    },
  };
}

const outcome = (status: Status): CheckOutcome => ({
  status,
  components: status === 'operational' ? [] : [{ name: 'API', status }],
  incidents: [],
});

function check(id: string, get: () => Status | 'hang'): Check {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'fake',
    run: async (): Promise<CheckOutcome> => {
      const s = get();
      if (s === 'hang') return new Promise<CheckOutcome>(() => undefined);
      return outcome(s);
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

const allPending = (store: Store) => store.pendingAlerts({ maxAttempts: 5, minCreatedAt: new Date(0) });

describe('nextDelayMs', () => {
  it('adds bounded jitter', () => {
    expect(nextDelayMs(180, () => 0)).toBe(180000);
    expect(nextDelayMs(180, () => 0.999)).toBeLessThan(180000 + 15000);
    expect(nextDelayMs(600, () => 0.999)).toBeLessThan(615000);
  });
});

describe('Poller', () => {
  it('completes a cycle with a hanging check recorded as unknown', async () => {
    const store = await mem();
    const p = poller([check('ok', () => 'operational'), check('slow', () => 'hang')], store, notifier());
    const report = await p.runCycle();
    expect(report.skipped).toBeUndefined();
    expect(report.results).toHaveLength(2);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    const latest = await store.latestResults();
    expect(latest.get('slow')?.status).toBe('unknown');
    expect(latest.get('ok')?.status).toBe('operational');
    expect(await p.liveness()).toMatchObject({ cycles: 1, running: false });
  });

  it('runs one full cycle against a libsql file database', async () => {
    const c = clock();
    const store = await open(tempDbUrl());
    const n = notifier();
    const p = poller([check('a', () => 'major_outage'), check('b', () => 'operational')], store, n, { now: c.now });
    const report = await p.runCycle();
    expect(report.results.map((r) => [r.checkId, r.status])).toEqual([
      ['a', 'major_outage'],
      ['b', 'operational'],
    ]);
    expect(report.alerts).toEqual({ sent: 1, failed: 0, deferred: 0 });
    expect(n.events.map((e) => e.dedupeKey)).toEqual(['a:state:major_outage']);
    expect((await store.latestResults()).size).toBe(2);
    expect(await allPending(store)).toEqual([]);
    expect(await p.liveness()).toMatchObject({
      cycles: 1,
      running: false,
      lastCycleCompletedAt: c.now().toISOString(),
    });
  });

  it('runs vendor checks in parallel', async () => {
    const slow = (id: string): Check => ({
      id,
      name: id,
      kind: 'fake',
      run: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return outcome('operational');
      },
    });
    const p = poller(['a', 'b', 'c', 'd', 'e'].map(slow), await mem(), notifier(), {
      config: { ...config, fetchTimeoutMs: 1000 },
    });
    const t0 = performance.now();
    const report = await p.runCycle();
    expect(report.results.every((r) => r.status === 'operational')).toBe(true);
    expect(performance.now() - t0).toBeLessThan(400);
  });

  it('notifies exactly one degraded event across cycles', async () => {
    let s: Status = 'operational';
    const n = notifier();
    const p = poller([check('a', () => s)], await mem(), n);
    await p.runCycle();
    s = 'major_outage';
    await p.runCycle();
    await p.runCycle();
    expect(n.events.filter((e) => e.kind === 'degraded')).toHaveLength(1);
    expect(n.events).toHaveLength(1);
  });

  it('does not re-notify after a restart on the same database', async () => {
    const url = tempDbUrl();
    const n1 = notifier();
    const s1 = await open(url);
    await poller([check('a', () => 'major_outage')], s1, n1).runCycle();
    expect(n1.events).toHaveLength(1);
    s1.close();

    const n2 = notifier();
    const s2 = await open(url);
    await poller([check('a', () => 'major_outage')], s2, n2).runCycle();
    expect(n2.events).toHaveLength(0);
  });

  it('reports health from the last completed cycle; a database never polled is unhealthy', async () => {
    const c = clock();
    const p = poller([check('a', () => 'operational')], await mem(), notifier(), { now: c.now });
    expect(p.isHealthy(await p.liveness(), c.now())).toBe(false);
    await p.runCycle();
    expect(p.isHealthy(await p.liveness(), c.now())).toBe(true);
    const windowS = 2 * config.pollIntervalSeconds + config.fetchTimeoutMs / 1000 + 30;
    c.advance((windowS + 1) * 1000);
    expect(p.isHealthy(await p.liveness(), c.now())).toBe(false);
  });

  it('shares liveness across pollers on one database', async () => {
    const url = tempDbUrl();
    const a = poller([check('a', () => 'operational')], await open(url), notifier());
    const b = poller([check('a', () => 'operational')], await open(url), notifier());
    await a.runCycle();
    expect((await b.liveness()).cycles).toBe(1);
  });

  it('skips an overlapping cycle in the same process', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Check = {
      id: 'g',
      name: 'G',
      kind: 'fake',
      run: async () => {
        await gate;
        return outcome('operational');
      },
    };
    const p = poller([slow], await mem(), notifier(), { config: { ...config, fetchTimeoutMs: 5000 } });
    const first = p.runCycle();
    expect(await p.runCycle()).toMatchObject({ skipped: 'running', results: [] });
    await vi.waitFor(async () => expect((await p.liveness()).running).toBe(true));
    release();
    expect((await first).results).toHaveLength(1);
    expect((await p.liveness()).cycles).toBe(1);
  });

  it('skips a cycle while another process holds the poll lock, and runs once it expires', async () => {
    const c = clock();
    const url = tempDbUrl();
    const other = await open(url);
    expect(await other.tryStartCycle(c.now(), CYCLE_LOCK_TTL_MS)).not.toBeNull();
    const runs: string[] = [];
    const counted: Check = {
      ...check('a', () => 'operational'),
      run: async () => {
        runs.push('a');
        return outcome('operational');
      },
    };
    const p = poller([counted], await open(url), notifier(), { now: c.now });
    expect(await p.runCycle()).toMatchObject({ skipped: 'locked', results: [] });
    expect(runs).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith('poll cycle skipped: another process holds the poll lock');
    c.advance(CYCLE_LOCK_TTL_MS);
    expect((await p.runCycle()).skipped).toBeUndefined();
    expect(runs).toEqual(['a']);
  });

  it('isolates a failing commit and continues with other results', async () => {
    const store = await mem();
    const orig = store.commitCycleResult.bind(store);
    vi.spyOn(store, 'commitCycleResult').mockImplementation(async (r, st, ev) => {
      if (r.checkId === 'a') throw new Error('disk');
      return orig(r, st, ev);
    });
    const p = poller([check('a', () => 'operational'), check('b', () => 'operational')], store, notifier());
    await p.runCycle();
    expect((await store.latestResults()).has('b')).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      'failed to process check result',
      expect.objectContaining({ checkId: 'a' }),
    );
  });

  it('does not notify when the commit fails, and alerts on the next cycle instead', async () => {
    const store = await mem();
    const orig = store.commitCycleResult.bind(store);
    const commit = vi
      .spyOn(store, 'commitCycleResult')
      .mockImplementationOnce(async () => {
        throw new Error('db down');
      })
      .mockImplementation(orig);
    const n = notifier();
    const p = poller([check('a', () => 'major_outage')], store, n);
    await p.runCycle();
    expect(n.events).toHaveLength(0);
    await p.runCycle();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(n.events.map((e) => e.dedupeKey)).toEqual(['a:state:major_outage']);
  });

  it('commits the result, state and alerts before notifying', async () => {
    const store = await mem();
    const order: string[] = [];
    const orig = store.commitCycleResult.bind(store);
    const commit = vi.spyOn(store, 'commitCycleResult').mockImplementation(async (r, st, ev) => {
      order.push('commit');
      return orig(r, st, ev);
    });
    const n: Notifier = {
      notify: async () => {
        order.push('notify');
        return { ok: true };
      },
    };
    await poller([check('a', () => 'major_outage')], store, n).runCycle();
    expect(order).toEqual(['commit', 'notify']);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![2]).toHaveLength(1);
  });

  it('prunes at most once per hour', async () => {
    const c = clock();
    const store = await mem();
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

  it('start() loops on the interval; stop() ends the loop', async () => {
    const p = poller([check('a', () => 'operational')], await mem(), notifier(), {
      random: () => 0,
      config: { ...config, pollIntervalSeconds: 0.05 },
    });
    p.start();
    await vi.waitFor(async () => expect((await p.liveness()).cycles).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    await p.stop();
    const after = (await p.liveness()).cycles;
    await new Promise((r) => setTimeout(r, 200));
    expect((await p.liveness()).cycles).toBe(after);
  });

  it('stop() waits for the in-flight cycle', async () => {
    const p = poller([check('a', () => 'operational')], await mem(), notifier(), { random: () => 0 });
    p.start();
    await p.stop();
    expect(await p.liveness()).toMatchObject({ cycles: 1, running: false });
  });

  it.each([
    ['rejects', (m: string) => Promise.reject(new Error(m))],
    [
      'throws synchronously',
      (m: string): Promise<DeliveryResult> => {
        throw new Error(m);
      },
    ],
  ] as const)('keeps notifying other checks when notify %s', async (_name, fail) => {
    const seen: string[] = [];
    const n: Notifier = {
      notify: (e) => {
        if (e.checkId === 'a') return fail('notify boom');
        seen.push(e.checkId);
        return Promise.resolve({ ok: true });
      },
    };
    const p = poller([check('a', () => 'major_outage'), check('b', () => 'major_outage')], await mem(), n);
    const report = await p.runCycle();
    expect(report.results).toHaveLength(2);
    expect(report.alerts).toEqual({ sent: 1, failed: 1, deferred: 0 });
    expect(seen).toEqual(['b']);
    expect(log.error).toHaveBeenCalledWith('notify failed', expect.objectContaining({ checkId: 'a' }));
    expect((await p.liveness()).cycles).toBe(1);
  });

  describe('cycle budget', () => {
    const budget = CYCLE_BUDGET;
    const lastSendStartMs = budget.budgetMs - budget.sendTimeoutMs;
    /** A check that takes `ms` of (fake) wall-clock time. */
    function timed(c: ReturnType<typeof clock>, ms: () => number): Check {
      return {
        id: 'a',
        name: 'A',
        kind: 'fake',
        run: async () => {
          c.advance(ms());
          return outcome('major_outage');
        },
      };
    }

    it('sends when the send still fits in the budget', async () => {
      const c = clock();
      const n = notifier();
      const report = await poller([timed(c, () => lastSendStartMs)], await mem(), n, { now: c.now, budget }).runCycle();
      expect(report.alerts).toEqual({ sent: 1, failed: 0, deferred: 0 });
      expect(n.events).toHaveLength(1);
    });

    it('defers a send that might overrun the budget; the next cycle sends it', async () => {
      const c = clock();
      const store = await mem();
      const n = notifier();
      let ms = lastSendStartMs + 1;
      const p = poller([timed(c, () => ms)], store, n, { now: c.now, budget });
      const first = await p.runCycle();
      expect(first.alerts).toEqual({ sent: 0, failed: 0, deferred: 1 });
      expect(n.events).toHaveLength(0);
      expect(await allPending(store)).toMatchObject([{ attempts: 0, event: { dedupeKey: 'a:state:major_outage' } }]);

      ms = 0;
      c.advance(180_000);
      const second = await p.runCycle();
      expect(second.alerts).toEqual({ sent: 1, failed: 0, deferred: 0 });
      expect(n.events.map((e) => e.dedupeKey)).toEqual(['a:state:major_outage']);
    });

    it('holds the poll lock for the short TTL under a budget and the long one without', async () => {
      const ttls: number[] = [];
      for (const opts of [{ budget }, {}]) {
        const store = await mem();
        const orig = store.tryStartCycle.bind(store);
        vi.spyOn(store, 'tryStartCycle').mockImplementation((now, ttl) => {
          ttls.push(ttl);
          return orig(now, ttl);
        });
        await poller([check('a', () => 'operational')], store, notifier(), opts).runCycle();
      }
      expect(ttls).toEqual([CYCLE_LOCK_TTL_MS, LONG_CYCLE_LOCK_TTL_MS]);
    });
  });

  describe('alert outbox', () => {
    const DAY = 24 * 3_600_000;
    const pending = (store: Store, c: { now: () => Date }) =>
      store.pendingAlerts({ maxAttempts: 5, minCreatedAt: new Date(c.now().getTime() - DAY) });

    function flaky(results: DeliveryResult[]): Notifier & { calls: AlertEvent[] } {
      const calls: AlertEvent[] = [];
      return {
        calls,
        notify: async (e) => {
          calls.push(e);
          return results.shift() ?? { ok: true };
        },
      };
    }

    it('marks a delivered alert sent', async () => {
      const c = clock();
      const store = await mem();
      await poller([check('a', () => 'major_outage')], store, notifier(), { now: c.now }).runCycle();
      expect(await pending(store, c)).toEqual([]);
    });

    it('retries a failed alert on the next cycle and marks it sent', async () => {
      const c = clock();
      const store = await mem();
      const n = flaky([{ ok: false, error: 'slack: HTTP 503' }]);
      const p = poller([check('a', () => 'major_outage')], store, n, { now: c.now });
      expect((await p.runCycle()).alerts).toEqual({ sent: 0, failed: 1, deferred: 0 });
      expect(n.calls.map((e) => e.dedupeKey)).toEqual(['a:state:major_outage']);
      expect(await pending(store, c)).toMatchObject([{ attempts: 1, event: { dedupeKey: 'a:state:major_outage' } }]);

      c.advance(180_000);
      expect((await p.runCycle()).alerts).toEqual({ sent: 1, failed: 0, deferred: 0 });
      expect(n.calls.map((e) => e.dedupeKey)).toEqual(['a:state:major_outage', 'a:state:major_outage']);
      expect(n.calls[1]).toEqual(n.calls[0]);
      expect(await pending(store, c)).toEqual([]);
      expect(log.info).toHaveBeenCalledWith(
        'retrying alert',
        expect.objectContaining({ checkId: 'a', dedupeKey: 'a:state:major_outage', attempts: 1 }),
      );

      c.advance(180_000);
      await p.runCycle();
      expect(n.calls).toHaveLength(2);
    });

    it('retries pending alerts alongside the checks', async () => {
      const c = clock();
      const store = await mem();
      const order: string[] = [];
      let failNext = true;
      let retried!: () => void;
      const retriedP = new Promise<void>((r) => (retried = r));
      const n: Notifier = {
        notify: async (e) => {
          order.push(`notify:${e.checkId}`);
          if (failNext) {
            failNext = false;
            return { ok: false, error: 'x' };
          }
          if (e.checkId === 'a') retried();
          return { ok: true };
        },
      };
      let second = false;
      const b: Check = {
        id: 'b',
        name: 'B',
        kind: 'fake',
        run: async () => {
          if (!second) return outcome('operational');
          // In the second cycle b only finishes once a's retry has gone out: they overlap.
          order.push('run:b:start');
          await retriedP;
          order.push('run:b:end');
          return outcome('major_outage');
        },
      };
      const p = poller([check('a', () => 'major_outage'), b], store, n, {
        now: c.now,
        config: { ...config, fetchTimeoutMs: 2000 },
      });
      await p.runCycle();
      order.length = 0;
      second = true;
      c.advance(180_000);
      await p.runCycle();
      expect(order).toEqual(['run:b:start', 'notify:a', 'run:b:end', 'notify:b']);
    });

    it('never sends a stale degraded alert after the recovery was delivered', async () => {
      const c = clock();
      const store = await mem();
      // degraded fails, its retry fails, recovered succeeds; everything after that succeeds.
      const n = flaky([
        { ok: false, error: 'slack: HTTP 503' },
        { ok: false, error: 'slack: HTTP 503' },
      ]);
      let status: Status = 'major_outage';
      const p = poller([check('a', () => status)], store, n, { now: c.now });
      await p.runCycle();
      c.advance(180_000);
      status = 'operational';
      await p.runCycle();
      c.advance(180_000);
      await p.runCycle();
      expect(n.calls.map((e) => e.kind)).toEqual(['degraded', 'degraded', 'recovered']);
      expect(await pending(store, c)).toEqual([]);
    });

    it('marks a thrown notify as failed and retries it', async () => {
      const c = clock();
      const store = await mem();
      let calls = 0;
      const n: Notifier = {
        notify: async () => {
          calls += 1;
          if (calls === 1) throw new Error('boom');
          return { ok: true };
        },
      };
      const p = poller([check('a', () => 'major_outage')], store, n, { now: c.now });
      await p.runCycle();
      expect(await pending(store, c)).toHaveLength(1);
      c.advance(180_000);
      await p.runCycle();
      expect(calls).toBe(2);
      expect(await pending(store, c)).toEqual([]);
    });

    it('gives up after 5 attempts', async () => {
      const c = clock();
      const store = await mem();
      const n = flaky(Array.from({ length: 20 }, () => ({ ok: false, error: 'down' })));
      const p = poller([check('a', () => 'major_outage')], store, n, { now: c.now });
      for (let i = 0; i < 8; i++) {
        await p.runCycle();
        c.advance(180_000);
      }
      expect(n.calls.filter((e) => e.dedupeKey === 'a:state:major_outage')).toHaveLength(5);
      expect(await pending(store, c)).toEqual([]);
    });

    it('does not retry alerts older than 24h', async () => {
      const c = clock();
      const store = await mem();
      const n = flaky([{ ok: false, error: 'down' }]);
      const p = poller([check('a', () => 'major_outage')], store, n, { now: c.now });
      await p.runCycle();
      c.advance(DAY + 1);
      await p.runCycle();
      expect(n.calls.filter((e) => e.dedupeKey === 'a:state:major_outage')).toHaveLength(1);
    });

    it('marks alerts sent in log-only mode (no channels configured)', async () => {
      const c = clock();
      const store = await mem();
      const n = createNotifier({ appUrl: 'https://x.test' }, { fetch: fakeFetch, log });
      await poller([check('a', () => 'major_outage')], store, n, { now: c.now }).runCycle();
      expect(await pending(store, c)).toEqual([]);
      expect(log.info).toHaveBeenCalledWith('slack webhook not configured; alert payload', expect.anything());
    });
  });

  describe('concurrent sends', () => {
    function slowNotifier(ms: number, ok = true) {
      const st = { inFlight: 0, max: 0, calls: 0 };
      const n: Notifier = {
        notify: async () => {
          st.calls += 1;
          st.inFlight += 1;
          st.max = Math.max(st.max, st.inFlight);
          await new Promise((r) => setTimeout(r, ms));
          st.inFlight -= 1;
          return ok ? { ok: true } : { ok: false, error: 'down' };
        },
      };
      return { n, st };
    }
    const eight = () => Array.from({ length: 8 }, (_, i) => check(`c${i}`, () => 'major_outage'));

    it('sends a cycle of 8 events at most 4 at a time, well under 8 x the send time', async () => {
      const { n, st } = slowNotifier(100);
      const p = poller(eight(), await mem(), n);
      const t0 = performance.now();
      await p.runCycle();
      const elapsed = performance.now() - t0;
      expect(st.calls).toBe(8);
      expect(st.max).toBe(4);
      expect(elapsed).toBeLessThan(500);
    });

    it('bounds the retry batch to 4 in flight too', async () => {
      const c = clock();
      const store = await mem();
      const failing = slowNotifier(10, false);
      await poller(eight(), store, failing.n, { now: c.now }).runCycle();
      const retry = slowNotifier(20);
      c.advance(180_000);
      await poller(eight(), store, retry.n, { now: c.now }).runCycle();
      expect(retry.st.calls).toBe(8);
      expect(retry.st.max).toBe(4);
    });
  });
});
