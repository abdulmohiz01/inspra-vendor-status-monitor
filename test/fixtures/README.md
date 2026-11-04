# Test fixtures

Real responses fetched on 2026-11-04 during endpoint verification, saved unmodified unless noted.

| File | Source |
|---|---|
| statuspage-openai-summary.json | https://status.openai.com/api/v2/summary.json (incident.io, Statuspage-compatible) |
| statuspage-github-summary.json / -unresolved.json | https://www.githubstatus.com/api/v2/{summary,incidents/unresolved}.json |
| statuspage-twilio-summary.json / -unresolved.json | https://status.twilio.com/api/v2/{summary,incidents/unresolved}.json (was "minor", Media Streams US1 degraded, 6 unresolved carrier incidents) |
| statuspage-telnyx-summary.json | https://status.telnyx.com/api/v2/summary.json (was under maintenance; incident.io, no unresolved.json) |
| statuspage-anthropic-summary.json / -unresolved.json | https://status.claude.com/api/v2/{summary,incidents/unresolved}.json |
| instatus-northflank-summary.json / -components.json | https://status.northflank.com/{summary.json,v2/components.json} (Instatus; live MAJOROUTAGE "Security incident") |
| betterstack-vapi.json | https://status.vapi.ai/index.json (needs `Accept: application/json`) |
| betterstack-gohighlevel.json | https://status.gohighlevel.com/index.json |
| betterstack-vapi-feed.rss | https://status.vapi.ai/feed.rss |
| slack-current.json | https://slack-status.com/api/v2.0.0/current |
| slack-current-active.json | **Derived**: incident 1582 from https://slack-status.com/api/v2.0.0/history wrapped in the `current` shape with `status: "active"` (no live Slack incident existed at fetch time) |
| google-workspace-incidents.json | https://www.google.com/appsstatus/dashboard/incidents.json (no ongoing incidents at fetch time; tests clear `end` on a real Gmail incident to simulate one) |
| google-workspace-products.json | https://www.google.com/appsstatus/dashboard/products.json |
| google-workspace-feed.atom | https://www.google.com/appsstatus/dashboard/en/feed.atom |
| aws-all.rss | https://status.aws.amazon.com/rss/all.rss |
| http-inspra-health.json | https://platform.inspra.ai/api/health body |
| http-odoo-health.json | https://www.odoo.com/web/health body |
