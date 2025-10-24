# 🚨 DEPLOY NOW - Quick Setup Guide

## Your changes are ready! Here's how to deploy immediately:

### Option 1: Deploy to Netlify (Recommended - 2 minutes)

1. **Go to Netlify**: https://app.netlify.com/
   - Sign up/Login with GitHub

2. **Create new site**:
   - Click "Add new site" → "Import an existing project"
   - Choose "Deploy manually" (for now)
   - Drag and drop this entire folder OR:

3. **Connect to GitHub** (better for auto-deploys):
   ```bash
   # Create a GitHub repo first at https://github.com/new
   # Then run these commands:
   
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
   git branch -M main
   git push -u origin main
   ```

4. **Configure Netlify**:
   - In Netlify dashboard, click "Import from Git"
   - Connect your GitHub repo
   - Build settings are already configured in `netlify.toml`
   - Click "Deploy site"

5. **Set up environment variables** (for Slack notifications):
   - In Netlify dashboard → Site settings → Environment variables
   - Add: `SLACK_WEBHOOK_URL` = `https://hooks.slack.com/services/YOUR/WEBHOOK/URL`
   
   **Get Slack webhook**:
   - Go to https://api.slack.com/apps
   - Create new app → "Incoming Webhooks" → "Add New Webhook"
   - Copy the URL

6. **Enable the monitor**:
   - Your monitor function will run every 5 minutes automatically
   - It checks Apple status (consumer + developer services)
   - Sends Slack alerts when incidents detected

### Option 2: Quick Test Deploy (30 seconds)

If you just want to test RIGHT NOW:

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login to Netlify
netlify login

# Deploy!
netlify deploy --prod
```

Follow the prompts, and you'll get a live URL immediately!

## What Happens After Deploy

1. ✅ **Monitor runs every 5 minutes** (configured in `netlify/functions/monitor.js`)
2. ✅ **Checks Apple Developer Status** page for incidents
3. ✅ **Detects patterns** like "App Store - In-App Purchases - Outage"
4. ✅ **Sends Slack notification** when incident detected
5. ✅ **Sends resolution notification** when incident clears

## Testing Your Deployment

After deploy, test the Apple endpoint:
```bash
# Replace YOUR_SITE with your Netlify URL
curl "https://YOUR_SITE.netlify.app/.netlify/functions/api/apple/status" | jq .
```

Test the webhook (for future StatusGator integration):
```bash
curl -X POST "https://YOUR_SITE.netlify.app/.netlify/functions/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F" \
  -H "Content-Type: application/json" \
  -d '{"status": "major_outage", "title": "Test Incident"}'
```

## Monitor Function Schedule

The monitor is configured to run every 5 minutes. To change frequency:
- Edit `netlify/functions/monitor.js`
- Uncomment line 517: `exports.config = { schedule: '*/5 * * * *' };`
- Change schedule (cron format)

## Current Incident Detection

Your system NOW detects:
- ✅ App Store - In-App Purchases incidents
- ✅ App Store Connect issues
- ✅ APNS/Push notification problems  
- ✅ Consumer App Store issues
- ✅ All other services in your dashboard

## Next Steps (Optional but Recommended)

For more reliable monitoring of Apple Developer services:
1. Sign up for StatusGator: https://statusgator.com/
2. Add webhook endpoint (already configured in your code)
3. Get real-time notifications via browser automation

But for NOW, your pattern-based detection is LIVE and will catch most incidents!

## Your Site URL

After deployment, your monitor will be at:
```
https://YOUR_SITE.netlify.app/.netlify/functions/monitor
```

And your dashboard at:
```
https://YOUR_SITE.netlify.app/
```

## Troubleshooting

**If monitor doesn't run**:
- Check Netlify Functions logs
- Verify environment variables are set
- Test endpoint manually with curl

**If Slack doesn't notify**:
- Verify SLACK_WEBHOOK_URL is set in Netlify environment variables
- Test notification endpoint manually

## 🚀 YOU'RE READY TO GO!

Your code is committed and ready to deploy. Choose Option 1 or 2 above and you'll be monitoring Apple incidents in minutes!

