# Vendor Status Monitor — Design

Date: 2026-11-04. Source: Abdul's brief plus two add-ons (Coolify deploy shape, APP_URL/domain). The brief is the approved design; this file records it plus the decisions made from endpoint verification.

## Why

A client's call logging broke after Northflank changes and the client churned. Inspra needs one place showing whether every third-party platform it depends on is up, and an immediate alert when any of them degrades.

## Hard rules

- Build and run locally only. No deploys, no hosting changes, no pushes. Local `git init`, no remote.
- Touch nothing outside this folder. No system-wide installs; project-local deps only.
- Never post to a real Slack or send real email. Secrets only via env; ship `.env.example`, never a real `.env`.
- No access to or changes on the Coolify instance.

## Stack

TypeScript on Node (pnpm). One process: Hono HTTP server with server-rendered HTML (no SPA), poller loop in the same process, SQLite via better-sqlite3, vitest, zod for config validation. No queue, no ORM. Multi-stage Dockerfile + docker-compose.yml + .env.example.

## Functional scope

1. **vendors.yaml**: one entry per vendor (id, name, type, url, optional component filter, optional notes, optional `feed: none`). Validated on load. Adding a vendor = one entry. File path overridable via `VENDORS_FILE`.
2. **Pollers** by preference: Atlassian Statuspage JSON (`/api/v2/summary.json` + `/api/v2/incidents/unresolved.json`), then RSS/Atom, then plain HTTP ping. Vendors without a public machine-readable feed are marked `feed: none` with an HTTP ping, never HTML scraping.
3. **Normalise** to `operational | degraded | partial_outage | major_outage | maintenance | unknown`, keeping component detail and incident titles + links. Fetch failures → `unknown` with the error recorded (never "outage"). Per-check timeouts and isolation.
4. **Polling** every `POLL_INTERVAL_SECONDS` (default 180, allowed 60–600) with a little jitter.
5. **SQLite**: status check history, incidents with start/resolve times, prune history older than ~30 days.
6. **Alerts** on any change of state (degradation and recovery) to Slack incoming webhook (`SLACK_WEBHOOK_URL`) and optional SMTP email (`SMTP_*`). Dedupe keyed on vendor + incident/state; reminder if still unresolved after `ALERT_REMINDER_MINUTES` (default 60). Require N consecutive unknowns before alerting on `unknown` (configurable). Webhook unset → log payload. Script prints sample Slack payloads (degradation + recovery) to stdout. Alerts carry absolute links built from `APP_URL` (default `https://hub.automateaccelerator.com/insprastatus`).
7. **Dashboard** `/`: grid of vendors, colour badge, last checked, current incident title + link, 7-day history strip. Plain, minimal, few colours. `/api/status` JSON; `/healthz` reports poller liveness (not just 200).
8. **Extension point**: one `Check` interface the scheduler, store, normaliser and alerter accept; vendor checks are one implementation. Per-client flow checks are design-only (README).
9. **README**: setup, env vars, config, add a vendor, add a check, Coolify + generic compose deployment, before-first-deploy checklist, vendor table.
10. **Tests**: each parser against saved real fixtures, normalisation, alert dedupe/reminder logic.

## Deployment shape (Coolify, add-ons)

- Coolify project **Internal Projects**, own resource, hosted under a path: `https://hub.automateaccelerator.com/insprastatus` (supersedes the earlier `status.automateaccelerator.com` target). hub.automateaccelerator.com already resolves to the Coolify server (52.65.8.240); no DNS change. Dockerfile build pack primary, Docker Compose build pack secondary.
- `BASE_PATH` (default `/insprastatus`, empty = root) and `APP_URL` default `https://hub.automateaccelerator.com/insprastatus`. The app serves everything natively under `BASE_PATH` (dashboard, `/api/status`, `/healthz`, static assets, every generated link and redirect); no reliance on proxy prefix-stripping. `GET /` redirects to the prefix. Coolify's "Strip Prefixes" must be off for this resource; no other app on the host may claim the path.
- Dockerfile: multi-stage, non-root, `EXPOSE` app port, `HEALTHCHECK` on `${BASE_PATH}/healthz` using `node` (present in image), listen `0.0.0.0`, `PORT` from env. No secrets in image.
- docker-compose.yml: no host `ports:` (Traefik routes by domain), `expose:` only, named volume for the data dir, env as `${VAR}`, healthcheck, `restart: unless-stopped`. `docker-compose.local.yml` override publishes a port for local runs.
- README "Before first deploy": (1) push to a git repo Coolify can reach (private GitHub `abdulmohiz01/inspra-vendor-status-monitor`); (2) no DNS step: hub.* already resolves; Strip Prefixes off; (3) `SLACK_WEBHOOK_URL`; (4) optional SMTP.
- Source control (supersedes "no remote"): once the build is verified, a private GitHub repo `abdulmohiz01/inspra-vendor-status-monitor` gets `main` as a one-time baseline push, gated on `gh auth status` showing abdulmohiz01 with repo scope. After that, feature branches and PRs only; never push to main again.

