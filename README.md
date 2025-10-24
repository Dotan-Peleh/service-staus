Mobile Services Status Dashboard
================================

A lightweight status dashboard for mobile app dependencies. It fetches from official APIs where available, falls back to HTML heuristics when needed, supports push updates via webhooks, and shows last resolved incidents when applicable.

Quick start
-----------

```bash
# Run the server
node server.js
# Open http://localhost:5173
```

If port 5173 is busy:
```bash
kill -9 $(lsof -nP -iTCP:5173 -sTCP:LISTEN -t) || true
node server.js
```

Key files
---------
- index.html: UI and client logic
- server.js: API endpoints, proxy, webhook handlers, HTML parsers
- status-store.json: Persistent store for webhook-updated states

Normalized local endpoints (recommended)
----------------------------------------
Use these endpoints so the dashboard shows consistent, real-time status:
- Apple App Store: /api/apple/status
- Google Play Store: /api/google/play-status
- Google Cloud (AdMob infra): /api/google/cloud-status
- Facebook/Meta: /api/facebook/status
- Firebase (products subset): /api/firebase/status

Behavior details
----------------
- Pass-through normalized JSON: The frontend accepts { state, severity, title, eta, detail, lastIncident } directly from the server.
- Last incident: Google Play/Google Cloud return state: operational with lastIncident for resolved/closed issues. The UI renders “Last incident” when operational.
- Facebook/Meta heuristics: Only flags ongoing incidents; generic text or resolved notes yield operational (or operational with lastIncident).
- Relative URL proxy: GET /api/fetch?url=/api/... is supported; relative URLs resolve to http://127.0.0.1:5173.
- Persistence: Webhook updates are saved to status-store.json and shown immediately on load via /api/state.

Service coverage
----------------
- The monitor polls these services every 5 minutes in production (Netlify Scheduled Function):
  - Google Play Store (and Google Play Services)
  - Apple App Store
  - Firebase (subset of products)
  - Mixpanel
  - Singular
  - Sentry
  - Facebook Audience Network
  - Google AdMob (via Google Cloud status)
  - Realm Database (MongoDB)
  - Slack
  - Notion
  - Figma
  - Jira Software

- Unity services were removed from the dashboard and the background monitor.

-Backend monitoring
------------------
- Production scheduling: We recommend using an external scheduler (e.g., GCP Cloud Scheduler) to invoke the monitor endpoint every 5 minutes.
  - Target URL (required): `https://<site>/.netlify/functions/monitor`
  - Example (GCP):
    ```bash
    gcloud scheduler jobs create http services-monitor \
      --schedule="*/5 * * * *" \
      --uri="https://<site>/.netlify/functions/monitor" \
      --http-method=GET \
      --time-zone="UTC"
    ```
- Netlify internal schedule: currently disabled in code to avoid double-runs when using GCP Scheduler. You can re-enable by uncommenting `exports.config = { schedule: '*/5 * * * *' }` in `netlify/functions/monitor.js`.
- Slack notifications:
  - One message when a service enters incident (severity emoji + title + startedAt + status link).
  - One message when that incident resolves (“back to normal” + startedAt + resolved time + status link).
  - Deduped per service using a stable service key; the monitor stores `startedAt` and (when available) `incidentId` inside persisted state to avoid repeats even if incident IDs change or disappear.
  - Persistence uses GCP Firestore when configured (preferred), with Netlify Blobs (`status-notify`) as fallback and then in-memory. Firestore collection: `kv_status_notify`. Keys are sanitized (slashes `/` replaced with `_`). Examples you should see in Firestore:
    - `meta:lastRunAt`
    - `state:https:__jira-software.status.atlassian.com`
    - `notify:https:__status.sentry.io:start`
    - `sig:https:__status.sentry.io:start`
- A cooldown guard prevents accidental repeats; genuine changes (new incident, resolution) notify immediately.
- Page visits do not send Slack messages; only the backend monitor posts.

Monitor diagnostics
-------------------
- Manually trigger a run:
  - `https://<site>/.netlify/functions/monitor` (alias: `https://<site>/api/monitor`)
  - Force a run (bypass 60s coalescing): `https://<site>/.netlify/functions/monitor?force=1`
- Send a Slack test message (no status check):
  - `https://<site>/.netlify/functions/monitor?test=1`
- Inspect current vs persisted state to troubleshoot notifications:
  - `https://<site>/.netlify/functions/monitor?debug=1`
- Health (last successful run timestamp, ms since epoch):
  - `https://<site>/.netlify/functions/monitor?health=1`
  - Uses the shared KV provider (Firestore if configured). If `lastRunAt` stays 0, ensure your scheduler targets `/.netlify/functions/monitor` (not `/api/monitor`).

Mixpanel status source
----------------------
- Mixpanel now uses only the official Statuspage JSON at `https://www.mixpanelstatus.com` (summary/status). The HTML fallback was removed to avoid false positives.


