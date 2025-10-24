# ✅ Complete Integration: StatusGator → Firebase → Slack

## 🎯 How Your System Works Now

### Flow Diagram:
```
StatusGator (monitors Apple)
    ↓ detects incident
    ↓ sends webhook
Your Netlify Function (/api/webhooks/statusgator)
    ↓ receives incident data
    ├─→ Stores in Firebase/Firestore (via monitor.js persistence)
    ├─→ Sends Slack notification IMMEDIATELY ✅
    └─→ Updates dashboard state
```

### What Happens When Apple Has an Incident:

1. **StatusGator detects** "App Store - In-App Purchases - Outage" (every 1-5 min)
2. **Sends webhook** to your endpoint with incident data
3. **Your webhook handler**:
   - ✅ Stores incident in Firebase/Firestore (if configured)
   - ✅ Sends Slack notification immediately
   - ✅ Format: `🔴 Apple Developer Services: App Store - In-App Purchases - Outage`
4. **Your dashboard** shows the incident
5. **When resolved**, StatusGator sends another webhook:
   - ✅ Sends resolution to Slack: `✅ Apple Developer Services back to normal`

## ✅ What's Integrated

### Firebase/Firestore Persistence:
Your monitor.js already has Firebase integration:
- Uses `GCP_PROJECT_ID`, `GCP_SA_JSON` (or `GCP_SA_JSON_BASE64`)
- Stores in Firestore collection: `kv_status_notify`
- Fallback: Netlify Blobs → in-memory
- All webhook state is persisted across function invocations

### Slack Notifications:
Webhooks now send Slack alerts directly:
- ✅ Incident start → Slack alert
- ✅ Incident resolution → Slack alert
- Uses `SLACK_WEBHOOK_URL` or `SLACK_BOT_TOKEN` + `SLACK_CHANNEL`
- Works on both local server and Netlify

### Monitor Integration:
Your existing monitor.js runs every 5 minutes:
- Checks all services (Firebase, Google Play, etc.)
- Uses same Firebase/Firestore for persistence
- Sends Slack notifications for those services
- **Plus** StatusGator webhook for Apple Developer services

## 🔧 Environment Variables

### For Netlify Production:
Set these in **Netlify → Site settings → Environment variables**:

```bash
# Slack (choose one method):
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# OR use bot token:
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_CHANNEL=#status-alerts

# Firebase/Firestore (optional, for persistence):
GCP_PROJECT_ID=your-project-id
GCP_SA_JSON_BASE64=base64-encoded-service-account-json

# Monitor cooldown (optional):
NOTIFY_COOLDOWN_MINUTES=180
RESET_UNKNOWN_MINUTES=60
```

### For Local Testing:
```bash
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
node server.js
```

## 📊 Complete Service Coverage

### Via Direct API Polling (monitor.js):
- ✅ Firebase (Crashlytics, Auth, Remote Config)
- ✅ Google Play Store
- ✅ Google Play Services
- ✅ Google Cloud/AdMob
- ✅ Mixpanel
- ✅ Singular
- ✅ Sentry
- ✅ Facebook Audience Network
- ✅ Realm Database
- ✅ Slack
- ✅ Notion
- ✅ Figma
- ✅ Jira Software

### Via StatusGator Webhook:
- ✅ Apple Developer Services (In-App Purchases, APNS, App Store Connect, etc.)

## 🧪 Testing the Complete Flow

### Test 1: Webhook Receives Incident
```bash
curl -X POST 'http://localhost:5173/api/webhooks/statusgator?key=https://developer.apple.com/system-status/' \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "major_outage",
    "title": "App Store - In-App Purchases - Outage",
    "summary": "Users experiencing issues",
    "current_status": "down"
  }'
```

**Expected:**
- ✅ HTTP 204 response
- ✅ Slack message: `🔴 Apple Developer Services: App Store - In-App Purchases - Outage`
- ✅ Stored in Firebase/Firestore (if configured)
- ✅ Visible in dashboard

