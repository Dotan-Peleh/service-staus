#!/bin/bash
# Setup script for local webhook testing with ngrok

set -e

echo "═══════════════════════════════════════════════════════════"
echo "🚀 Setting up webhook for Apple Developer monitoring"
echo "═══════════════════════════════════════════════════════════"

# Check if server is running
if ! lsof -nP -iTCP:5173 -sTCP:LISTEN > /dev/null 2>&1; then
    echo "⚠️  Server not running on port 5173"
    echo "Starting server..."
    node server.js > server.log 2>&1 &
    sleep 2
    echo "✅ Server started"
fi

# Check if ngrok is running
if pgrep -f "ngrok http" > /dev/null; then
    echo "⚠️  ngrok already running, killing old instance..."
    pkill -f "ngrok http"
    sleep 1
fi

# Start ngrok
echo ""
echo "🌐 Starting ngrok tunnel..."
ngrok http 5173 > /dev/null &
sleep 3

# Get ngrok URL
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o 'https://[^"]*\.ngrok-free\.app' | head -1)

if [ -z "$NGROK_URL" ]; then
    echo "❌ Failed to get ngrok URL"
    echo "Check if ngrok is properly configured"
    exit 1
fi

echo "✅ ngrok tunnel active!"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "📋 YOUR WEBHOOK URL:"
echo "═══════════════════════════════════════════════════════════"
WEBHOOK_URL="${NGROK_URL}/api/webhooks/statusgator?key=https%3A%2F%2Fdeveloper.apple.com%2Fsystem-status%2F"
echo ""
echo "${WEBHOOK_URL}"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "📝 NEXT STEPS:"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "1. Go to StatusGator: https://statusgator.com/"
echo "2. Sign up (free trial, no credit card)"
echo "3. Add service: https://developer.apple.com/system-status/"
echo "4. Add webhook (copy URL above)"
echo "5. Test webhook in StatusGator"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "🧪 TEST YOUR WEBHOOK:"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Run this command to test:"
echo ""
echo "curl -X POST '${WEBHOOK_URL}' \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -d '{\"status\":\"major_outage\",\"title\":\"App Store - In-App Purchases\",\"current_status\":\"down\"}'"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "📊 MONITOR LOGS:"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Server logs:  tail -f server.log"
echo "ngrok web UI: http://localhost:4040"
echo ""
echo "Keep this terminal open. Press Ctrl+C to stop."
echo ""

# Keep script running and show logs
tail -f server.log

