import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../../src/web/dashboard.js';
import type { CheckView, StatusView } from '../../src/web/view.js';
import type { Status } from '../../src/types.js';

const NOW = '2026-11-04T12:00:00.000Z';

function card(id: string, status: Status, checkedAt: string | null = NOW): CheckView {
  return {
    id,
    name: id.toUpperCase(),
    kind: 'statuspage',
    status,
    label: status,
    since: null,
    checkedAt,
    incidents: [],
    components: [],
    history: [],
  };
}

function view(checks: CheckView[], extra: Partial<StatusView>): StatusView {
  return {
    generatedAt: NOW,
    overall: 'operational',
    issues: 0,
    maintenance: 0,
    awaitingFirstPoll: false,
    checks,
    liveness: {
      startedAt: NOW,
      lastCycleStartedAt: null,
      lastCycleCompletedAt: null,
      cycles: 0,
      running: false,
      intervalSeconds: 180,
    },
    healthy: true,
    ...extra,
  };
}

const header = (html: string): string => /<div class="overall[^"]*">[^<]*<\/div>/.exec(html)?.[0] ?? '';

describe('renderDashboard header', () => {
  it('shows "Awaiting first poll" in neutral styling before any result', () => {
    const checks = Array.from({ length: 16 }, (_, i) => card(`v${i}`, 'unknown', null));
    const h = header(renderDashboard(view(checks, { overall: 'unknown', issues: 16, awaitingFirstPoll: true }), ''));
    expect(h).toBe('<div class="overall neutral">Awaiting first poll</div>');
  });

  it('shows all operational', () => {
    const h = header(renderDashboard(view([card('a', 'operational')], {}), ''));
    expect(h).toBe('<div class="overall ok">All systems operational</div>');
  });

  it('shows issues and maintenance counts', () => {
    const checks = [card('a', 'degraded'), card('b', 'maintenance'), card('c', 'operational')];
    const h = header(renderDashboard(view(checks, { overall: 'degraded', issues: 1, maintenance: 1 }), ''));
    expect(h).toBe('<div class="overall bad">1 need attention · 1 in maintenance</div>');
  });

  it('shows maintenance only, without red styling', () => {
    const checks = [card('a', 'maintenance'), card('b', 'operational')];
    const h = header(renderDashboard(view(checks, { overall: 'maintenance', maintenance: 1 }), ''));
    expect(h).toBe('<div class="overall maintenance">1 in maintenance</div>');
  });

  it('omits maintenance wording when there is none', () => {
    const checks = [card('a', 'major_outage'), card('b', 'unknown')];
    const h = header(renderDashboard(view(checks, { overall: 'major_outage', issues: 2 }), ''));
    expect(h).toBe('<div class="overall bad">2 need attention</div>');
  });
});
