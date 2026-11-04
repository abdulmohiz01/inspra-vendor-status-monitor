import { afterEach, describe, expect, it } from 'vitest';
import { buildStatusView } from '../../src/web/view.js';
import { Store } from '../../src/store.js';
import type { Check, CheckResult, Status } from '../../src/types.js';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function mkStore(): Store {
  const s = new Store(':memory:');
  stores.push(s);
  return s;
}

function mkCheck(id: string, extra: Partial<Check> = {}): Check {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'statuspage',
    run: async () => ({ status: 'operational', components: [], incidents: [] }),
    ...extra,
  };
}

function result(checkId: string, status: Status, extra: Partial<CheckResult> = {}): CheckResult {
  return { checkId, checkedAt: NOW.toISOString(), durationMs: 5, status, components: [], incidents: [], ...extra };
}

const poller = {
  liveness: () => ({
    startedAt: NOW.toISOString(),
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    cycles: 0,
    running: false,
    intervalSeconds: 180,
  }),
  isHealthy: () => true,
};

describe('buildStatusView', () => {
  it('reports never-polled checks as unknown with empty history', () => {
    const v = buildStatusView({ checks: [mkCheck('a')], store: mkStore(), poller, now: NOW });
    const c = v.checks[0]!;
    expect(c.status).toBe('unknown');
    expect(c.checkedAt).toBeNull();
    expect(c.since).toBeNull();
    expect(c.history).toHaveLength(7);
    expect(c.history.every((h) => h.status === null)).toBe(true);
    expect(v.overall).toBe('unknown');
    expect(v.healthy).toBe(true);
  });

  it('reflects a degraded result, history, issues and only non-operational components', () => {
    const store = mkStore();
    store.recordResult(
      result('a', 'degraded', {
        components: [
          { name: 'API', status: 'degraded' },
          { name: 'Web', status: 'operational' },
        ],
      }),
    );
    store.recordResult(result('b', 'operational'));
    const v = buildStatusView({ checks: [mkCheck('a'), mkCheck('b')], store, poller, now: NOW });
    expect(v.checks.map((c) => c.id)).toEqual(['a', 'b']);
    expect(v.checks[0]!.status).toBe('degraded');
    expect(v.checks[0]!.label).toBe('Degraded');
    expect(v.checks[0]!.history.at(-1)).toEqual({ day: '2026-11-04', status: 'degraded' });
    expect(v.checks[0]!.history[0]!.day).toBe('2026-10-29');
    expect(v.checks[0]!.components.map((c) => c.name)).toEqual(['API']);
    expect(v.overall).toBe('degraded');
    expect(v.issues).toBe(1);
  });

  it('flags awaiting first poll only when no check has a result', () => {
    const store = mkStore();
    const checks = [mkCheck('a'), mkCheck('b')];
    expect(buildStatusView({ checks, store, poller, now: NOW }).awaitingFirstPoll).toBe(true);
    store.recordResult(result('a', 'operational'));
    const v = buildStatusView({ checks, store, poller, now: NOW });
    expect(v.awaitingFirstPoll).toBe(false);
    expect(v.issues).toBe(1);
  });

  it('counts maintenance separately from issues; overall is unchanged', () => {
    const store = mkStore();
    store.recordResult(result('a', 'maintenance'));
    store.recordResult(result('b', 'operational'));
    store.recordResult(result('c', 'degraded'));
    store.recordResult(result('d', 'maintenance'));
    const v = buildStatusView({ checks: ['a', 'b', 'c', 'd'].map((id) => mkCheck(id)), store, poller, now: NOW });
    expect(v.issues).toBe(1);
    expect(v.maintenance).toBe(2);
    expect(v.overall).toBe('degraded');
  });

  it('shows since only when the latest status matches the alerted status', () => {
    const store = mkStore();
    const state = {
      alertedStatus: 'major_outage' as const,
      alertedIncidentIds: [],
      consecutiveUnknown: 0,
      lastAlertAt: '2026-11-04T10:00:00.000Z',
      since: '2026-11-04T10:00:00.000Z',
    };
    store.saveAlertState('a', state);
    store.saveAlertState('b', state);
    store.recordResult(result('a', 'major_outage'));
    store.recordResult(result('b', 'unknown', { error: 'timeout' }));
    const v = buildStatusView({ checks: [mkCheck('a'), mkCheck('b')], store, poller, now: NOW });
    expect(v.checks[0]!.since).toBe('2026-11-04T10:00:00.000Z');
    expect(v.checks[1]!.since).toBeNull();
  });

  it('keeps open incidents visible while the latest result is unknown', () => {
    const store = mkStore();
    store.recordResult(
      result('a', 'degraded', {
        incidents: [{ id: 'i1', title: 'Ongoing', status: 'degraded', url: 'https://x.test/i1' }],
      }),
    );
    store.recordResult(result('a', 'unknown', { error: 'timeout' }));
    const v = buildStatusView({ checks: [mkCheck('a')], store, poller, now: NOW });
    const c = v.checks[0]!;
    expect(c.status).toBe('unknown');
    expect(c.error).toBe('timeout');
    expect(c.incidents).toHaveLength(1);
    expect(c.incidents[0]).toMatchObject({ id: 'i1', title: 'Ongoing', url: 'https://x.test/i1' });
  });
});
