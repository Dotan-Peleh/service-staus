# StatusGator Setup - Exact Steps

## 🎯 What You Need to Configure

StatusGator needs 2 things:
1. **The service to monitor**: Apple Developer System Status
2. **Where to send alerts**: Your webhook URL

## 📋 Step-by-Step Setup

### STEP 1: Sign Up (1 minute)

1. Go to: **https://statusgator.com/**
2. Click **"Start Free Trial"** or **"Sign Up"**
3. Create account with email
4. Confirm email
5. Login to StatusGator dashboard

**Note:** Free tier monitors up to 5 services (perfect for this!)

---

### STEP 2: Add Apple Developer Service (1 minute)

1. In StatusGator dashboard, look for **"Services"** or **"Add Service"** button
2. Click **"Add Service"** or **"Add New Service"**
3. You'll see options:
   - **Search for service** OR
   - **Add custom URL**

4. **Choose one:**

   **Option A - Search (easier):**
   - Type: `Apple Developer`
   - Select: **"Apple Developer - System Status"** if it appears
   - Click **"Add"**

   **Option B - Custom URL (if not in search):**
   - Choose **"Custom Status Page"** or **"Add Custom URL"**
   - Enter URL: `https://developer.apple.com/system-status/`
   - Name it: `Apple Developer System Status`
   - Click **"Add"**

5. ✅ Service added!

---

### STEP 3: Configure Webhook (2 minutes)

1. In StatusGator dashboard, go to:
   - **"Settings"** → **"Integrations"** → **"Webhooks"**
   - OR look for **"Notifications"** → **"Webhooks"**

2. Click **"Add Webhook"** or **"New Webhook"**

3. You'll see webhook configuration form:

#### For PRODUCTION (Netlify - use this after deploying):
```
https://YOUR-SITE-NAME.netlify.app/.netlify/functions/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F
```

**Replace `YOUR-SITE-NAME` with your actual Netlify site name!**

#### For LOCAL TESTING (ngrok - use this now):
```
https://thermochemical-flexuously-callen.ngrok-free.dev/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F
```

**This is in your `WEBHOOK_URL.txt` file!**

4. **Webhook settings:**
   - **Name**: `Apple Developer Webhook` (or anything you like)
   - **URL**: Paste URL above
   - **Method**: `POST` (should be default)
   - **Format**: `JSON` (should be default)
   - **Events**: Select `All events` or `Status changes`

5. Click **"Save"** or **"Create Webhook"**

---

### STEP 4: Test Webhook (30 seconds)

1. Find your newly created webhook in StatusGator
2. Click **"Test"** or **"Send Test"** button
3. StatusGator will send a test payload to your webhook

**What should happen:**
- ✅ Test succeeds (green checkmark or success message)
- ✅ You see the request in ngrok UI: http://localhost:4040/
- ✅ Check your server received it:
  ```bash
  curl -s http://localhost:5173/api/state | jq '."https://developer.apple.com/system-status/"'
  ```

**If test fails:**
- Check webhook URL is correct (copy from `WEBHOOK_URL.txt`)
- Make sure ngrok is running: `ps aux | grep ngrok`
- Check ngrok UI for errors: http://localhost:4040/

---

### STEP 5: Verify Monitoring is Active

1. In StatusGator dashboard, go to **"Services"**
2. Find **"Apple Developer System Status"**
3. You should see:
   - ✅ Green checkmark or "Active" status
   - ✅ Last check timestamp
   - ✅ Current status (should show current Apple incident if still active)

---

## 🔔 What Happens Next

### When Apple Has an Incident:

1. **StatusGator detects** it (checks every 1-5 minutes)
2. **Sends webhook** with incident data:
   ```json
   {
     "status": "major_outage",
     "title": "App Store - In-App Purchases",
     "current_status": "down"
   }
   ```
3. **Your webhook receives** it at `/api/webhooks/statusgator`
4. **Your system**:
   - Stores incident ✅
   - Sends Slack notification ✅
   - Updates dashboard ✅

### Slack Notification Will Say:
```
🔴 Apple Developer Services: App Store - In-App Purchases - Outage
Started: 10/24/2025, 9:00:00 PM
Users are experiencing issues with in-app purchases
Status: https://developer.apple.com/system-status/
```

### When Apple Resolves:
```
✅ Apple Developer Services back to normal — App Store - In-App Purchases - Outage
Resolved: 10/24/2025, 9:30:00 PM
Status: https://developer.apple.com/system-status/
```

---

## 📊 StatusGator Dashboard Features

Once set up, you can:
- ✅ See incident history for Apple
- ✅ Configure multiple webhooks
- ✅ Set up email notifications (optional)
- ✅ Get mobile push notifications (optional)
- ✅ View incident timeline

---

## 🔧 Troubleshooting

### "Webhook test failed"
- **Check URL**: Copy exact URL from `WEBHOOK_URL.txt`
- **Check ngrok**: Open http://localhost:4040/ - is it showing "online"?
- **Check server**: Run `curl http://localhost:5173/` - should load page

### "Service not monitoring"
- **Wait 5 minutes** - StatusGator needs time to start monitoring
- **Check service status** in StatusGator dashboard
- **Refresh** the services page

### "Not receiving notifications"
1. **Check Slack webhook** is set:
   ```bash
   curl http://localhost:5173/api/notify/enabled
   # Should return: {"enabled": true}
   ```
2. **Set SLACK_WEBHOOK_URL** if not configured:
   ```bash
   export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
   ```
3. **Restart server**:
   ```bash
   pkill -f "node server.js"
   node server.js > server.log 2>&1 &
   ```

---

## ⏱️ Timeline

- **Setup**: 5 minutes total
- **First check**: Within 1-5 minutes
- **Current incident detection**: If Apple incident is still active, you'll get notified within 5 minutes!

---

## 🚀 For Production

After testing locally, use this webhook URL in StatusGator:
```
https://YOUR-SITE.netlify.app/.netlify/functions/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F
```

Make sure to:
1. Deploy to Netlify first
2. Set `SLACK_WEBHOOK_URL` in Netlify environment variables
3. Update webhook URL in StatusGator from ngrok to production URL

---

## 📝 Quick Reference

**StatusGator Dashboard**: https://statusgator.com/dashboard (after signup)
**Apple Service URL**: `https://developer.apple.com/system-status/`
**Your Webhook URL**: See `WEBHOOK_URL.txt`
**ngrok Monitor**: http://localhost:4040/
**Your Dashboard**: http://localhost:5173/

---

## ✅ Checklist

- [ ] Sign up for StatusGator
- [ ] Add Apple Developer service
- [ ] Configure webhook (copy from WEBHOOK_URL.txt)
- [ ] Test webhook (should see success)
- [ ] Wait 5 minutes
- [ ] Check for notifications when Apple incident detected!

**That's it! Your system will now catch Apple Developer incidents automatically!**

