import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import type { CheckResult, Incident, Status } from '../src/types.js';

const stores: Store[] = [];
const dirs: string[] = [];
function mem(): Store {
  const s = new Store(':memory:');
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function res(status: Status, at: string, extra: Partial<CheckResult> = {}): CheckResult {
  return {
    checkId: 'a',
    checkedAt: at,
    durationMs: 12,
    status,
    summary: 's',
    components: [],
    incidents: [],
    ...extra,
  };
}
const inc: Incident = { id: 'i1', title: 'Broken', status: 'degraded', url: 'https://x/i1' };
const T0 = '2026-11-04T00:00:00.000Z';
const T1 = '2026-11-04T01:00:00.000Z';
const T2 = '2026-11-04T02:00:00.000Z';

describe('Store', () => {
  it('round-trips latest result', () => {
    const s = mem();
    const r = res('degraded', T0, { incidents: [inc] });
    s.recordResult(r);
    expect(s.latestResults().get('a')).toEqual(r);
  });

  it('resolves an incident when it disappears', () => {
    const s = mem();
    s.recordResult(res('degraded', T0, { incidents: [inc] }));
    expect(s.incidents('a', { openOnly: true })).toHaveLength(1);
    s.recordResult(res('operational', T1));
    const all = s.incidents('a');
    expect(all).toHaveLength(1);
    expect(all[0]!.resolvedAt).toBe(T1);
    expect(all[0]!.startedAt).toBe(T0);
    expect(s.incidents('a', { openOnly: true })).toHaveLength(0);
  });

  it('reopens a resolved incident that reappears', () => {
    const s = mem();
    s.recordResult(res('degraded', T0, { incidents: [inc] }));
    s.recordResult(res('operational', T1));
    s.recordResult(res('degraded', T2, { incidents: [inc] }));
    const [i] = s.incidents('a');
    expect(i!.resolvedAt).toBeNull();
    expect(i!.lastSeenAt).toBe(T2);
  });

  it('keeps incident open on a fetch failure', () => {
    const s = mem();
    s.recordResult(res('degraded', T0, { incidents: [inc] }));
    s.recordResult(res('unknown', T1, { error: 'timeout' }));
    expect(s.incidents('a', { openOnly: true })).toHaveLength(1);
  });

  it('round-trips alert state; missing is undefined', () => {
    const s = mem();
    expect(s.getAlertState('a')).toBeUndefined();
    const st = {
      alertedStatus: 'degraded' as const,
      alertedIncidentIds: ['i1'],
      consecutiveUnknown: 0,
      lastAlertAt: T0,
      since: T0,
    };
    s.saveAlertState('a', st);
    expect(s.getAlertState('a')).toEqual(st);
  });

  it('logs alerts', () => {
    const s = mem();
    s.logAlert({
      kind: 'degraded',
      checkId: 'a',
      checkName: 'A',
      from: null,
      to: 'degraded',
      since: T0,
      at: T0,
      incidents: [],
      components: [],
      dedupeKey: 'a:state:degraded',
    });
    expect(s.recentAlerts(10)).toEqual([
      { dedupeKey: 'a:state:degraded', kind: 'degraded', checkId: 'a', at: T0 },
    ]);
  });

  it('dailyHistory uses worst non-unknown status per UTC day', () => {
    const s = mem();
    s.recordResult(res('degraded', '2026-11-03T10:00:00.000Z'));
    s.recordResult(res('operational', '2026-11-03T11:00:00.000Z'));
    s.recordResult(res('unknown', '2026-11-04T10:00:00.000Z', { error: 'x' }));
    const h = s.dailyHistory(7, new Date('2026-11-04T12:00:00Z')).get('a');
    expect(h).toEqual([
      { day: '2026-11-03', status: 'degraded' },
      { day: '2026-11-04', status: 'unknown' },
    ]);
  });

  it('prune deletes old history only', () => {
    const s = mem();
    const now = new Date('2026-11-04T12:00:00Z');
    const old = new Date(now.getTime() - 31 * 86_400_000).toISOString();
    const recent = new Date(now.getTime() - 29 * 86_400_000).toISOString();
    s.recordResult(res('operational', old));
    s.recordResult(res('operational', recent));
    expect(s.prune(30, now)).toBe(1);
    expect(s.dailyHistory(60, now).get('a')).toHaveLength(1);
  });

  it('creates the parent directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vsm-'));
    dirs.push(dir);
    const p = join(dir, 'nested', 'dir', 'x.db');
    const s = new Store(p);
    stores.push(s);
    expect(existsSync(p)).toBe(true);
  });
});
