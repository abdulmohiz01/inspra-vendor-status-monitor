import { describe, expect, it } from 'vitest';
import { decideAlerts, initialAlertState } from '../../src/alerts/decide.js';
import type { AlertEvent, AlertState } from '../../src/alerts/decide.js';
import type { CheckResult, Incident, Status } from '../../src/types.js';

const policy = { unknownAlertThreshold: 3, reminderMinutes: 60 };
const check = { id: 'x', name: 'X', pageUrl: 'https://x.example/status' };
const base = Date.parse('2026-11-04T00:00:00Z');

function res(status: Status, minute: number, incidents: Incident[] = []): CheckResult {
  return {
    checkId: 'x',
    checkedAt: new Date(base + minute * 60_000).toISOString(),
    durationMs: 1,
    status,
    components: status === 'operational' || status === 'unknown' ? [] : [{ name: 'API', status }],
    incidents: status === 'unknown' ? [] : incidents,
    ...(status === 'unknown' ? { error: 'boom' } : {}),
  };
}

function run(results: CheckResult[]): AlertEvent[][] {
  let state: AlertState = initialAlertState();
  return results.map((r) => {
    const out = decideAlerts(check, state, r, policy);
    state = out.next;
    return out.events;
  });
}

const inc = (id: string): Incident => ({ id, title: id, status: 'degraded' });

