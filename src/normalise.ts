import { SEVERITY, type CheckOutcome, type Status } from './types.js';

/** Most severe status. `unknown` only wins when it is the only status present. */
export function worstStatus(statuses: Status[], fallback: Status = 'operational'): Status {
  const known = statuses.filter((s) => s !== 'unknown');
  if (known.length === 0) return statuses.length > 0 ? 'unknown' : fallback;
  return known.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst));
}

export function fromStatuspageComponent(s: string): Status {
  switch (s) {
    case 'operational':
      return 'operational';
    case 'degraded_performance':
      return 'degraded';
    case 'partial_outage':
      return 'partial_outage';
    case 'major_outage':
      return 'major_outage';
    case 'under_maintenance':
      return 'maintenance';
    default:
      return 'unknown';
  }
}

export function fromStatuspageIndicator(s: string): Status {
  switch (s) {
    case 'none':
      return 'operational';
    case 'minor':
      return 'degraded';
    case 'major':
      return 'partial_outage';
    case 'critical':
      return 'major_outage';
    case 'maintenance':
      return 'maintenance';
    default:
      return 'unknown';
  }
}

/** Incident impact: an open incident is never "operational", so `none` maps to degraded. */
export function fromStatuspageImpact(s: string): Status {
  switch (s) {
    case 'major':
      return 'partial_outage';
    case 'critical':
      return 'major_outage';
    case 'maintenance':
      return 'maintenance';
    default:
      return 'degraded';
  }
}

export function fromInstatus(s: string): Status {
  switch (s) {
    case 'OPERATIONAL':
    case 'UP':
      return 'operational';
    case 'DEGRADEDPERFORMANCE':
    case 'HASISSUES':
      return 'degraded';
    case 'PARTIALOUTAGE':
    case 'SOMEPARTIALOUTAGE':
    case 'SOMEMAJOROUTAGE':
      return 'partial_outage';
    case 'MAJOROUTAGE':
    case 'ALLMAJOROUTAGE':
      return 'major_outage';
    case 'UNDERMAINTENANCE':
    case 'ALLUNDERMAINTENANCE':
      return 'maintenance';
    default:
      return 'degraded';
  }
}

/** Returns null for components that are not monitored (should be skipped). */
export function fromBetterstack(s: string): Status | null {
  switch (s) {
    case 'operational':
    case 'resolved':
      return 'operational';
    case 'degraded':
      return 'degraded';
    case 'downtime':
      return 'major_outage';
    case 'maintenance':
      return 'maintenance';
    case 'not_monitored':
      return null;
    default:
      return 'unknown';
  }
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Exact (case-insensitive) match of any name against the filter. No filter matches everything. */
export function matchesFilter(names: Array<string | undefined>, filter?: string[]): boolean {
  if (!filter) return true;
  const wanted = new Set(filter.map(norm));
  return names.some((n) => n !== undefined && wanted.has(norm(n)));
}

/** Filter entries that match none of the available component names (likely typos). */
export function missingFilterEntries(allNames: string[], filter?: string[]): string[] {
  if (!filter) return [];
  const have = new Set(allNames.map(norm));
  return filter.filter((f) => !have.has(norm(f)));
}

const LABEL: Record<Status, string> = {
  operational: 'operational',
  maintenance: 'under maintenance',
  degraded: 'degraded',
  partial_outage: 'partial outage',
  major_outage: 'major outage',
  unknown: 'status unknown',
};

export function summarise(o: Pick<CheckOutcome, 'status' | 'incidents' | 'components'>): string {
  if (o.status === 'operational') return 'All systems operational';
  const affected = o.components.filter((c) => c.status !== 'operational' && c.status !== 'unknown');
  const parts = [LABEL[o.status][0]!.toUpperCase() + LABEL[o.status].slice(1)];
  if (affected.length > 0) {
    const names = affected.slice(0, 3).map((c) => c.name);
    const more = affected.length - names.length;
    parts.push(`${names.join(', ')}${more > 0 ? ` +${more} more` : ''}`);
  }
  if (o.incidents.length > 0) {
    parts.push(`${o.incidents.length} active incident${o.incidents.length === 1 ? '' : 's'}`);
  }
  return parts.join(' - ');
}
