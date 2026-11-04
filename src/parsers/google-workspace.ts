import { z } from 'zod';
import { ParseError, type CheckOutcome, type ComponentStatus, type Incident, type Status } from '../types.js';
import { matchesFilter, missingFilterEntries, summarise, worstStatus } from '../normalise.js';

const incidentSchema = z
  .object({
    id: z.string(),
    begin: z.string().nullish(),
    end: z.string().nullish(),
    modified: z.string().nullish(),
    external_desc: z.string().nullish(),
    status_impact: z.string().nullish(),
    affected_products: z.array(z.object({ title: z.string() }).passthrough()).nullish(),
    uri: z.string().nullish(),
  })
  .passthrough();

const incidentsSchema = z.array(incidentSchema);
const productsSchema = z.object({ products: z.array(z.object({ title: z.string() }).passthrough()) }).passthrough();

function fromImpact(s: string | null | undefined): Status {
  switch (s) {
    case 'SERVICE_OUTAGE':
      return 'major_outage';
    case 'SERVICE_DISRUPTION':
      return 'partial_outage';
    default:
      return 'degraded';
  }
}

/** First meaningful line of the description; bold-only heading lines (`**Summary:**`, `**Title**`) are skipped. */
function titleOf(desc: string | null | undefined, fallback: string): string {
  for (const line of (desc ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^\*\*[^*]+\*\*$/.test(t)) continue;
    const clean = t.replace(/\*\*/g, '').trim();
    if (clean) return clean;
  }
  return fallback;
}

function parseWith<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ParseError(`Invalid Google Workspace ${what}: ${r.error.message}`);
  return r.data;
}

export function parseGoogleWorkspace(
  incidentsInput: unknown,
  productsInput: unknown | null,
  opts: { now: Date; components?: string[] },
): CheckOutcome {
  const all = parseWith(incidentsSchema, incidentsInput, 'incidents');
  const products = productsInput == null ? null : parseWith(productsSchema, productsInput, 'products');
  const filter = opts.components;
  const nowMs = opts.now.getTime();

  const ongoing = all.filter((i) => {
    if (!i.end) return true;
    const end = Date.parse(i.end);
    return Number.isNaN(end) || end > nowMs;
  });
  const touching = ongoing.filter((i) =>
    matchesFilter((i.affected_products ?? []).map((p) => p.title), filter),
  );

  const incidents: Incident[] = touching.map((i) => ({
    id: i.id,
    title: titleOf(i.external_desc, i.id),
    status: fromImpact(i.status_impact),
    ...(i.uri ? { url: `https://www.google.com/appsstatus/dashboard/${i.uri}` } : {}),
    ...(i.begin ? { startedAt: i.begin } : {}),
    ...(i.modified ? { updatedAt: i.modified } : {}),
  }));

  const names = filter ?? [
    ...new Set(touching.flatMap((i) => (i.affected_products ?? []).map((p) => p.title))),
  ];
  const components: ComponentStatus[] = names.map((name) => {
    const statuses = touching.flatMap((raw, idx) =>
      matchesFilter((raw.affected_products ?? []).map((p) => p.title), [name]) ? [incidents[idx]!.status] : [],
    );
    return { name, status: worstStatus(statuses) };
  });

  const missing = products
    ? missingFilterEntries(products.products.map((p) => p.title), filter)
    : [];
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
    status: worstStatus(incidents.map((i) => i.status)),
    components,
    incidents,
  };
  return { ...outcome, summary: summarise(outcome) };
}
