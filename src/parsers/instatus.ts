import { z } from 'zod';
import { fromInstatus, matchesFilter, missingFilterEntries, summarise, worstStatus } from '../normalise.js';
import { ParseError, type CheckOutcome, type ComponentStatus, type Incident } from '../types.js';

const incidentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    impact: z.string().nullish(),
    url: z.string().nullish(),
    started: z.string().nullish(),
    updatedAt: z.string().nullish(),
  })
  .passthrough();

const summarySchema = z
  .object({
    page: z.object({ status: z.string() }).passthrough(),
    activeIncidents: z.array(incidentSchema).nullish(),
  })
  .passthrough();

const componentsSchema = z
  .object({
    components: z.array(
      z
        .object({
          name: z.string(),
          status: z.string(),
          group: z.object({ name: z.string() }).passthrough().nullish(),
          activeIncidents: z.array(incidentSchema).nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function parseWith<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ParseError(`Invalid Instatus ${what}: ${r.error.message}`);
  return r.data;
}

export function parseInstatus(
  summaryInput: unknown,
  componentsInput: unknown | null,
  opts: { pageUrl: string; components?: string[] },
): CheckOutcome {
  const summary = parseWith(summarySchema, summaryInput, 'summary');
  const payload = componentsInput == null ? null : parseWith(componentsSchema, componentsInput, 'components');
  const filter = opts.components;

  const toIncident = (raw: z.infer<typeof incidentSchema>): Incident => ({
    id: raw.id,
    title: raw.name,
    status: fromInstatus(raw.impact ?? ''),
    url: raw.url ?? `${opts.pageUrl}/${raw.id}`,
    ...(raw.started ? { startedAt: raw.started } : {}),
    ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
  });

  if (!payload) {
    const outcome: CheckOutcome = {
      status: fromInstatus(summary.page.status),
      components: [],
      incidents: (summary.activeIncidents ?? []).map(toIncident),
    };
    return { ...outcome, summary: summarise(outcome) };
  }

  const matched = payload.components.filter((c) => matchesFilter([c.name, c.group?.name], filter));
  const components: ComponentStatus[] = matched.map((c) => ({
    name: c.name,
    ...(c.group ? { group: c.group.name } : {}),
    status: fromInstatus(c.status),
  }));

  let rawIncidents = summary.activeIncidents ?? [];
  if (filter) {
    const byId = new Map<string, z.infer<typeof incidentSchema>>();
    for (const c of matched) for (const i of c.activeIncidents ?? []) if (!byId.has(i.id)) byId.set(i.id, i);
    rawIncidents = [...byId.values()];
  }
  const incidents = rawIncidents.map(toIncident);

  const missing = missingFilterEntries(
    payload.components.flatMap((c) => (c.group ? [c.name, c.group.name] : [c.name])),
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

  const outcome: CheckOutcome = {
    status: worstStatus([...components.map((c) => c.status), ...incidents.map((i) => i.status)]),
    components,
    incidents,
  };
  return { ...outcome, summary: summarise(outcome) };
}