Webhooks (push updates)
-----------------------
Apple doesn’t provide webhooks; use an aggregator (e.g., StatusGator) to push updates.

Endpoint:
```
POST /api/webhooks/statusgator?key=<URL-encoded statusUrl>
```
- Apple key: raw https://developer.apple.com/system-status/ → URL-encoded https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F
- Example with tunnel: https://<public-host>/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F

Simulate via curl:
```bash
# Minor
curl -X POST -H "Content-Type: application/json" -d '{"status":"degraded","title":"App Store purchase delays"}' \
  "http://localhost:5173/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F"
# Critical
curl -X POST -H "Content-Type: application/json" -d '{"status":"major outage","title":"App Store down"}' \
  "http://localhost:5173/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F"
# Resolution
curl -X POST -H "Content-Type: application/json" -d '{"status":"up"}' \
  "http://localhost:5173/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F"
```

Public tunnel (optional)
------------------------
Expose your local server to receive real webhooks:
```bash
# LocalTunnel
npx --yes localtunnel --port 5173
# or ngrok
brew install ngrok
ngrok http 5173
```

Slack notifications (optional)
------------------------------
```bash
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/XXX/YYY/ZZZ"
# or
export SLACK_BOT_TOKEN="xoxb-..."; export SLACK_CHANNEL="#alerts"
node server.js
```

Netlify configuration for Slack
-------------------------------
1) Site settings → Build & deploy → Environment → Add variable
   - `SLACK_WEBHOOK_URL` = your Incoming Webhook URL (recommended)
   - or `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` (channel ID)
2) Deploy (prefer “Clear cache and deploy site”).
3) Verify: `https://<site>/api/notify/enabled` returns `{"enabled": true}`.
4) Test send:
```bash
curl -X POST https://<site>/api/notify/slack \
  -H 'Content-Type: application/json' \
  -d '{"service":"Unity LevelPlay","severity":"minor","title":"Test incident","statusUrl":"https://status.unity.com/"}'
```

Notifications behavior
----------------------
- Client-side Slack notifications are disabled; visiting/refreshing the dashboard will not send alerts.
- Alerts are emitted only on state transitions detected by the backend monitor (local or Netlify scheduled function).
- Once-per-incident dedupe: Each service alerts once when an incident starts and once when it resolves.
  - Dedupe key is the `statusUrl` (normalized). Multiple cards pointing to the same page (e.g., Unity) produce a single alert per continuous incident.
  - Netlify persists incident state in Blobs (`status-notify` store) to avoid repeats across cold starts. The local server keeps state in memory during the process lifetime.
  - The previous cooldown-based suppression (`NOTIFY_COOLDOWN_MINUTES`) is no longer used for backend monitor notifications.

Troubleshooting
---------------
- Port in use (EADDRINUSE):
```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN | cat
kill -9 $(lsof -nP -iTCP:5173 -sTCP:LISTEN -t)
node server.js
```
- Clear stale webhook state:
```bash
node -e "const fs=require('fs');const p='status-store.json';const s=JSON.parse(fs.readFileSync(p));delete s['https://developer.apple.com/system-status/'];fs.writeFileSync(p, JSON.stringify(s,null,2));"
```
- Verify endpoints:
```bash
curl -sS http://localhost:5173/api/apple/status | jq .
curl -sS http://localhost:5173/api/google/play-status | jq .
curl -sS http://localhost:5173/api/google/cloud-status | jq .
curl -sS http://localhost:5173/api/facebook/status | jq .
```

Notes
-----
- The UI shows “Manual Review” when neither a webhook state nor a parsable response is available.
- When a service aggregates multiple cards (e.g., Google Play Store and Google Play Services), the first check result is reused and shown as “Also covers …”.


Logic Reference
---------------

Architecture
------------
- Frontend (`index.html`) renders cards and calls internal `/api/*` endpoints.
- Local server (`server.js`) serves static files and exposes normalized endpoints for development.
- Netlify functions:
  - `netlify/functions/api.js`: All production `/api/*` endpoints (Apple, Google Play/Cloud, Facebook, Firebase, Mixpanel, Slack, Statuspage proxy, diagnostics).
  - `netlify/functions/monitor.js`: Scheduled (or externally invoked) background monitor that polls services and posts Slack notifications.

Normalized status schema
------------------------
Each endpoint returns a normalized JSON object:
```json
{ "state": "operational" | "incident" | "unknown", "severity": "minor" | "critical" | null, "title": "string|null", "eta": "ISO|null", "detail": "string|null", "lastIncident": { "title": "string", "endedAt": "ISO|null" } }
```
- For active incidents, endpoints may also include `startedAt` and `incidentId` when available.