## Endpoint verification (fetched 2026-11-04)

| Vendor | Platform found | Source type | Endpoint |
|---|---|---|---|
| Vapi | BetterStack | betterstack | https://status.vapi.ai/index.json (needs `Accept: application/json`) |
| Northflank | Instatus (not Atlassian) | instatus | https://status.northflank.com/summary.json + /v2/components.json |
| OpenAI | incident.io (Statuspage-compatible summary; no unresolved.json → 404) | statuspage | https://status.openai.com |
| Twilio | Atlassian Statuspage | statuspage | https://status.twilio.com |
| Telnyx | incident.io (summary only) | statuspage | https://status.telnyx.com |
| GoHighLevel / LeadConnector | BetterStack; status.leadconnectorhq.com does not resolve | betterstack | https://status.gohighlevel.com/index.json |
| Odoo | status.odoo.com is a Twitter embed, no feed | http, `feed: none` | https://www.odoo.com/web/health (returns `{"status": "pass"}`) |
| Google Workspace | Google JSON | google_workspace | https://www.google.com/appsstatus/dashboard/incidents.json (+ products.json), filter Gmail, Google Calendar |
| Slack | Slack Status API v2 | slack | https://slack-status.com/api/v2.0.0/current |
| ElevenLabs | incident.io | statuspage | https://status.elevenlabs.io |
| Deepgram | Atlassian Statuspage | statuspage | https://status.deepgram.com |
| Cartesia | incident.io | statuspage | https://status.cartesia.ai |
| GitHub | Atlassian Statuspage | statuspage | https://www.githubstatus.com |
| AWS | Health Dashboard RSS | rss | https://status.aws.amazon.com/rss/all.rss filtered to `ap-southeast-2` (guid carries the region) |
| Anthropic | Atlassian Statuspage (status.anthropic.com redirects) | statuspage | https://status.claude.com |
| Inspra platform | our own | http | https://platform.inspra.ai/api/health (JSON `"status":"healthy"`) |

## Decisions

- **Source types beyond the brief's four**: `instatus`, `betterstack`, `slack`, `google_workspace` added because Northflank, Vapi, GHL, Slack and Google publish structured JSON that is better than RSS heuristics. `rss` and `atom` share one feed parser.
- **Component filter** = list of names; matches a component's own name or its group/section name, case-insensitive exact. For feeds (no component list) it is a case-insensitive substring on guid/title/description. A filter entry that matches nothing on a source that lists components → `unknown` with an error (a typo must not read as "operational").
- **Twilio filter** (assumption, tune later): PROGRAMMABLE VOICE AU1, PROGRAMMABLE VOICE US1, ELASTIC SIP TRUNKING AU1, ELASTIC SIP TRUNKING US1, TWILIO PLATFORM. Unfiltered Twilio is permanently "degraded" from worldwide carrier incidents.
- **HTTP mapping**: 2xx/3xx → operational, unless the body lacks `expectBody` or latency > `slowMs` (default 5000) → degraded; 5xx → major_outage; 429 → unknown; other 4xx → degraded; network error/timeout → unknown.
- **Fetch failures never resolve stored incidents.**
- **Alert kinds**: degraded, improved, recovered, new_incident, reminder, unreachable. No reminders for maintenance.
