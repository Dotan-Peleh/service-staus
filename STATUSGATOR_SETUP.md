# 🚨 StatusGator Setup - Required for Apple Developer Services

## Why You Need This

**Apple's Developer System Status page is 100% JavaScript-rendered.**

When we try to check https://developer.apple.com/system-status/ via HTTP:
- ❌ HTML is empty (no incident data)
- ❌ Incidents only appear after JavaScript runs in browser
- ❌ Cannot detect "App Store - In-App Purchases" outages
- ❌ Cannot detect APNS, App Store Connect, or other developer service issues

**Solution: StatusGator monitors JavaScript-rendered pages for you!**

## Quick Setup (5 minutes)

### Step 1: Sign Up for StatusGator
1. Go to: **https://statusgator.com/**
2. Click "Start Free Trial" (no credit card required)
3. Create your account

### Step 2: Add Apple Developer Status
1. In StatusGator dashboard, click **"Add Service"**
2. Search for **"Apple Developer"** or add custom URL:
   ```
   https://developer.apple.com/system-status/
   ```
3. Click **"Add Service"**

### Step 3: Configure Webhook

#### Option A: Production (Netlify)
1. In StatusGator: **Settings → Integrations → Webhooks**
2. Click **"Add Webhook"**
3. Enter your Netlify URL:
   ```
   https://YOUR-SITE.netlify.app/.netlify/functions/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F
   ```
4. Save

#### Option B: Local Testing (using ngrok)
1. Install ngrok:
   ```bash
   brew install ngrok
   ```

2. Expose your local server:
   ```bash
   ngrok http 5173
   ```

3. Use the ngrok URL as webhook:
   ```
   https://XXXX.ngrok.io/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F
   ```

### Step 4: Test It
1. In StatusGator, find your Apple Developer service
2. Click **"Test Webhook"**
3. You should receive a test notification!

## What Happens Next

Once configured:
1. ✅ StatusGator monitors Apple Developer Status (every 1-5 minutes)
2. ✅ Detects incidents like "App Store - In-App Purchases - Outage"
3. ✅ Sends webhook to your endpoint
4. ✅ Your system sends Slack notification
5. ✅ Incident appears in your dashboard
6. ✅ Resolution notification sent when incident clears

## Current Incident

**If Apple has an incident RIGHT NOW** (like the "In-App Purchases" outage you saw):
- StatusGator will detect it within 1-5 minutes of setup
- You'll receive immediate webhook notification
- Your Slack channel will get alerted
- Dashboard will show the incident

## Testing Your Webhook

Manual test of your webhook endpoint:
```bash
curl -X POST "http://localhost:5173/api/webhooks/statusgator?key=https://developer.apple.com/system-status/" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "major_outage",
    "title": "App Store - In-App Purchases",
    "summary": "Users experiencing issues",
    "current_status": "down"
  }'
```

Check if it was stored:
```bash
curl -s "http://localhost:5173/api/state" | jq '."https://developer.apple.com/system-status/"'
```

## Cost

- **Free Tier**: Monitors up to 5 services
- **Paid Plans**: Start at $9/month for unlimited services
- **Apple Developer Status counts as 1 service**

## Alternative Services

If you don't want to use StatusGator, alternatives include:
- **UptimeRobot**: https://uptimerobot.com/
- **Pingdom**: https://pingdom.com/
- **StatusCake**: https://statuscake.com/

All of these can monitor JavaScript-rendered pages and send webhooks.

## Your System is Ready!

✅ Webhook endpoint: Working  
✅ Incident detection: Working  
✅ Slack notifications: Working  
✅ Code deployed: Done  

**Only missing: StatusGator monitoring the Apple page**

Sign up now and you'll catch the current incident within minutes!

## Support

Questions? Check:
- `APPLE_DEVELOPER_MONITORING.md` - Detailed technical documentation
- `TEST_RESULTS.md` - Webhook test results
- `DEPLOY_NOW.md` - Deployment guide

## Quick Reference

**Webhook URL Format:**
```
https://YOUR-SITE/.netlify/functions/api/webhooks/statusgator?key=<URL-ENCODED-STATUS-PAGE>
```

**For Apple Developer:**
```
https://YOUR-SITE/.netlify/functions/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F
```

The `key` parameter should be the URL-encoded status page URL that StatusGator is monitoring.