Parsing logic by service
------------------------
- Apple App Store: Apple JSON/JS (`system_status_en_US.json|.js`) → checks events for App Store / App Store Connect.
- Google Play Store/Services: HTML heuristics; detects ongoing incident vs last resolved incident.
- Google Cloud (AdMob infra): HTML heuristics with marketing text sanitization; same ongoing vs last incident.
- Facebook Audience Network: HTML heuristics from `metastatus.com` with resolved handling.
- Firebase: products.json + incidents.json; selects Authentication, Remote Config, Crashlytics; detects active incidents.
- Mixpanel: Statuspage JSON only (`www.mixpanelstatus.com`); no HTML fallback. Returns `startedAt` and `incidentId` when present.
- Slack: API `v2.0.0/current` (preferred) then HTML fallback with strict green detection.
- Statuspage-backed services (Singular, Sentry, Notion, Figma, Jira, Realm/MongoDB): `summary.json` for active incidents with `impact` mapping; `incidents.json` used where needed to surface last resolved.

Background monitoring and notifications
--------------------------------------
- Runner: External scheduler (recommended GCP Cloud Scheduler) GETs `/.netlify/functions/monitor` every 5 minutes.
- What’s polled: Google Play (Store/Services), Apple App Store, Firebase, Mixpanel, Singular, Sentry, Facebook Audience Network, Google AdMob (Cloud), Realm/MongoDB, Slack, Notion, Figma, Jira Software.
- Slack behavior:
  - On incident start: one message (emoji by severity, title, startedAt, status link)
  - On resolve: one message (back to normal, startedAt, resolved time, status link)
- Dedup and idempotency:
  - Stable service key: derived from `statusUrl`.
  - Stable incident key (startKey): `id:<incidentId>` when available, else `ts:<startedAt_ms>`.
  - Persisted fields per service: `state, startedAt, startKey, lastNotifiedStartAt, lastNotifiedStartKey, lastNotifiedResolveAt, lastNotifiedResolveKey, lastNonIncidentTs, incidentId`.
  - A start is sent only if `startKey` is new or was never notified.
  - A resolve is sent only if a start for the same `startKey` was previously notified and no resolve was sent yet.
  - Overlap guards: coalesce runs if the last run was <60s ago; 120s suppression window with pre-set last-notified timestamps prevents concurrent duplicate sends.
  - Local monitor is disabled by default in `server.js` (enable with `ENABLE_LOCAL_MONITOR=1`) to avoid double posts alongside the cloud scheduler.

Persistence
-----------
- Persistence order: GCP Firestore → Netlify Blobs → in-memory.
- Firestore setup:
  - Add env vars (Netlify site or secrets manager):
    - `GCP_PROJECT_ID`
    - either `GCP_SA_JSON` (raw JSON) or `GCP_SA_JSON_BASE64` (base64 of the same JSON)
  - The monitor writes to collection `kv_status_notify` with document IDs like `state:<serviceKey>`, `notify:<serviceKey>`, `sig:<serviceKey>`, and `meta:lastRunAt`. The `<serviceKey>` replaces `/` with `_` (e.g., `https:__status.sentry.io`).
- Netlify Blobs remains as a fallback when Firestore isn’t configured; memory is the last resort.

Endpoints
---------
- Status checks (examples):
  - `/api/apple/status`, `/api/google/play-status`, `/api/google/cloud-status`, `/api/facebook/status`, `/api/firebase/status`, `/api/mixpanel/status`, `/api/slack/status`
  - Statuspage proxy: `/api/statuspage?base=https://<statuspage-base>`
  - Proxy (dev tools): `/api/fetch?url=...`, `/api/check-html?url=...`
- Monitor:
  - Run now: `/.netlify/functions/monitor` (alias: `/api/monitor`)
  - Test Slack: `/.netlify/functions/monitor?test=1`
  - Debug state: `/.netlify/functions/monitor?debug=1`
  - Health: `/.netlify/functions/monitor?health=1` (lastRunAt in ms)

Configuration
-------------
- Slack: set `SLACK_WEBHOOK_URL` or `SLACK_BOT_TOKEN` + `SLACK_CHANNEL` on Netlify site env.
- Scheduler: GCP Cloud Scheduler → HTTP GET to `https://<site>/.netlify/functions/monitor` every 5 minutes (UTC).
- Local monitor: OFF by default; set `ENABLE_LOCAL_MONITOR=1` to enable.

Troubleshooting
---------------
- No Slack messages: verify `GET /api/notify/enabled` is true; test with `/api/notify/slack` (POST) and ensure bot invited to channel.
- Repeats: ensure only one scheduler is active (Netlify schedule disabled; use GCP). Check `?debug=1` — confirm `startKey`, `lastNotifiedStartKey`, and `lastNotifiedResolveKey` values. Overlap guard and suppression should prevent duplicates.
- No resolves: check Jira/Sentry show operational in `?debug=1` and persisted state had `lastNotifiedStartKey`; resolution will send once and clear state.


