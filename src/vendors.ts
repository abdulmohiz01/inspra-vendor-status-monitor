import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export const VENDOR_TYPES = [
  'statuspage',
  'instatus',
  'betterstack',
  'slack',
  'google_workspace',
  'rss',
  'atom',
  'http',
] as const;

export type VendorType = (typeof VENDOR_TYPES)[number];

const httpUrl = z.string().refine(
  (v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'must be an http(s) URL' },
);

const vendorSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must match ^[a-z0-9][a-z0-9-]*$'),
    name: z.string().min(1),
    type: z.enum(VENDOR_TYPES),
    url: httpUrl,
    pageUrl: httpUrl.optional(),
    components: z.array(z.string().min(1)).min(1).optional(),
    notes: z.string().optional(),
    feed: z.literal('none').optional(),
    lookbackHours: z.number().int().min(1).max(168).default(24),
    expectBody: z.string().optional(),
    slowMs: z.number().int().min(100).max(60000).default(5000),
  })
  .strict();

const fileSchema = z.object({ vendors: z.array(vendorSchema) }).strict();

export type VendorConfig = {
  id: string;
  name: string;
  type: VendorType;
  url: string;
  pageUrl?: string;
  components?: string[];
  notes?: string;
  feed?: 'none';
  lookbackHours: number;
  expectBody?: string;
  slowMs: number;
};

export function parseVendors(yamlText: string): VendorConfig[] {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    throw new Error(`vendors: invalid YAML: ${(e as Error).message}`);
  }

  const result = fileSchema.safeParse(raw);
  if (!result.success) {
    const msgs = result.error.issues.map((i) => {
      const path = i.path.map((p, idx) => (typeof p === 'number' ? `[${p}]` : idx === 0 ? String(p) : `.${String(p)}`)).join('');
      return `${path || 'vendors file'}: ${i.message}`;
    });
    throw new Error(`Invalid vendors file:\n- ${msgs.join('\n- ')}`);
  }

  const vendors = result.data.vendors;
  const seen = new Set<string>();
  for (const v of vendors) {
    if (seen.has(v.id)) throw new Error(`Invalid vendors file: duplicate vendor id "${v.id}"`);
    seen.add(v.id);
  }
  return vendors as VendorConfig[];
}

export function loadVendors(path: string): VendorConfig[] {
  return parseVendors(readFileSync(path, 'utf8'));
}