### Test 2: Webhook Receives Resolution
```bash
curl -X POST 'http://localhost:5173/api/webhooks/statusgator?key=https://developer.apple.com/system-status/' \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "operational",
    "title": "All Services Operational",
    "current_status": "up"
  }'
```

**Expected:**
- ✅ HTTP 204 response
- ✅ Slack message: `✅ Apple Developer Services back to normal — App Store - In-App Purchases - Outage`
- ✅ State updated in Firebase/Firestore
- ✅ Dashboard shows operational

### Test 3: Other Services (Firebase, etc.)
Your existing monitor works as before:
```bash
# Manually trigger monitor check:
curl "https://YOUR-SITE.netlify.app/.netlify/functions/monitor?force=1"
```

**Expected:**
- ✅ Checks all services
- ✅ Sends Slack for any incidents
- ✅ Uses Firebase/Firestore for state persistence

## 🚀 Deployment Checklist

### Already Done ✅:
- ✅ Code pushed to GitHub
- ✅ Webhook handler with Slack integration
- ✅ Firebase/Firestore compatible
- ✅ Monitor integration ready
- ✅ Local testing setup (ngrok)

### Do Now:

1. **Deploy to Netlify**:
   - Go to https://app.netlify.com/
   - Import from GitHub: `Dotan-Peleh/service-staus`
   - Deploy

2. **Set Environment Variables** (Netlify dashboard):
   ```
   SLACK_WEBHOOK_URL = https://hooks.slack.com/services/YOUR/WEBHOOK/URL
   ```

3. **Set up StatusGator**:
   - Sign up: https://statusgator.com/
   - Add service: `https://developer.apple.com/system-status/`
   - Add webhook: `https://YOUR-SITE.netlify.app/.netlify/functions/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F`
   - Test webhook

4. **Verify**:
   - StatusGator sends test → You get Slack notification
   - Current Apple incident detected within 5 minutes
   - All other services monitored by your existing monitor

## 📝 How It All Works Together

### Regular Services (Firebase, Google, etc.):
```
Monitor Function (runs every 5 min)
  → Polls /api/firebase/status, /api/google/play-status, etc.
  → Detects incidents
  → Stores state in Firestore
  → Sends Slack notification
```

### Apple Developer Services:
```
StatusGator (monitors JS-rendered page)
  → Detects "In-App Purchases - Outage"
  → Sends webhook to your endpoint
  → Your webhook handler:
      • Stores in local state (Netlify) or Firebase (monitor integration)
      • Sends Slack notification IMMEDIATELY
  → Dashboard updates
```

## 🎉 What You Get

**Complete monitoring** for all your services:
- ✅ Firebase incidents → Slack alert
- ✅ Google Play incidents → Slack alert
- ✅ Apple Developer incidents → Slack alert (via StatusGator)
- ✅ All other services → Slack alert
- ✅ Resolution notifications for all
- ✅ Firebase/Firestore persistence
- ✅ Single dashboard for everything

## 🔔 Slack Message Examples

**Incident:**
```
🔴 Apple Developer Services: App Store - In-App Purchases - Outage
Started: 10/24/2025, 9:00:00 PM
Users are experiencing issues with in-app purchases
Status: https://developer.apple.com/system-status/
```

**Resolution:**
```
✅ Apple Developer Services back to normal — App Store - In-App Purchases - Outage
Resolved: 10/24/2025, 9:30:00 PM
Status: https://developer.apple.com/system-status/
```

## Support

- Webhook setup: `STATUSGATOR_SETUP.md`
- Deployment: `DEPLOY_NOW.md`
- Testing: `test-webhook.sh`
- Your webhook URL: `WEBHOOK_URL.txt`

## Ready to Deploy! 🚀

Your system is complete and pushed to GitHub. Just deploy to Netlify, set SLACK_WEBHOOK_URL, and connect StatusGator!

