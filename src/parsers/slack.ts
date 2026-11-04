import { z } from 'zod';
import { SEVERITY, ParseError, type CheckOutcome, type ComponentStatus, type Incident, type Status } from '../types.js';
import { matchesFilter, summarise, worstStatus } from '../normalise.js';

const incidentSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    type: z.string().nullish(),
    status: z.string().nullish(),
    url: z.string().nullish(),
    date_created: z.string().nullish(),
    date_updated: z.string().nullish(),
    services: z.array(z.string()).nullish(),
  })
  .passthrough();

const currentSchema = z
  .object({
    status: z.string(),
    active_incidents: z.array(incidentSchema).nullish(),
  })
  .passthrough();

function fromSlackType(type: string | null | undefined): Status {
  switch (type) {
    case 'outage':
      return 'major_outage';
    case 'incident':
      return 'partial_outage';
    default:
      return 'degraded';
  }
}

export function parseSlack(current: unknown, opts: { components?: string[] }): CheckOutcome {
  const r = currentSchema.safeParse(current);
  if (!r.success) throw new ParseError(`Invalid Slack status payload: ${r.error.message}`);
  const filter = opts.components;

  const active = (r.data.active_incidents ?? []).filter(
    (i) => i.status !== 'resolved' && i.status !== 'completed',
  );
  const kept = active.filter((i) => matchesFilter(i.services ?? [], filter));

  const incidents: Incident[] = kept.map((i) => ({
    id: String(i.id),
    title: i.title,
    status: fromSlackType(i.type),
    ...(i.url ? { url: i.url } : {}),
    ...(i.date_created ? { startedAt: i.date_created } : {}),
    ...(i.date_updated ? { updatedAt: i.date_updated } : {}),
  }));

  const byService = new Map<string, Status>();
  kept.forEach((raw, idx) => {
    const status = incidents[idx]!.status;
    for (const svc of raw.services ?? []) {
      if (!matchesFilter([svc], filter)) continue;
      const prev = byService.get(svc);
      if (prev === undefined || SEVERITY[status] > SEVERITY[prev]) byService.set(svc, status);
    }
  });
  const components: ComponentStatus[] = [...byService].map(([name, status]) => ({ name, status }));

  const outcome: CheckOutcome = {
    status: worstStatus(incidents.map((i) => i.status)),
    components,
    incidents,
  };
  return { ...outcome, summary: summarise(outcome) };
}
