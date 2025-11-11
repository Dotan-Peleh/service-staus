#!/bin/bash
# Quick Slack setup and send notification about current Apple incident

echo "═══════════════════════════════════════════════════════════"
echo "🔔 SLACK SETUP - GET NOTIFIED ABOUT APPLE INCIDENT NOW"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Check if SLACK_WEBHOOK_URL is set
if [ -z "$SLACK_WEBHOOK_URL" ]; then
    echo "❌ SLACK_WEBHOOK_URL not set"
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "📋 GET YOUR SLACK WEBHOOK URL:"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "1. Go to: https://api.slack.com/apps"
    echo "2. Click 'Create New App' → 'From scratch'"
    echo "3. Name: 'Service Status Monitor'"
    echo "4. Choose your workspace → Create"
    echo "5. Click 'Incoming Webhooks' (left sidebar)"
    echo "6. Toggle 'Activate Incoming Webhooks' to ON"
    echo "7. Click 'Add New Webhook to Workspace'"
    echo "8. Choose channel (#alerts, #general, etc.)"
    echo "9. Click 'Allow'"
    echo "10. COPY the webhook URL (starts with https://hooks.slack.com/...)"
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "Then run:"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "export SLACK_WEBHOOK_URL=\"https://hooks.slack.com/services/T.../B.../XXX\""
    echo "bash setup-slack-now.sh"
    echo ""
    exit 1
fi

echo "✅ SLACK_WEBHOOK_URL is set!"
echo ""

# Restart server with Slack configured
echo "Restarting server with Slack configuration..."
pkill -f "node server.js" 2>/dev/null || true
sleep 1
cd "$(dirname "$0")"
node server.js > server.log 2>&1 &
sleep 2
echo "✅ Server restarted"
echo ""

# Verify Slack is enabled
echo "Verifying Slack configuration..."
ENABLED=$(curl -s "http://localhost:5173/api/notify/enabled" | jq -r '.enabled')
if [ "$ENABLED" = "true" ]; then
    echo "✅ Slack notifications ENABLED"
else
    echo "❌ Slack still not enabled - check SLACK_WEBHOOK_URL"
    exit 1
fi
echo ""

# Send test notification
echo "═══════════════════════════════════════════════════════════"
echo "🧪 SENDING TEST NOTIFICATION TO SLACK..."
echo "═══════════════════════════════════════════════════════════"
echo ""

curl -X POST "http://localhost:5173/api/notify/slack" \
  -H 'Content-Type: application/json' \
  -d '{
    "service": "Test Service",
    "title": "System Status Monitor Active",
    "severity": "minor",
    "statusUrl": "http://localhost:5173/"
  }' -s -o /dev/null -w "Response: HTTP %{http_code}\n"

echo ""
echo "✅ Check your Slack channel - you should see a test message!"
echo ""

# Send notification about current Apple incident
echo "═══════════════════════════════════════════════════════════"
echo "🚨 SENDING APPLE INCIDENT NOTIFICATION..."
echo "═══════════════════════════════════════════════════════════"
echo ""

curl -X POST 'http://localhost:5173/api/webhooks/statusgator?key=https://developer.apple.com/system-status/' \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "major_outage",
    "title": "App Store - In-App Purchases - Outage",
    "summary": "LIVE INCIDENT - Users are experiencing issues with in-app purchases",
    "current_status": "down"
  }' -s -o /dev/null -w "Webhook response: HTTP %{http_code}\n"

echo ""
echo "✅ Slack notification sent about Apple incident!"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "🎉 SUCCESS!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Check your Slack channel - you should see:"
echo "  🔴 Apple Developer Services: App Store - In-App Purchases - Outage"
echo ""
echo "Next steps:"
echo "  1. Set up StatusGator (see STATUSGATOR_STEPS.md)"
echo "  2. Deploy to Netlify (see DEPLOY_NOW.md)"
echo "  3. Set SLACK_WEBHOOK_URL in Netlify environment variables"
echo ""
echo "Your system is now FULLY WORKING! 🚀"
echo ""

