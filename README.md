# Vendor Status Monitor

One page showing whether every third-party platform Inspra depends on is up, plus an immediate alert when one degrades.

## Why

A client's call logging broke after Northflank changes and the client churned. This service polls the public status feeds of each vendor, normalises them to one status vocabulary, shows them on a dashboard and alerts Slack (and optionally email) on every change.

Stack: TypeScript on Node, pnpm. A Hono app renders HTML and JSON. State lives in libSQL (`@libsql/client`): a local SQLite file in development, Turso in production. Production runs on Vercel (Hobby) as one function, and an external scheduler (cron-job.org) calls `/api/poll` every 3 minutes; each call runs one poll cycle. Locally, `pnpm dev` runs the same app with an in-process loop instead.

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

`pnpm dev` and `pnpm start` load `.env` automatically (Node's `--env-file-if-exists`, Node 22.9+). Variables already set in the shell take precedence over `.env`. With the defaults the dashboard is at `http://localhost:8080/`, data goes to `./data/status.db`, and the in-process loop polls every `POLL_INTERVAL_SECONDS`. No account or hosted service is needed locally.

To exercise the serverless path locally, set `CRON_SECRET` in `.env` and call the endpoint yourself:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:8080/api/poll
```

Git Bash note: running with a `BASE_PATH` such as `/insprastatus` inline needs `MSYS_NO_PATHCONV=1`, or MSYS rewrites the path into a Windows path.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Run `src/main.ts` (server plus in-process poll loop) with `tsx watch`, loading `.env` if present |
| `pnpm build` | Compile `src` to `dist` with `tsc` |
| `pnpm start` | Run `node dist/main.js`, loading `.env` if present |
| `pnpm test` | Run the vitest suite (parsers against saved fixtures, normalisation, alert logic, server) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm sample:slack` | Print sample Slack payloads (degradation and recovery) to stdout |

## Environment variables

Empty values are treated as unset. Invalid values stop startup with a list of errors (on Vercel every request then answers 500, and the function log has the list).

| Variable | Default | Range / notes |
|---|---|---|
| `DATABASE_URL` | `file:<DATA_DIR>/status.db` | `libsql://`, `https://`, `wss://`, `file:` or `:memory:`. Must be a hosted libSQL (Turso) URL on Vercel; a `file:` URL is refused there |
| `DATABASE_AUTH_TOKEN` | unset | Turso database token |
| `CRON_SECRET` | unset | At least 16 characters. `/api/poll` requires `Authorization: Bearer <CRON_SECRET>`; unset = `/api/poll` answers 503 |
| `APP_URL` | see notes | http(s) URL including the base path; used for absolute links in alerts. Default: `https://$VERCEL_PROJECT_PRODUCTION_URL` on Vercel, else `http://localhost:<PORT><BASE_PATH>` |
| `BASE_PATH` | empty | Prefix everything is served under; empty = root. Leave empty on Vercel |
| `PORT` | `8080` | 1-65535. Affects `pnpm dev`/`start` only; Compose pins the container to 8080 |
| `HOST` | `0.0.0.0` | Bind address for `pnpm dev`/`start` only. In a container it must be `0.0.0.0`; Compose pins it, and the Dockerfile sets it |
| `POLL_INTERVAL_SECONDS` | `180` | 60-600. Interval of the `pnpm dev`/`start` loop (with a little jitter). On Vercel set it to match the external schedule, because `/healthz` derives its stall threshold from it |
| `FETCH_TIMEOUT_MS` | `10000` | 1000-60000. Capped at 4000 on Vercel |
| `ALERT_REMINDER_MINUTES` | `60` | 5-1440 |
| `UNKNOWN_ALERT_THRESHOLD` | `3` | 1-20 consecutive unknowns before an `unreachable` alert |
| `HISTORY_RETENTION_DAYS` | `30` | 1-365 |
| `DATA_DIR` | `./data` | Local SQLite directory, used only when `DATABASE_URL` is unset (`/data` in the container) |
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
| `notes` | no | Free text, included in `/api/status` (not rendered on the dashboard) |
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

Delivery:

- Every alert is written to the `alerts` table before it is sent, then marked sent or failed.
- An alert counts as delivered only if every configured channel (Slack, email) succeeded.
- Failed sends are retried during the next poll cycle (alongside the checks), up to 5 attempts in total and only while the alert is less than 24 hours old.
- A check's result, alert state and outbox rows are committed together before anything is sent. If that commit fails nothing is sent, and the next cycle decides again.
- A retry re-sends to every configured channel, not only the one that failed.
- A failed alert is dropped, not retried, once a newer alert exists for the same vendor, so a stale "degraded" never arrives after the "recovered" that followed it.
- Log-only mode (no `SLACK_WEBHOOK_URL`, no SMTP) counts as delivered, so nothing is retried.
- Up to 4 alerts are sent at once.

Dedupe keys: `<id>:state:<status>` for state changes and `unreachable`, `<id>:incident:<incident ids>` for `new_incident`, `<id>:reminder:<status>:<timestamp>` for reminders. A vendor first seen as operational produces no alert.

Fetch-failure behaviour:

- A fetch failure is recorded as `unknown`. It never resolves stored incidents.
- An `unreachable` alert fires only after `UNKNOWN_ALERT_THRESHOLD` consecutive unknowns.
- Reminders fire every `ALERT_REMINDER_MINUTES` while the alerted status is non-operational, but never for maintenance. An unknown poll does not trigger a reminder for a previously alerted real status.

## Dashboard, API, health

All paths are relative to `BASE_PATH` (empty by default, so served at the root). With a non-empty base path, `GET /` redirects to the prefix.

| Route | Purpose |
|---|---|
| `GET /` | Dashboard: vendor grid, colour badge, last checked, current incident with link, 7-day history strip |
| `GET /api/status` | Same data as JSON |
| `GET` or `POST /api/poll` | Runs exactly one poll cycle. Requires `Authorization: Bearer <CRON_SECRET>` (constant-time compare): 401 without it, 503 if `CRON_SECRET` is unset, 405 for `HEAD`, 500 if the cycle itself fails. Answers `{ok, startedAt, durationMs, checks, alerts:{sent,failed,deferred}, results:[{id,status,durationMs,error?}]}`, with `skipped: "locked"` and no results when another cycle is already running |
| `GET /healthz` | Poller liveness, read from the database: 200 `{ok:true,...}`, or 503 with `reason` `"awaiting first poll"` or `"poller stalled"` (no completed cycle within `2 x POLL_INTERVAL_SECONDS + fetch timeout + 30s`) |
| `GET /assets/app.css`, `/assets/favicon.svg` | Static assets |

Poll cycles are serialised across instances by a lock row in the database, so an overlapping cron call, or a `pnpm dev` loop sharing the same database, skips instead of double-alerting. The lock carries an owner token and expires on its own if a run is killed: after 60s for a Vercel cycle, 5 minutes for a `pnpm dev`/`start` cycle. A run that outlives its lock never releases a successor's.

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

### Vercel (Hobby) + Turso + cron-job.org

The whole app is one Vercel Function, `api/index.js`, which exports `GET`/`POST`/`HEAD` handlers wrapping the Hono app (`src/vercel.ts`). `vercel.json` rewrites every path to it, bundles `vendors.yaml`, and caps the function at 15s (`maxDuration`); `public/` holds only `robots.txt`. There is no Vercel Cron, no in-process timer and no signal handling on this path: each authorised call to `/api/poll` runs one cycle and returns.

Two build constraints, both checked with a local `vercel build`:

- The entry is plain JavaScript importing the `tsc` output (`dist/`), which Vercel's build step (`pnpm build`) produces before it bundles the function. A `.ts` entry does not work: `@vercel/node` compiles it with the project's TypeScript, and TypeScript 7 has no JS compiler API.
- Remote databases are opened with `@libsql/client/web` (HTTP/WebSocket, pure JS). The native driver is loaded only for `file:` and `:memory:`, because its platform binary is resolved by a dynamic `require` the bundler cannot trace.

Timing: vendor fetches run in parallel, each capped at 4s; the per-check database commits run in parallel; each database round trip is capped at 2.5s and each alert send at 3s; a send that could not finish inside a 7s cycle budget is left for the next cycle, which retries it first. A cycle therefore stays well under 10s, leaving room for a cold start. (Vercel Hobby with Fluid Compute actually allows 300s per invocation; the 10s target is a design choice, not the platform limit.) The database schema and migrations run idempotently on each cold start.

**1. Turso database** (free tier)

```bash
turso auth login
turso db create vendor-status-monitor          # pick the location closest to the Vercel function region (default iad1, Washington DC)
turso db show vendor-status-monitor --url      # -> DATABASE_URL (libsql://...)
turso db tokens create vendor-status-monitor   # -> DATABASE_AUTH_TOKEN
```

No manual schema step: the app creates its tables on first request.

**2. Vercel project**

1. Vercel -> Add New -> Project -> import the GitHub repo `abdulmohiz01/inspra-vendor-status-monitor`.
2. Framework Preset: Other (`vercel.json` already sets `"framework": null`). Leave the build and output settings at their defaults; the install uses `pnpm-lock.yaml`. Vercel picks pnpm 9 by project age, which handles the lockfile; to use the pinned `packageManager` (pnpm 10) instead, add the environment variable `ENABLE_EXPERIMENTAL_COREPACK=1`. The Node.js version follows `engines` (`>=22.9`, so the newest available, currently 24.x); pin it in Settings -> Build and Deployment if preferred.
3. Environment Variables (Production):
   - `DATABASE_URL`, `DATABASE_AUTH_TOKEN` from step 1.
   - `CRON_SECRET`: a random string of at least 16 characters, e.g. `openssl rand -hex 32`.
   - `APP_URL`: optional. Defaults to `https://<production domain>`; set it if alerts should link to a custom domain.
   - `SLACK_WEBHOOK_URL`: optional; unset means alerts are only logged. Optional `SMTP_*` for email.
   - Leave `BASE_PATH` unset.
4. Deploy. Check `https://<project>.vercel.app/healthz`: before the first poll it answers 503 `awaiting first poll`, which is expected.

With the CLI instead of the dashboard: `vercel link`, `vercel env add <NAME> production` for each variable, then `vercel deploy --prod`.

**3. cron-job.org schedule** (free)

1. cron-job.org -> Create cronjob.
2. URL: `https://<project>.vercel.app/api/poll` (the production domain; preview URLs sit behind Vercel deployment protection).
3. Execution schedule: every 3 minutes (custom: minutes `*/3`, every hour, every day).
4. Advanced -> Request method `GET` (or `POST`). Headers: `Authorization` = `Bearer <CRON_SECRET>`.
5. Save, then run it once with "Test run": expect 200 and a JSON body with `ok: true`, `durationMs` and one entry per vendor. A 401 means the header or secret is wrong; 503 means `CRON_SECRET` is not set on Vercel; 500 means startup or the cycle failed (the body says which; details are in the function logs).
6. Optional: enable cron-job.org failure notifications, and point an uptime monitor at `/healthz`.

`POLL_INTERVAL_SECONDS` (default 180) must match this schedule, because `/healthz` derives its stall threshold from it.

### Self-hosted Docker (alternative)

The long-running mode (`pnpm start`, or the Docker image) runs the same app with an in-process loop and a local SQLite file under `DATA_DIR`. The Dockerfile and Compose files keep their old default `BASE_PATH=/insprastatus`; set `BASE_PATH=` (empty) and `APP_URL` in `.env` to serve at the root.

```bash
cp .env.example .env   # edit values
docker compose up -d --build
```

`docker-compose.yml` publishes no host port (`expose` only) and pins the container `PORT` to 8080 and `HOST` to `0.0.0.0`, so a `PORT` or `HOST` in `.env` only affects `pnpm dev`/`start`. It allows a 30s `stop_grace_period` so an in-flight poll cycle and its alert sends can finish. Unset secrets default to empty, and `.env` is read for `${VAR}` interpolation. Put it behind a reverse proxy that forwards the base path to port 8080 without stripping the prefix. For a local run publish a port:

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
- The Vercel deployment has not been run from the dev machine; the function entry and `vercel.json` are covered by tests and a local build, not a live deploy.
- Polling depends on cron-job.org. If it stops calling, nothing polls; `/healthz` turns 503 (`poller stalled`) after about 6.5 minutes, so point an uptime monitor at it.
- Per-client checks are design-only.
- No connectivity suppression: if the monitor itself loses network, every vendor goes `unknown`, then fires `unreachable` and later `recovered` (16 of each with the current vendor list).
- HTTP checks have no hysteresis: a single 502 alerts, and the next good response recovers.
- Each new maintenance window fires a `new_incident` alert.
- A retry after a partial failure re-sends to every configured channel, so a Slack-only failure can produce a duplicate email.
