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


