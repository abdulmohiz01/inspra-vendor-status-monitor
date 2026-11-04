import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ParseError, type CheckOutcome, type Incident, type Status } from '../types.js';
import { summarise, worstStatus } from '../normalise.js';

interface FeedItem {
  guid: string;
  title: string;
  link?: string;
  description: string;
  category: string;
  date: number;
  order: number;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

/** Text of a node that may be a string, a `{#text}` object (when it has attributes) or an array of those. */
function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text((v as Record<string, unknown>)['#text']);
  return '';
}

function atomLink(v: unknown): string | undefined {
  const links = (Array.isArray(v) ? v : v == null ? [] : [v]) as unknown[];
  const objs = links.filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null);
  const pick = objs.find((l) => l['@_rel'] === undefined || l['@_rel'] === 'alternate') ?? objs[0];
  const href = pick?.['@_href'];
  if (typeof href === 'string') return href;
  const first = links[0];
  return typeof first === 'string' ? first.trim() : undefined;
}

function toList(v: unknown): unknown[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function readItems(root: Record<string, unknown>): FeedItem[] {
  const rssItems = toList((root['rss'] as Record<string, unknown> | undefined)?.['channel'] as unknown)
    .flatMap((ch) => toList((ch as Record<string, unknown>)['item']));
  const atomEntries = toList((root['feed'] as Record<string, unknown> | undefined)?.['entry']);
  const isAtom = rssItems.length === 0 && atomEntries.length > 0;
  const raw = isAtom ? atomEntries : rssItems;

  return raw.map((r, order) => {
    const n = r as Record<string, unknown>;
    const title = text(n['title']);
    const guid = text(isAtom ? n['id'] : n['guid']) || text(n['link']) || title;
    const description = text(isAtom ? (n['summary'] ?? n['content']) : n['description']);
    const dateStr = text(isAtom ? (n['updated'] ?? n['published']) : n['pubDate']);
    const date = Date.parse(dateStr);
    const link = isAtom ? atomLink(n['link']) : text(n['link']) || undefined;
    return {
      guid,
      title,
      description,
      category: text(n['category']),
      date: Number.isNaN(date) ? Number.NaN : date,
      order,
      ...(link ? { link } : {}),
    };
  });
}

const RESOLVED = /\b(resolved|operating normally|completed)\b/i;

function activeStatus(item: FeedItem): Status {
  if (/maintenance/i.test(item.title) || /maintenance/i.test(item.category)) return 'maintenance';
  if (/disruption|outage|unavailable|down\b/i.test(`${item.title} ${item.description}`)) return 'partial_outage';
  return 'degraded';
}

export function parseFeed(
  feedXml: string,
  opts: { now: Date; lookbackHours: number; components?: string[] },
): CheckOutcome {
  const valid = XMLValidator.validate(feedXml);
  if (valid !== true) throw new ParseError(`Invalid feed XML: ${valid.err.msg}`);
  let root: Record<string, unknown>;
  try {
    root = xml.parse(feedXml) as Record<string, unknown>;
  } catch (e) {
    throw new ParseError(`Invalid feed XML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!root['rss'] && !root['feed']) throw new ParseError('Invalid feed: expected an RSS or Atom document');

  const needles = opts.components?.map((c) => c.toLowerCase());
  const items = readItems(root).filter((i) => {
    if (!needles) return true;
    const hay = `${i.guid} ${i.title} ${i.description}`.toLowerCase();
    return needles.some((n) => hay.includes(n));
  });

  // Newest item per group; ties keep feed order (feeds are newest-first).
  const groups = new Map<string, FeedItem>();
  for (const item of items) {
    const key = item.guid.replace(/#[0-9a-f]{40,}$/i, '');
    const cur = groups.get(key);
    const itemDate = Number.isNaN(item.date) ? -Infinity : item.date;
    const curDate = cur ? (Number.isNaN(cur.date) ? -Infinity : cur.date) : -Infinity;
    if (!cur || itemDate > curDate) groups.set(key, item);
  }

  const cutoff = opts.now.getTime() - opts.lookbackHours * 3_600_000;
  const incidents: Incident[] = [];
  for (const [key, item] of groups) {
    if (Number.isNaN(item.date) || item.date < cutoff || item.date > opts.now.getTime()) continue;
    if (RESOLVED.test(`${item.title} ${item.description}`)) continue;
    const iso = new Date(item.date).toISOString();
    incidents.push({
      id: key,
      title: item.title,
      status: activeStatus(item),
      ...(item.link ? { url: item.link } : {}),
      startedAt: iso,
      updatedAt: iso,
    });
  }

  const outcome: CheckOutcome = {
    status: worstStatus(incidents.map((i) => i.status)),
    components: [],
    incidents,
  };
  return { ...outcome, summary: summarise(outcome) };
}
