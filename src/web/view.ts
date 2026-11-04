import { statusLabel } from '../alerts/format.js';
import { worstStatus } from '../normalise.js';
import type { Liveness, Poller } from '../poller.js';
import type { Store } from '../store.js';
import type { Check, ComponentStatus, Incident, Status } from '../types.js';

export interface CheckView {
  id: string;
  name: string;
  kind: string;
  status: Status;
  label: string;
  since: string | null;
  checkedAt: string | null;
  summary?: string;
  error?: string;
  incidents: Incident[];
  components: ComponentStatus[];
  pageUrl?: string;
  sourceUrl?: string;
  notes?: string;
  feed?: 'none';
  history: Array<{ day: string; status: Status | null }>;
}

export interface StatusView {
  generatedAt: string;
  overall: Status;
  issues: number;
  checks: CheckView[];
  liveness: Liveness;
  healthy: boolean;
}

const HISTORY_DAYS = 7;

function lastDays(now: Date, n: number): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    days.push(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)).toISOString().slice(0, 10),
    );
  }
  return days;
}

export function buildStatusView(deps: {
  checks: Check[];
  store: Store;
  poller: Pick<Poller, 'liveness' | 'isHealthy'>;
  now?: Date;
}): StatusView {
  const { checks, store, poller } = deps;
  const now = deps.now ?? new Date();
  const latest = store.latestResults();
  const history = store.dailyHistory(HISTORY_DAYS, now);
  const days = lastDays(now, HISTORY_DAYS);

  const views = checks.map((check): CheckView => {
    const r = latest.get(check.id);
    const status: Status = r?.status ?? 'unknown';
    // A fetch failure overwrites the latest result's incidents; fall back to the stored open ones.
    const incidents: Incident[] =
      status === 'unknown'
        ? store.incidents(check.id, { openOnly: true }).map((i) => ({
            id: i.incidentId,
            title: i.title,
            status: i.status,
            ...(i.url !== undefined ? { url: i.url } : {}),
            startedAt: i.startedAt,
          }))
        : (r?.incidents ?? []);
    const perDay = new Map((history.get(check.id) ?? []).map((h) => [h.day, h.status]));
    const view: CheckView = {
      id: check.id,
      name: check.name,
      kind: check.kind,
      status,
      label: statusLabel(status),
      since: store.getAlertState(check.id)?.since ?? null,
      checkedAt: r?.checkedAt ?? null,
      incidents,
      components: (r?.components ?? []).filter((c) => c.status !== 'operational'),
      history: days.map((day) => ({ day, status: perDay.get(day) ?? null })),
    };
    if (r?.summary !== undefined) view.summary = r.summary;
    if (r?.error !== undefined) view.error = r.error;
    if (check.pageUrl !== undefined) view.pageUrl = check.pageUrl;
    if (check.sourceUrl !== undefined) view.sourceUrl = check.sourceUrl;
    if (check.notes !== undefined) view.notes = check.notes;
    if (check.feed !== undefined) view.feed = check.feed;
    return view;
  });

  return {
    generatedAt: now.toISOString(),
    overall: worstStatus(views.map((v) => v.status)),
    issues: views.filter((v) => v.status !== 'operational').length,
    checks: views,
    liveness: poller.liveness(),
    healthy: poller.isHealthy(),
  };
}
