export const STATUSES = [
  'operational',
  'maintenance',
  'degraded',
  'partial_outage',
  'major_outage',
  'unknown',
] as const;

export type Status = (typeof STATUSES)[number];

export const SEVERITY: Record<Status, number> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
  unknown: -1,
};

export interface ComponentStatus {
  name: string;
  group?: string;
  status: Status;
}

export interface Incident {
  id: string;
  title: string;
  status: Status;
  url?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface CheckOutcome {
  status: Status;
  summary?: string;
  components: ComponentStatus[];
  incidents: Incident[];
  error?: string;
}

export interface CheckResult extends CheckOutcome {
  checkId: string;
  checkedAt: string;
  durationMs: number;
}

export type FetchFn = typeof fetch;

export interface CheckContext {
  fetch: FetchFn;
  signal: AbortSignal;
  now: Date;
  timeoutMs: number;
}

export interface Check {
  id: string;
  name: string;
  kind: string;
  pageUrl?: string;
  sourceUrl?: string;
  notes?: string;
  feed?: 'none';
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}
