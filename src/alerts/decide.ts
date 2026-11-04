import { SEVERITY } from '../types.js';
import type { Check, CheckResult, ComponentStatus, Incident, Status } from '../types.js';

export interface AlertState {
  alertedStatus: Status | null;
  alertedIncidentIds: string[];
  consecutiveUnknown: number;
  lastAlertAt: string | null;
  since: string | null;
}

export type AlertKind =
  | 'degraded'
  | 'improved'
  | 'recovered'
  | 'new_incident'
  | 'reminder'
  | 'unreachable';

export interface AlertEvent {
  kind: AlertKind;
  checkId: string;
  checkName: string;
  from: Status | null;
  to: Status;
  since: string;
  at: string;
  incidents: Incident[];
  components: ComponentStatus[];
  error?: string;
  pageUrl?: string;
  dedupeKey: string;
}

export interface AlertPolicy {
  unknownAlertThreshold: number;
  reminderMinutes: number;
}

export function initialAlertState(): AlertState {
  return {
    alertedStatus: null,
    alertedIncidentIds: [],
    consecutiveUnknown: 0,
    lastAlertAt: null,
    since: null,
  };
}

export function decideAlerts(
  check: Pick<Check, 'id' | 'name' | 'pageUrl'>,
  prev: AlertState,
  result: CheckResult,
  policy: AlertPolicy,
): { events: AlertEvent[]; next: AlertState } {
  const t = result.checkedAt;
  const events: AlertEvent[] = [];
  const next: AlertState = { ...prev, alertedIncidentIds: [...prev.alertedIncidentIds] };

  const make = (
    kind: AlertKind,
    from: Status | null,
    to: Status,
    since: string,
    incidents: Incident[],
    dedupeKey: string,
    error?: string,
  ): AlertEvent => ({
    kind,
    checkId: check.id,
    checkName: check.name,
    from,
    to,
    since,
    at: t,
    incidents,
    components: result.components.filter((c) => c.status !== 'operational'),
    ...(error !== undefined ? { error } : {}),
    ...(check.pageUrl !== undefined ? { pageUrl: check.pageUrl } : {}),
    dedupeKey,
  });

  if (result.status === 'unknown') {
    next.consecutiveUnknown = prev.consecutiveUnknown + 1;
    if (next.consecutiveUnknown >= policy.unknownAlertThreshold && prev.alertedStatus !== 'unknown') {
      events.push(
        make('unreachable', prev.alertedStatus, 'unknown', t, [], `${check.id}:state:unknown`, result.error),
      );
      next.alertedStatus = 'unknown';
      next.since = t;
      next.lastAlertAt = t;
    }
  } else {
    next.consecutiveUnknown = 0;
    const s = result.status;
    const ids = result.incidents.map((i) => i.id);
    const operational = s === 'operational';

    if (prev.alertedStatus === null) {
      next.alertedStatus = s;
      next.since = t;
      next.alertedIncidentIds = ids;
      if (!operational) {
        events.push(make('degraded', null, s, t, result.incidents, `${check.id}:state:${s}`));
        next.lastAlertAt = t;
      }
    } else if (s !== prev.alertedStatus) {
      const p = prev.alertedStatus;
      const kind: AlertKind = operational
        ? 'recovered'
        : p === 'operational' || p === 'unknown' || SEVERITY[s] > SEVERITY[p]
          ? 'degraded'
          : 'improved';
      events.push(make(kind, p, s, t, result.incidents, `${check.id}:state:${s}`));
      next.alertedStatus = s;
      next.since = t;
      next.lastAlertAt = t;
      next.alertedIncidentIds = operational ? [] : [...new Set([...prev.alertedIncidentIds, ...ids])];
    } else {
      const known = new Set(prev.alertedIncidentIds);
      const fresh = result.incidents.filter((i) => !known.has(i.id));
      if (fresh.length > 0 && !operational) {
        const key = `${check.id}:incident:${fresh.map((i) => i.id).sort().join(',')}`;
        events.push(make('new_incident', s, s, prev.since ?? t, fresh, key));
        next.lastAlertAt = t;
      }
      next.alertedIncidentIds = operational ? [] : [...new Set([...prev.alertedIncidentIds, ...ids])];
    }
  }

  const a = next.alertedStatus;
  if (
    events.length === 0 &&
    !(result.status === 'unknown' && a !== 'unknown') &&
    a !== null &&
    a !== 'operational' &&
    a !== 'maintenance' &&
    next.lastAlertAt !== null &&
    Date.parse(t) - Date.parse(next.lastAlertAt) >= policy.reminderMinutes * 60_000
  ) {
    events.push(
      make(
        'reminder',
        a,
        a,
        next.since ?? t,
        a === 'unknown' ? [] : result.incidents,
        `${check.id}:reminder:${a}:${t}`,
        a === 'unknown' ? result.error : undefined,
      ),
    );
    next.lastAlertAt = t;
  }

  return { events, next };
}
