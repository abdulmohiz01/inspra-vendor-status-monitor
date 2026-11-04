import { buildSlackPayload } from '../src/alerts/format.js';
import type { AlertEvent } from '../src/alerts/decide.js';
import { loadConfig } from '../src/config.js';

const { appUrl } = loadConfig();

const incident = {
  id: 'cmvv0rn5a092f14rutwccodpp',
  title: 'Security incident',
  status: 'major_outage' as const,
  url: 'https://status.northflank.com/cmvv0rn5a092f14rutwccodpp',
};

const degradedEvent: AlertEvent = {
  kind: 'degraded',
  checkId: 'northflank',
  checkName: 'Northflank',
  from: 'operational',
  to: 'major_outage',
  since: '2026-10-30T13:40:03.096Z',
  at: '2026-10-30T13:41:00.000Z',
  incidents: [incident],
  components: [
    { name: 'Networking', status: 'major_outage' },
    { name: 'Certificates', status: 'major_outage' },
    { name: 'Services', status: 'major_outage' },
  ],
  pageUrl: 'https://status.northflank.com',
  dedupeKey: 'northflank:state:major_outage',
};

const recoveredEvent: AlertEvent = {
  ...degradedEvent,
  kind: 'recovered',
  from: 'major_outage',
  to: 'operational',
  at: '2026-11-02T12:00:00.000Z',
  incidents: [],
  components: [],
  dedupeKey: 'northflank:state:operational',
};

const out = {
  degradation: buildSlackPayload(degradedEvent, appUrl),
  recovery: buildSlackPayload(recoveredEvent, appUrl),
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
