import { describe, expect, it } from 'vitest';
import { parseVendors } from '../src/vendors.js';

const TWO = `
vendors:
  - id: twilio
    name: Twilio
    type: statuspage
    url: https://status.twilio.com/api/v2/summary.json
  - id: slack
    name: Slack
    type: slack
    url: https://slack-status.com/api/v2.0.0/current
`;

describe('parseVendors', () => {
  it('parses entries and applies defaults', () => {
    const v = parseVendors(TWO);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ id: 'twilio', type: 'statuspage', lookbackHours: 24, slowMs: 5000 });
    expect(v[1]?.id).toBe('slack');
  });

  it('rejects duplicate ids and names the id', () => {
    expect(() => parseVendors(TWO.replace('id: slack', 'id: twilio'))).toThrow(/twilio/);
  });

  it('rejects a bad id and locates the entry', () => {
    expect(() => parseVendors(TWO.replace('id: slack', 'id: Bad Id'))).toThrow(/vendors\[1\]/);
  });

  it('rejects an unknown type', () => {
    expect(() => parseVendors(TWO.replace('type: slack', 'type: foo'))).toThrow(/type/);
  });

  it('rejects empty components', () => {
    const yaml = TWO.replace('type: slack', 'type: slack\n    components: []');
    expect(() => parseVendors(yaml)).toThrow(/components/);
  });

  it('rejects unknown keys', () => {
    const yaml = TWO.replace('type: slack', 'type: slack\n    lookbackHour: 3');
    expect(() => parseVendors(yaml)).toThrow(/lookbackHour/);
  });

  it('rejects non-http urls', () => {
    const yaml = TWO.replace('https://slack-status.com/api/v2.0.0/current', 'ftp://x');
    expect(() => parseVendors(yaml)).toThrow(/url/);
  });
});

describe('vendors.yaml', () => {
  it('loads the 16 real vendors in order and builds checks', async () => {
    const { loadVendors } = await import('../src/vendors.js');
    const { createVendorChecks } = await import('../src/checks/vendor.js');
    const vs = loadVendors('vendors.yaml');
    expect(vs.map((v) => v.id)).toEqual([
      'vapi', 'northflank', 'openai', 'twilio', 'telnyx', 'gohighlevel', 'odoo', 'google-workspace',
      'slack', 'elevenlabs', 'deepgram', 'cartesia', 'github', 'aws', 'anthropic', 'inspra-platform',
    ]);
    expect(createVendorChecks(vs)).toHaveLength(16);
  });
});
