import { z } from 'zod';
import {
  fromStatuspageComponent,
  fromStatuspageImpact,
  fromStatuspageIndicator,
  matchesFilter,
  missingFilterEntries,
  summarise,
  worstStatus,
} from '../normalise.js';
import { ParseError, type CheckOutcome, type ComponentStatus, type Incident, type Status } from '../types.js';

const componentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    group_id: z.string().nullish(),
    group: z.boolean().nullish(),
  })
  .passthrough();

const incidentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    impact: z.string().nullish(),
    shortlink: z.string().nullish(),
    started_at: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    components: z.array(z.object({ id: z.string() }).passthrough()).nullish(),
  })
  .passthrough();

const summarySchema = z
  .object({
    status: z.object({ indicator: z.string() }).passthrough(),
    components: z.array(componentSchema),
    incidents: z.array(incidentSchema).nullish(),
    scheduled_maintenances: z.array(incidentSchema).nullish(),
  })
  .passthrough();

const unresolvedSchema = z.object({ incidents: z.array(incidentSchema).nullish() }).passthrough();

type RawIncident = z.infer<typeof incidentSchema>;

function parseWith<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ParseError(`Invalid Statuspage ${what}: ${r.error.message}`);
  return r.data;
}

export function parseStatuspage(
  summaryInput: unknown,
  unresolvedInput: unknown | null,
  opts: { pageUrl: string; components?: string[] },
): CheckOutcome {
  const summary = parseWith(summarySchema, summaryInput, 'summary');
  const unresolved = unresolvedInput == null ? null : parseWith(unresolvedSchema, unresolvedInput, 'incidents');

  const groupNames = new Map(summary.components.filter((c) => c.group).map((c) => [c.id, c.name]));
  const leaves = summary.components
    .filter((c) => !c.group)
    .map((c) => {
      const group = c.group_id ? groupNames.get(c.group_id) : undefined;
      const out: ComponentStatus = {
        name: c.name,
        ...(group ? { group } : {}),
        status: fromStatuspageComponent(c.status),
      };
      return { id: c.id, out };
    });

  const open = new Map<string, { raw: RawIncident; status: Status }>();
  for (const raw of [...(summary.incidents ?? []), ...(unresolved?.incidents ?? [])]) {
    if (raw.status === 'resolved' || raw.status === 'postmortem' || open.has(raw.id)) continue;
    open.set(raw.id, { raw, status: fromStatuspageImpact(raw.impact ?? '') });
  }
  for (const raw of summary.scheduled_maintenances ?? []) {
    if (raw.status !== 'in_progress' && raw.status !== 'verifying') continue;
    if (!open.has(raw.id)) open.set(raw.id, { raw, status: 'maintenance' });
  }

  const filter = opts.components;
  const matched = leaves.filter((c) => matchesFilter([c.out.name, c.out.group], filter));
  const matchedIds = new Set(matched.map((c) => c.id));
  const kept = [...open.values()].filter(({ raw }) => {
    if (!filter) return true;
    const ids = raw.components ?? [];
    return ids.length === 0 || ids.some((c) => matchedIds.has(c.id));
  });

  const incidents: Incident[] = kept.map(({ raw, status }) => {
    const startedAt = raw.started_at ?? raw.created_at;
    return {
      id: raw.id,
      title: raw.name,
      status,
      url: raw.shortlink ?? `${opts.pageUrl}/incidents/${raw.id}`,
      ...(startedAt ? { startedAt } : {}),
      ...(raw.updated_at ? { updatedAt: raw.updated_at } : {}),
    };
  });
  const components = matched.map((c) => c.out);

  const missing = missingFilterEntries(
    summary.components.map((c) => c.name),
    filter,
  );
  if (missing.length > 0) {
    const outcome: CheckOutcome = {
      status: 'unknown',
      components,
      incidents,
      error: `component filter matched nothing: ${missing.join(', ')}`,
    };
    return { ...outcome, summary: summarise(outcome) };
  }

  const statuses = [...components.map((c) => c.status), ...incidents.map((i) => i.status)];
  if (!filter) statuses.push(fromStatuspageIndicator(summary.status.indicator));
  const outcome: CheckOutcome = { status: worstStatus(statuses), components, incidents };
  return { ...outcome, summary: summarise(outcome) };
}
