# Server deployment

Deployed 5 November 2026 to the existing Automate Accelerator server.

- Public URL: https://hub.automateaccelerator.com/insprastatus/
- Coolify project: AA-Internal-Projects, production
- Application: Inspra Status Monitor
- Application UUID: z7yvukgkfffn9tab0133y7qe
- Repository: https://github.com/abdulmohiz01/inspra-vendor-status-monitor
- Branch: feat/vercel
- Deployed commit: 78071832ef32c429313b0b5f01badcac584e4bf5
- Deployment: kww9u80jrbzif45elpouyzvz
- Build: Dockerfile, runtime port 8080
- Persistent volume: z7yvukgkfffn9tab0133y7qe-inspra-status-monitor-data mounted at /data
- APP_URL: https://hub.automateaccelerator.com/insprastatus
- BASE_PATH: /insprastatus
- Poll interval: 180 seconds, using the long-running process in src/main.ts
- Proxy path prefixes: Keep paths as-is
- Health probe: /insprastatus/healthz, Dockerfile healthcheck

The host Nginx configuration includes /etc/nginx/hub-apps.d/insprastatus.conf.
It redirects the exact /insprastatus URL to /insprastatus/ and forwards that path
to http://127.0.0.1:8081 with Host hub.automateaccelerator.com. Traefik then routes
the original path to this application. Nginx syntax was checked before reload.

The production container passed its healthcheck. Dashboard, stylesheet, JSON API,
and health endpoint returned HTTP 200. All 16 configured checks were populated.
Local validation passed 290 tests, TypeScript checks, and the production build.

Slack and SMTP credentials were not supplied, so external alerts remain unconfigured.
The protected manual poll endpoint remains disabled without CRON_SECRET; the normal
background poller runs independently. Historical data begins with this deployment.
