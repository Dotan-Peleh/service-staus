#!/bin/bash
# Test webhook with a simulated Apple incident

echo "🧪 Testing webhook with simulated Apple incident..."
echo ""

# Get ngrok URL if available
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null | grep -o 'https://[^"]*\.ngrok-free\.app' | head -1)

if [ -z "$NGROK_URL" ]; then
    echo "⚠️  ngrok not running, using localhost"
    BASE_URL="http://localhost:5173"
else
    echo "✅ Using ngrok URL: $NGROK_URL"
    BASE_URL="$NGROK_URL"
fi

WEBHOOK_URL="${BASE_URL}/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F"

echo ""
echo "Sending test incident..."
echo ""

# Send test incident
curl -X POST "$WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d '{
    "status": "major_outage",
    "title": "App Store - In-App Purchases",
    "summary": "Users are experiencing issues with in-app purchases",
    "current_status": "down",
    "url": "https://developer.apple.com/system-status/"
  }' -s -o /dev/null -w "HTTP Status: %{http_code}\n"

echo ""
echo "Checking stored state..."
echo ""

# Check state
curl -s "${BASE_URL}/api/state" | jq '."https://developer.apple.com/system-status/"'

echo ""
echo "✅ Test complete!"
echo ""
echo "To test resolution:"
echo ""
echo "curl -X POST '$WEBHOOK_URL' \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"status\":\"operational\",\"title\":\"All Services Operational\",\"current_status\":\"up\"}'"
echo ""

