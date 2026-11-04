import { FetchError, fetchJson, fetchText } from '../fetcher.js';
import { parseBetterstack } from '../parsers/betterstack.js';
import { parseFeed } from '../parsers/feed.js';
import { parseGoogleWorkspace } from '../parsers/google-workspace.js';
import { parseHttp } from '../parsers/http.js';
import { parseInstatus } from '../parsers/instatus.js';
import { parseSlack } from '../parsers/slack.js';
import { parseStatuspage } from '../parsers/statuspage.js';
import type { Check, CheckContext, CheckOutcome } from '../types.js';
import type { VendorConfig } from '../vendors.js';

const SLACK_PAGE = 'https://slack-status.com';
const GOOGLE_PAGE = 'https://www.google.com/appsstatus/dashboard/';

const stripSlash = (u: string): string => u.replace(/\/+$/, '');

interface Plan {
  pageUrl: string;
  sourceUrl: string;
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

function plan(v: VendorConfig): Plan {
  const components = v.components;
  switch (v.type) {
    case 'statuspage': {
      const base = stripSlash(v.url);
      const pageUrl = v.pageUrl ?? base;
      const sourceUrl = `${base}/api/v2/summary.json`;
      return {
        pageUrl,
        sourceUrl,
        async run(ctx) {
          const [summary, unresolved] = await Promise.all([
            fetchJson(ctx, sourceUrl),
            fetchJson(ctx, `${base}/api/v2/incidents/unresolved.json`, { optional: true }),
          ]);
          return parseStatuspage(summary, unresolved, { pageUrl, components });
        },
      };
    }
    case 'instatus': {
      const base = stripSlash(v.url);
      const pageUrl = v.pageUrl ?? base;
      const sourceUrl = `${base}/summary.json`;
      return {
        pageUrl,
        sourceUrl,
        async run(ctx) {
          const [summary, comps] = await Promise.all([
            fetchJson(ctx, sourceUrl),
            fetchJson(ctx, `${base}/v2/components.json`, { optional: true }),
          ]);
          return parseInstatus(summary, comps, { pageUrl, components });
        },
      };
    }
    case 'betterstack': {
      const base = stripSlash(v.url);
      const pageUrl = v.pageUrl ?? base;
      const sourceUrl = `${base}/index.json`;
      return {
        pageUrl,
        sourceUrl,
        async run(ctx) {
          const index = await fetchJson(ctx, sourceUrl, { headers: { Accept: 'application/json' } });
          return parseBetterstack(index, { pageUrl, now: ctx.now, components });
        },
      };
    }
    case 'slack':
      return {
        pageUrl: v.pageUrl ?? SLACK_PAGE,
        sourceUrl: v.url,
        async run(ctx) {
          return parseSlack(await fetchJson(ctx, v.url), { components });
        },
      };
    case 'google_workspace': {
      const productsUrl = new URL('products.json', v.url).toString();
      return {
        pageUrl: v.pageUrl ?? GOOGLE_PAGE,
        sourceUrl: v.url,
        async run(ctx) {
          const [incidents, products] = await Promise.all([
            fetchJson(ctx, v.url),
            fetchJson(ctx, productsUrl, { optional: true }),
          ]);
          return parseGoogleWorkspace(incidents, products, { now: ctx.now, components });
        },
      };
    }
    case 'rss':
    case 'atom':
      return {
        pageUrl: v.pageUrl ?? v.url,
        sourceUrl: v.url,
        async run(ctx) {
          const res = await fetchText(ctx, v.url);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new FetchError(`HTTP ${res.statusCode} from ${v.url}`);
          }
          return parseFeed(res.body, { now: ctx.now, lookbackHours: v.lookbackHours, components });
        },
      };
    case 'http':
      return {
        pageUrl: v.pageUrl ?? v.url,
        sourceUrl: v.url,
        async run(ctx) {
          const res = await fetchText(ctx, v.url);
          return parseHttp(res, { url: v.url, expectBody: v.expectBody, slowMs: v.slowMs });
        },
      };
  }
}

export function createVendorCheck(v: VendorConfig): Check {
  const p = plan(v);
  return {
    id: v.id,
    name: v.name,
    kind: v.type,
    pageUrl: p.pageUrl,
    sourceUrl: p.sourceUrl,
    notes: v.notes,
    feed: v.feed,
    run: p.run,
  };
}

export function createVendorChecks(vs: VendorConfig[]): Check[] {
  return vs.map(createVendorCheck);
}
