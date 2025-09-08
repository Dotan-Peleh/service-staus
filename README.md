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

Backend monitoring
------------------
- Netlify scheduled function (`netlify/functions/monitor.js`) runs every 5 minutes and polls all services above.
- Slack notifications:
  - One message when a service enters incident (severity emoji + title + startedAt + status link).
  - One message when that incident resolves (“back to normal” + startedAt + resolved time + status link).
  - Deduped per service using a stable service key; the monitor stores `startedAt` and (when available) `incidentId` inside persisted state to avoid repeats even if incident IDs change or disappear.
  - Persistence uses Netlify Blobs (store: `status-notify`) so state survives function cold starts.
- A cooldown guard prevents accidental repeats if persistence is temporarily unavailable.
- Page visits do not send Slack messages; only the backend monitor posts.

Monitor diagnostics
-------------------
- Manually trigger a run:
  - `https://<site>/.netlify/functions/monitor` (alias: `https://<site>/api/monitor`)
- Send a Slack test message (no status check):
  - `https://<site>/.netlify/functions/monitor?test=1`
- Inspect current vs persisted state to troubleshoot notifications:
  - `https://<site>/.netlify/functions/monitor?debug=1`

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