describe('decideAlerts', () => {
  it('first operational observation raises nothing', () => {
    expect(run([res('operational', 0)])[0]).toEqual([]);
  });

  it('first major_outage raises degraded from null', () => {
    const [e] = run([res('major_outage', 0)])[0]!;
    expect(e!.kind).toBe('degraded');
    expect(e!.from).toBeNull();
    expect(e!.to).toBe('major_outage');
  });

  it('operational -> degraded', () => {
    const [, e] = run([res('operational', 0), res('degraded', 1)]);
    expect(e).toHaveLength(1);
    expect(e![0]!.kind).toBe('degraded');
    expect(e![0]!.dedupeKey).toBe('x:state:degraded');
    expect(e![0]!.components).toEqual([{ name: 'API', status: 'degraded' }]);
    expect(e![0]!.at).toBe(res('degraded', 1).checkedAt);
  });

  it('degraded -> major_outage is degraded; back is improved; to operational is recovered', () => {
    const r = run([
      res('degraded', 0),
      res('major_outage', 1),
      res('degraded', 2),
      res('operational', 3),
    ]);
    expect(r[1]![0]!.kind).toBe('degraded');
    expect(r[2]![0]!.kind).toBe('improved');
    expect(r[3]![0]!.kind).toBe('recovered');
  });

  it('same status twice raises nothing', () => {
    expect(run([res('degraded', 0), res('degraded', 1)])[1]).toEqual([]);
  });

  it('unreachable only after threshold, once, then recovered', () => {
    const r = run([
      res('operational', 0),
      res('unknown', 1),
      res('unknown', 2),
      res('unknown', 3),
      res('unknown', 4),
      res('operational', 5),
    ]);
    expect(r[1]).toEqual([]);
    expect(r[2]).toEqual([]);
    expect(r[3]).toHaveLength(1);
    expect(r[3]![0]!.kind).toBe('unreachable');
    expect(r[3]![0]!.from).toBe('operational');
    expect(r[3]![0]!.error).toBe('boom');
    expect(r[4]).toEqual([]);
    expect(r[5]![0]!.kind).toBe('recovered');
  });

  it('unknown below threshold during an outage raises nothing extra', () => {
    const r = run([
      res('major_outage', 0),
      res('unknown', 1),
      res('unknown', 2),
      res('major_outage', 3),
    ]);
    expect(r.flat()).toHaveLength(1);
  });

  it('new incident id on same status raises new_incident with only the new one', () => {
    const r = run([
      res('degraded', 0, [inc('a')]),
      res('degraded', 1, [inc('a'), inc('b')]),
      res('degraded', 2, [inc('a'), inc('b')]),
    ]);
    expect(r[1]).toHaveLength(1);
    expect(r[1]![0]!.kind).toBe('new_incident');
    expect(r[1]![0]!.incidents.map((i) => i.id)).toEqual(['b']);
    expect(r[1]![0]!.dedupeKey).toBe('x:incident:b');
    expect(r[2]).toEqual([]);
  });

  it('reminders fire every reminderMinutes', () => {
    const r = run([0, 30, 60, 90, 120].map((m) => res('degraded', m)));
    expect(r.map((e) => e.map((x) => x.kind))).toEqual([
      ['degraded'],
      [],
      ['reminder'],
      [],
      ['reminder'],
    ]);
    expect(r[2]![0]!.dedupeKey).toBe(`x:reminder:degraded:${res('degraded', 60).checkedAt}`);
  });

  it('maintenance gets no reminders', () => {
    const r = run([res('maintenance', 0), res('maintenance', 180)]);
    expect(r[0]).toHaveLength(1);
    expect(r[1]).toEqual([]);
  });

  it('unknown gets reminders after unreachable', () => {
    const r = run([
      res('operational', 0),
      res('unknown', 1),
      res('unknown', 2),
      res('unknown', 3),
      res('unknown', 63),
    ]);
    expect(r[3]![0]!.kind).toBe('unreachable');
    expect(r[4]).toHaveLength(1);
    expect(r[4]![0]!.kind).toBe('reminder');
    expect(r[4]![0]!.to).toBe('unknown');
  });
  it('does not remind from an unknown poll while alerted on another status', () => {
    const r = run([res('major_outage', 0, [inc('a')]), res('unknown', 60), res('major_outage', 61, [inc('a')])]);
    expect(r[1]).toEqual([]);
    expect(r[2]).toHaveLength(1);
    expect(r[2]![0]!.kind).toBe('reminder');
    expect(r[2]![0]!.incidents.map((i) => i.id)).toEqual(['a']);
  });

  it('does not re-alert an incident that flickers out and back', () => {
    const r = run([
      res('degraded', 0, [inc('a')]),
      res('degraded', 1),
      res('degraded', 2, [inc('a')]),
    ]);
    expect(r[1]).toEqual([]);
    expect(r[2]).toEqual([]);
  });

  it('alerts an incident again after recovery', () => {
    const r = run([
      res('degraded', 0, [inc('a')]),
      res('operational', 1),
      res('degraded', 2, [inc('a')]),
    ]);
    expect(r[2]).toHaveLength(1);
    expect(r[2]![0]!.kind).toBe('degraded');
    const r2 = run([
      res('degraded', 0, [inc('a')]),
      res('operational', 1),
      res('operational', 2),
      res('degraded', 3),
      res('degraded', 4, [inc('a')]),
    ]);
    expect(r2[4]![0]!.kind).toBe('new_incident');
  });

  it('flapping gives degraded, recovered, degraded', () => {
    const r = run([res('operational', 0), res('degraded', 1), res('operational', 2), res('degraded', 3)]);
    expect(r.flat().map((e) => e.kind)).toEqual(['degraded', 'recovered', 'degraded']);
  });

  it('unreachable from a non-operational status carries that status as from', () => {
    const r = run([res('major_outage', 0), res('unknown', 1), res('unknown', 2), res('unknown', 3)]);
    expect(r[3]![0]!.kind).toBe('unreachable');
    expect(r[3]![0]!.from).toBe('major_outage');
  });

  it('unreachable then major_outage is degraded from unknown', () => {
    const r = run([
      res('operational', 0),
      res('unknown', 1),
      res('unknown', 2),
      res('unknown', 3),
      res('major_outage', 4),
    ]);
    expect(r[4]![0]!.kind).toBe('degraded');
    expect(r[4]![0]!.from).toBe('unknown');
  });
});
