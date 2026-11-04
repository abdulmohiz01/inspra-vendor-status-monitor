import { z } from 'zod';
import { fromBetterstack, matchesFilter, missingFilterEntries, summarise, worstStatus } from '../normalise.js';
import { ParseError, type CheckOutcome, type Incident, type Status } from '../types.js';

const idSchema = z.union([z.string(), z.number()]).transform(String);

const indexSchema = z
  .object({
    data: z.object({ attributes: z.object({ aggregate_state: z.string() }).passthrough() }).passthrough(),
    included: z.array(
      z.object({ id: idSchema, type: z.string(), attributes: z.record(z.string(), z.unknown()) }).passthrough(),
    ),
  })
  .passthrough();

const resourceAttrs = z
  .object({
    public_name: z.string(),
    status: z.string(),
    status_page_section_id: idSchema.nullish(),
  })
  .passthrough();

const reportAttrs = z
  .object({
    title: z.string(),
    report_type: z.string(),
    starts_at: z.string().nullish(),
    ends_at: z.string().nullish(),
    aggregate_state: z.string(),
    affected_resources: z
      .array(z.object({ status_page_resource_id: idSchema, status: z.string() }).passthrough())
      .nullish(),
  })
  .passthrough();

const sectionAttrs = z.object({ name: z.string() }).passthrough();

function attrs<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ParseError(`Invalid BetterStack ${what}: ${r.error.message}`);
  return r.data;
}

export function parseBetterstack(
  input: unknown,
  opts: { pageUrl: string; now: Date; components?: string[] },
): CheckOutcome {
  const parsed = indexSchema.safeParse(input);
  if (!parsed.success) throw new ParseError(`Invalid BetterStack index: ${parsed.error.message}`);
  const { data, included } = parsed.data;
  const filter = opts.components;

  const sections = new Map(
    included
      .filter((i) => i.type === 'status_page_section')
      .map((i) => [i.id, attrs(sectionAttrs, i.attributes, 'section').name]),
  );

  const resources = included
    .filter((i) => i.type === 'status_page_resource')
    .map((i) => {
      const a = attrs(resourceAttrs, i.attributes, 'resource');
      const section = a.status_page_section_id != null ? sections.get(a.status_page_section_id) : undefined;
      return { id: i.id, name: a.public_name, group: section || undefined, status: fromBetterstack(a.status) };
    })
    .filter((r): r is typeof r & { status: Status } => r.status !== null);

  const matched = resources.filter((r) => matchesFilter([r.name, r.group], filter));
  const matchedIds = new Set(matched.map((r) => r.id));
  const components = matched.map((r) => ({
    name: r.name,
    ...(r.group ? { group: r.group } : {}),
    status: r.status,
  }));

  const now = opts.now.getTime();
  const incidents: Incident[] = [];
  for (const i of included.filter((x) => x.type === 'status_report')) {
    const a = attrs(reportAttrs, i.attributes, 'report');
    if (a.aggregate_state === 'resolved') continue;
    const isMaintenance = a.report_type === 'maintenance';
    if (isMaintenance) {
      const start = a.starts_at ? Date.parse(a.starts_at) : NaN;
      const end = a.ends_at ? Date.parse(a.ends_at) : Infinity;
      if (!(start <= now && now < end)) continue;
    }
    const affected = a.affected_resources ?? [];
    if (filter && !affected.some((r) => matchedIds.has(r.status_page_resource_id))) continue;
    const status: Status = isMaintenance
      ? 'maintenance'
      : worstStatus(
          affected.map((r) => fromBetterstack(r.status)).filter((s): s is Status => s !== null),
          'degraded',
        );
    incidents.push({
      id: i.id,
      title: a.title,
      status,
      url: `${opts.pageUrl}/${isMaintenance ? 'maintenance' : 'incident'}/${i.id}`,
      ...(a.starts_at ? { startedAt: a.starts_at } : {}),
    });
  }

  const missing = missingFilterEntries(
    resources.flatMap((r) => (r.group ? [r.name, r.group] : [r.name])),
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
  if (!filter) {
    const overall = fromBetterstack(data.attributes.aggregate_state);
    if (overall) statuses.push(overall);
  }
  const outcome: CheckOutcome = { status: worstStatus(statuses), components, incidents };
  return { ...outcome, summary: summarise(outcome) };
}
