import { describe, expect, it } from 'vitest';
import type { AlertEvent } from '../../src/alerts/decide.js';
import { buildEmail, buildSlackPayload, headline, statusLabel } from '../../src/alerts/format.js';

const HUB = 'https://hub.automateaccelerator.com/insprastatus';

function ev(over: Partial<AlertEvent> = {}): AlertEvent {
  return {
    kind: 'degraded',
    checkId: 'northflank',
    checkName: 'Northflank',
    from: 'operational',
    to: 'major_outage',
    since: '2026-11-04T10:00:00.000Z',
    at: '2026-11-04T10:00:00.000Z',
    incidents: [
      {
        id: 'cmvv0rn5a092f14rutwccodpp',
        title: 'Security incident',
        status: 'major_outage',
        url: 'https://status.northflank.com/cmvv0rn5a092f14rutwccodpp',
      },
    ],
    components: [
      { name: 'Networking', status: 'major_outage' },
      { name: 'Certificates', status: 'major_outage' },
    ],
    pageUrl: 'https://status.northflank.com',
    dedupeKey: 'northflank:state:major_outage',
    ...over,
  };
}

describe('statusLabel', () => {
  it('maps every status', () => {
    expect(statusLabel('operational')).toBe('Operational');
    expect(statusLabel('degraded')).toBe('Degraded');
    expect(statusLabel('partial_outage')).toBe('Partial outage');
    expect(statusLabel('major_outage')).toBe('Major outage');
    expect(statusLabel('maintenance')).toBe('Maintenance');
    expect(statusLabel('unknown')).toBe('Unknown');
  });
});

describe('headline', () => {
  it('formats each kind', () => {
    expect(headline(ev())).toBe(':red_circle: Northflank: Major outage');
    expect(headline(ev({ to: 'degraded' }))).toBe(':large_orange_circle: Northflank: Degraded');
    expect(headline(ev({ kind: 'improved', from: 'major_outage', to: 'maintenance' }))).toBe(
      ':large_blue_circle: Northflank: Maintenance',
    );
    expect(headline(ev({ kind: 'recovered', from: 'major_outage', to: 'operational', incidents: [] }))).toBe(
      ':large_green_circle: Northflank recovered (was Major outage)',
    );
    expect(headline(ev({ kind: 'unreachable', from: null, to: 'unknown', error: 'boom' }))).toBe(
      ':white_circle: Northflank: status unavailable',
    );
    expect(headline(ev({ kind: 'new_incident', to: 'partial_outage' }))).toBe(
      ':red_circle: Northflank: new incident',
    );
    expect(headline(ev({ kind: 'reminder' }))).toBe(
      ':red_circle: Reminder: Northflank still Major outage since 2026-11-04T10:00:00.000Z',
    );
  });
});

describe('buildSlackPayload', () => {
  it('builds a degradation payload with incident, dashboard and status page links', () => {
    const p = buildSlackPayload(ev(), HUB);
    expect(p.text.startsWith(':red_circle: Northflank: Major outage')).toBe(true);
    const s = JSON.stringify(p.blocks);
    expect(s).toContain('<https://status.northflank.com/cmvv0rn5a092f14rutwccodpp|Security incident>');
    expect(s).toContain('https://hub.automateaccelerator.com/insprastatus/#northflank');
    expect(s).toContain('View dashboard');
    expect(s).toContain('Vendor status page');
    expect(s).toContain('Networking');
  });

  it('formats recovery', () => {
    const p = buildSlackPayload(
      ev({ kind: 'recovered', from: 'major_outage', to: 'operational', incidents: [], components: [] }),
      HUB,
    );
    expect(p.text).toBe(':large_green_circle: Northflank recovered (was Major outage)');
  });

  it('uses the supplied appUrl for the dashboard link and omits a missing status page', () => {
    const { pageUrl: _omit, ...rest } = ev();
    const s = JSON.stringify(buildSlackPayload(rest, 'http://localhost:4180').blocks);
    expect(s).toContain('http://localhost:4180/#northflank');
    expect(s).not.toContain('Vendor status page');
  });

  it('caps incidents at 5 and components at 10, and shows the error when unreachable', () => {
    const incidents = Array.from({ length: 7 }, (_, i) => ({
      id: `i${i}`,
      title: `Inc${i}`,
      status: 'degraded' as const,
    }));
    const components = Array.from({ length: 12 }, (_, i) => ({ name: `Comp${i}`, status: 'degraded' as const }));
    const s = JSON.stringify(buildSlackPayload(ev({ incidents, components }), HUB).blocks);
    expect(s).toContain('Inc4');
    expect(s).not.toContain('Inc5');
    expect(s).toContain('Comp9');
    expect(s).not.toContain('Comp10');
    const u = JSON.stringify(
      buildSlackPayload(
        ev({ kind: 'unreachable', to: 'unknown', incidents: [], components: [], error: 'ECONNRESET' }),
        HUB,
      ).blocks,
    );
    expect(u).toContain('ECONNRESET');
  });
});

describe('slack safety', () => {
  it('escapes mrkdwn and keeps links well-formed', () => {
    const e = ev({
      checkName: 'A&B <x>',
      incidents: [
        { id: '1', title: 'Elevated errors <API> & DB | x', status: 'degraded', url: 'https://s.test/i/1' },
        { id: '2', title: 'Bad url', status: 'degraded', url: 'https://s.test/a|b>c' },
        { id: '3', title: 'JS', status: 'degraded', url: 'javascript:alert(1)' },
      ],
      components: [{ name: '<b>', status: 'degraded' }],
    });
    const p = buildSlackPayload(e, HUB);
    expect(p.text).toContain('A&amp;B &lt;x&gt;');
    const s = JSON.stringify(p.blocks);
    expect(s).toContain('<https://s.test/i/1|Elevated errors &lt;API&gt; &amp; DB ¦ x>');
    expect(s).not.toContain('a|b');
    expect(s).not.toContain('javascript:');
    expect(s).toContain('Bad url (Degraded)');
    expect(s).toContain('&lt;b&gt;');
  });

  it('truncates a huge error below the Slack section limit', () => {
    const p = buildSlackPayload(
      ev({ kind: 'unreachable', to: 'unknown', incidents: [], components: [], error: 'x'.repeat(10_000) }),
      HUB,
    );
    for (const b of p.blocks as Array<{ text?: { text: string } }>) {
      if (b.text) expect(b.text.text.length).toBeLessThan(3000);
    }
    expect(JSON.stringify(p.blocks)).toContain('…');
  });

  it('renders a recovery with null from as Unknown', () => {
    expect(headline(ev({ kind: 'recovered', from: null, to: 'operational' }))).toBe(
      ':large_green_circle: Northflank recovered (was Unknown)',
    );
  });

  it('caps long error and title in email', () => {
    const m = buildEmail(ev({ kind: 'unreachable', to: 'unknown', error: 'y'.repeat(10_000) }), HUB);
    expect(m.text.length).toBeLessThan(2000);
  });
});

describe('buildEmail', () => {
  it('has no emoji in the subject and an absolute dashboard link in the body', () => {
    const m = buildEmail(ev(), HUB);
    expect(m.subject).toBe('Northflank: Major outage');
    expect(m.subject).not.toMatch(/:\w+:/);
    expect(m.text).toContain('https://hub.automateaccelerator.com/insprastatus/#northflank');
    expect(m.text).toContain('Security incident');
  });
});
