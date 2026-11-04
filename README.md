# Vendor Status Monitor

One page showing whether every third-party platform Inspra depends on is up, plus an immediate alert when one degrades.

## Why

A client's call logging broke after Northflank changes and the client churned. This service polls the public status feeds of each vendor, normalises them to one status vocabulary, shows them on a dashboard and alerts Slack (and optionally email) on every change.

Stack: TypeScript on Node, pnpm. One process: a Hono server renders HTML, a poller loop runs in the same process, state lives in SQLite (better-sqlite3).

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

`pnpm dev` and `pnpm start` load `.env` automatically (Node's `--env-file-if-exists`, Node 22.9+). Variables already set in the shell take precedence over `.env`. Set a local `APP_URL` and `PORT` in `.env`, for example `PORT=4180` and `APP_URL=http://localhost:4180/insprastatus`. The dashboard is then at `http://localhost:4180/insprastatus/`. `APP_URL` must include the base path, because alert links are built from it.

Git Bash note: running with `BASE_PATH=/insprastatus` inline needs `MSYS_NO_PATHCONV=1`, or MSYS rewrites the path into a Windows path.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Run `src/main.ts` with `tsx watch`, loading `.env` if present |
| `pnpm build` | Compile `src` to `dist` with `tsc` |
| `pnpm start` | Run `node dist/main.js`, loading `.env` if present |
| `pnpm test` | Run the vitest suite (parsers against saved fixtures, normalisation, alert logic, server) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm sample:slack` | Print sample Slack payloads (degradation and recovery) to stdout |

## Environment variables

Empty values are treated as unset, except `BASE_PATH`, where an explicit empty value means "serve at root". Invalid values stop startup with a list of errors.

| Variable | Default | Range / notes |
|---|---|---|
| `PORT` | `8080` | 1-65535. Affects `pnpm dev`/`start` only; Compose pins the container to 8080 |
| `HOST` | `0.0.0.0` | Bind address. The container healthcheck probes 127.0.0.1, so keep this `0.0.0.0` or loopback |
| `APP_URL` | `https://hub.automateaccelerator.com/insprastatus` | http(s) URL including the base path; used for absolute links in alerts |
| `BASE_PATH` | `/insprastatus` | Prefix everything is served under; empty = root |
| `POLL_INTERVAL_SECONDS` | `180` | 60-600, with a little jitter |
| `FETCH_TIMEOUT_MS` | `10000` | 1000-60000 |
| `ALERT_REMINDER_MINUTES` | `60` | 5-1440 |
| `UNKNOWN_ALERT_THRESHOLD` | `3` | 1-20 consecutive unknowns before an `unreachable` alert |
| `HISTORY_RETENTION_DAYS` | `30` | 1-365 |
| `DATA_DIR` | `./data` | SQLite location (`/data` in the container) |
| `VENDORS_FILE` | `./vendors.yaml` | Path to the vendors file (`/app/vendors.yaml` in the container) |
| `SLACK_WEBHOOK_URL` | unset | Slack incoming webhook; must be an http(s) URL. Unset = alert payloads are logged, nothing is posted |
| `SMTP_HOST` | unset | Setting it enables email; then `SMTP_FROM` and `SMTP_TO` are required |
| `SMTP_PORT` | `587` | 1-65535 |
| `SMTP_SECURE` | `false` | `true`/`1` or `false`/`0` |
| `SMTP_USER` | unset | Optional |
| `SMTP_PASS` | unset | Optional |
| `SMTP_FROM` | unset | From address |
| `SMTP_TO` | unset | Comma-separated recipients |

Every outbound request sends `User-Agent: inspra-vendor-status-monitor/1.0`.

## vendors.yaml

A top-level `vendors:` list. The file is validated on load (unknown keys, bad URLs and duplicate ids are rejected).

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase slug, `^[a-z0-9][a-z0-9-]*$`, unique |
| `name` | yes | Display name |
| `type` | yes | `statuspage`, `instatus`, `betterstack`, `slack`, `google_workspace`, `rss`, `atom`, `http` |
| `url` | yes | Base URL of the status page, or the feed/endpoint itself for `slack`, `google_workspace`, `rss`, `atom`, `http` |
| `pageUrl` | no | Human-facing page to link to when `url` is not one |
| `components` | no | Component filter (below) |
| `notes` | no | Free text shown with the vendor |
| `feed` | no | `none` marks a vendor with no machine-readable feed; it is monitored with an HTTP ping, never scraped |
| `lookbackHours` | no | Feed types only: how far back to consider items active (1-168, default 24) |
| `expectBody` | no | `http` only: substring the response body must contain, else `degraded` |
| `slowMs` | no | `http` only: latency above this is `degraded` (100-60000, default 5000) |

**Component filter.** A list of names. For sources that list components, an entry matches a component's own name or its group/section name, case-insensitive and exact. For feeds (RSS/Atom, no component list) it is a case-insensitive substring match on guid, title and description. If an entry matches nothing on a source that does list components, the check returns `unknown` with an error, so a typo can never read as "operational".

**HTTP mapping.** 2xx/3xx is `operational`, unless the body lacks `expectBody` or latency exceeds `slowMs` (then `degraded`). 5xx is `major_outage`. 429 is `unknown`. Other 4xx is `degraded`. Network error or timeout is `unknown`.

### Add a vendor

1. Find the vendor's machine-readable feed (try `/api/v2/summary.json`, `/summary.json`, `/index.json`, then RSS, then an HTTP health URL).
2. Append an entry to `vendors.yaml` with the matching `type`.
3. Restart. A malformed entry stops startup with a clear message.

No code change is needed unless the vendor needs a new source type: add the type name to `VENDOR_TYPES` in `src/vendors.ts`, add a parser in `src/parsers/`, and add a case in `src/checks/vendor.ts`.

## Status normalisation

Statuses, exactly: `operational`, `degraded`, `partial_outage`, `major_outage`, `maintenance`, `unknown`. Overall status is the most severe component or incident; `unknown` only wins when nothing else is known. A fetch or parse failure is `unknown` with the error recorded, never an outage.

| Source | Mapping |
|---|---|
| Statuspage (components) | `operational`; `degraded_performance` -> degraded; `partial_outage`; `major_outage`; `under_maintenance` -> maintenance; anything else -> unknown |
| Statuspage (page indicator) | `none` -> operational; `minor` -> degraded; `major` -> partial_outage; `critical` -> major_outage; `maintenance` -> maintenance (used only when no component filter is set) |
| Statuspage (incident impact) | `major` -> partial_outage; `critical` -> major_outage; `maintenance` -> maintenance; anything else, including `none`, -> degraded (an open incident is never operational). In-progress scheduled maintenances count as maintenance |
| Instatus | `OPERATIONAL`/`UP` -> operational; `DEGRADEDPERFORMANCE`/`HASISSUES` -> degraded; `PARTIALOUTAGE`/`SOMEPARTIALOUTAGE`/`SOMEMAJOROUTAGE` -> partial_outage; `MAJOROUTAGE`/`ALLMAJOROUTAGE` -> major_outage; `UNDERMAINTENANCE`/`ALLUNDERMAINTENANCE` -> maintenance; unrecognised -> degraded |
| BetterStack | `operational`/`resolved` -> operational; `degraded` -> degraded; `downtime` -> major_outage; `maintenance` -> maintenance; `not_monitored` resources are skipped; unrecognised -> unknown |
| Slack | Active incident type `outage` -> major_outage; `incident` -> partial_outage; otherwise degraded |
| Google Workspace | `SERVICE_OUTAGE` -> major_outage; `SERVICE_DISRUPTION` -> partial_outage; otherwise degraded; only incidents on the filtered products |
| RSS / Atom | Unresolved item within `lookbackHours`: title or category mentions maintenance -> maintenance; text mentions disruption/outage/unavailable/down -> partial_outage; otherwise degraded. Items saying resolved / operating normally / completed are ignored |
| HTTP | See HTTP mapping above |

## Alerting

Alerts go to the Slack webhook and, if configured, SMTP email. If `SLACK_WEBHOOK_URL` is unset the payload is logged instead. Every alert links back to the dashboard using `APP_URL`.

| Kind | Fires when |
|---|---|
| `degraded` | A vendor moves from operational or unknown to a non-operational status, or to a more severe one. First sight of an already non-operational vendor also alerts as `degraded` |
| `improved` | Still non-operational but less severe |
| `recovered` | Back to operational |
| `new_incident` | Same status, but a new incident id appeared |
| `reminder` | Still non-operational `ALERT_REMINDER_MINUTES` after the last alert |
| `unreachable` | `UNKNOWN_ALERT_THRESHOLD` consecutive unknown results |

Dedupe keys: `<id>:state:<status>` for state changes and `unreachable`, `<id>:incident:<incident ids>` for `new_incident`, `<id>:reminder:<status>:<timestamp>` for reminders. A vendor first seen as operational produces no alert.

Fetch-failure behaviour:

- A fetch failure is recorded as `unknown`. It never resolves stored incidents.
- An `unreachable` alert fires only after `UNKNOWN_ALERT_THRESHOLD` consecutive unknowns.
- Reminders fire every `ALERT_REMINDER_MINUTES` while the alerted status is non-operational, but never for maintenance. An unknown poll does not trigger a reminder for a previously alerted real status.

## Dashboard, API, health

All paths are relative to `BASE_PATH` (default `/insprastatus`). `GET /` redirects to the prefix; with the default base path, `/healthz` at the root is a 404.

| Route | Purpose |
|---|---|
| `GET /insprastatus/` | Dashboard: vendor grid, colour badge, last checked, current incident with link, 7-day history strip |
| `GET /insprastatus/api/status` | Same data as JSON |
| `GET /insprastatus/healthz` | Poller liveness: 200 `{ok:true,...}` or 503 `{ok:false,reason:"poller stalled",...}` |
| `GET /insprastatus/assets/app.css`, `assets/favicon.svg` | Static assets |

## Adding a check

The scheduler, store, normaliser and alerter all work on the `Check` interface in `src/types.ts`. Vendor checks are one implementation (`createVendorChecks` in `src/checks/vendor.ts`).

```ts
interface Check {
  id: string;
  name: string;
  kind: string;
  pageUrl?: string;
  sourceUrl?: string;
  notes?: string;
  feed?: 'none';
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

interface CheckOutcome {
  status: Status;           // operational | degraded | partial_outage | major_outage | maintenance | unknown
  summary?: string;
  components: ComponentStatus[];
  incidents: Incident[];
  error?: string;           // set when status is unknown because the check itself failed
}
```

`CheckContext` supplies an injectable `fetch`, an abort `signal`, `now` and `timeoutMs`. Return `unknown` with `error` when the check cannot run; never report an outage you did not observe.

### Per-client flow checks (design only, not built)

These would catch the Northflank-style failure: the vendor says "up" but a client's flow is broken.

- **Silence alerts on call logs:** no call logs for client X in N minutes during business hours -> `degraded`.
- **Number-to-workspace mapping drift:** compare the Twilio/Telnyx number to GHL workspace mapping against an expected snapshot.
- **Downstream Odoo/email checks:** records created / emails delivered for recent calls.
- **Daily test calls:** place a scripted call and verify it lands in the logs.

Each would be a `Check` returning a `CheckOutcome`, registered alongside `createVendorChecks` (for example a future `clients.yaml` feeding a `createClientChecks`), with no scheduler, store or alerter changes.

## Deployment

The app serves natively under `BASE_PATH`; it does not rely on the proxy stripping a prefix.

### Coolify

1. Coolify -> Internal Projects -> New resource -> from the git repo.
2. Build pack: Dockerfile (primary), or Docker Compose using `docker-compose.yml`.
3. Ports Exposes: `8080`.
4. Domains: `https://hub.automateaccelerator.com/insprastatus` (Coolify supports path-based domains). No other app on `hub.automateaccelerator.com` may claim `/insprastatus`. DNS already resolves to the Coolify server `52.65.8.240`, so no DNS change.
5. Turn off Coolify's "Strip Prefixes" (Advanced) for this resource, because the app serves natively under the prefix. Verify the exact setting name in the Coolify UI.
6. Environment variables: `APP_URL`, `BASE_PATH`, `SLACK_WEBHOOK_URL`, optional `SMTP_*`.
7. Persistent storage: use a named or Coolify-managed volume at `/data` (Dockerfile pack). A host bind mount must be writable by uid 1000 (`node`). The compose pack uses the named volume `status-data`.
8. Health check: path `/insprastatus/healthz`, port `8080`.
9. To override the vendor list, mount a file and set `VENDORS_FILE` to its path.

**Before first deploy**

1. Repo reachable by Coolify (the private GitHub repo `abdulmohiz01/inspra-vendor-status-monitor`).
2. No DNS change needed (`hub.automateaccelerator.com` already resolves to 52.65.8.240). Strip Prefixes off, and no other app on the host claiming `/insprastatus`.
3. `SLACK_WEBHOOK_URL` set.
4. Optional: `SMTP_*` set.

### Generic Docker Compose

```bash
cp .env.example .env   # edit values
docker compose up -d --build
```

`docker-compose.yml` publishes no host port (`expose` only) and pins the container `PORT` to 8080, so a `PORT` in `.env` only affects `pnpm dev`/`start`. Unset secrets default to empty, and `.env` is read for `${VAR}` interpolation. Put it behind a reverse proxy that routes `/insprastatus` to port 8080 without stripping the prefix. For a local run publish a port:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

Dashboard: `http://localhost:4180/insprastatus/` (`LOCAL_PORT` changes the port; the local override sets `APP_URL` itself from `LOCAL_PORT`, so a production `APP_URL` in a shared `.env` is ignored). Data lives in the `status-data` volume.

## Vendors

Matches `vendors.yaml`. Endpoints were fetched and verified on 2026-11-04.

| id | Name | Type | Endpoint | Filter | Verification | Notes |
|---|---|---|---|---|---|---|
| `vapi` | Vapi | betterstack | https://status.vapi.ai | none | verified | `index.json` returns JSON only with `Accept: application/json` |
| `northflank` | Northflank | instatus | https://status.northflank.com | none | verified | Instatus, not Atlassian; `summary.json` + `v2/components.json` |
| `openai` | OpenAI | statuspage | https://status.openai.com | none | verified | incident.io page; summary only, no `unresolved.json` (404) |
| `twilio` | Twilio | statuspage | https://status.twilio.com | PROGRAMMABLE VOICE AU1, PROGRAMMABLE VOICE US1, ELASTIC SIP TRUNKING AU1, ELASTIC SIP TRUNKING US1, TWILIO PLATFORM | verified | Filter is an assumption to tune; unfiltered Twilio is permanently degraded from worldwide carrier incidents |
| `telnyx` | Telnyx | statuspage | https://status.telnyx.com | none | verified | incident.io page; summary only |
| `gohighlevel` | GoHighLevel | betterstack | https://status.gohighlevel.com | none | verified | Covers LeadConnector (`status.leadconnectorhq.com` does not resolve) |
| `odoo` | Odoo | http | https://www.odoo.com/web/health | none (`expectBody: '"pass"'`) | no feed | `feed: none`. `status.odoo.com` is a Twitter embed; monitored with an HTTP ping. Page link: https://status.odoo.com |
| `google-workspace` | Google Workspace | google_workspace | https://www.google.com/appsstatus/dashboard/incidents.json | Gmail, Google Calendar | verified | Also uses `products.json` |
| `slack` | Slack | slack | https://slack-status.com/api/v2.0.0/current | none | verified | Slack Status API v2.0.0 |
| `elevenlabs` | ElevenLabs | statuspage | https://status.elevenlabs.io | none | verified | incident.io page; summary only |
| `deepgram` | Deepgram | statuspage | https://status.deepgram.com | none | verified | Atlassian Statuspage |
| `cartesia` | Cartesia | statuspage | https://status.cartesia.ai | none | verified | incident.io page; summary only |
| `github` | GitHub | statuspage | https://www.githubstatus.com | none | verified | Atlassian Statuspage |
| `aws` | AWS | rss | https://status.aws.amazon.com/rss/all.rss | ap-southeast-2 | verified | Health Dashboard RSS, 24h lookback; guid carries the region. Page link: https://health.aws.amazon.com/health/status |
| `anthropic` | Anthropic | statuspage | https://status.claude.com | none | verified | Atlassian Statuspage; `status.anthropic.com` redirects here |
| `inspra-platform` | Inspra Platform | http | https://platform.inspra.ai/api/health | none (`expectBody: '"status":"healthy"'`) | verified | Our own health endpoint. Page link: https://platform.inspra.ai |

## Known limitations and tech debt

- The incident.io-hosted pages (OpenAI, Telnyx, ElevenLabs, Cartesia) have a summary but no `unresolved.json` supplement, so incidents come from `summary.json` only.
- AWS uses RSS heuristics, filtered to `ap-southeast-2`.
- The Twilio component filter is an assumption to tune.
- The Docker image has not been built or run, because Docker is not installed on the dev machine.
- The setting name for Coolify's "Strip Prefixes" needs checking in the UI.
- Per-client checks are design-only.
