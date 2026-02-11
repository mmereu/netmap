#!/bin/bash
# Deploy AI Agents to production server
# Run: bash deploy-agents.sh

SERVER="${DEPLOY_HOST:-localhost}"
REMOTE_PATH="${DEPLOY_PATH:-/var/netmap}"
LOCAL_PATH="${LOCAL_NETMAP_PATH:-.}"

echo "🚀 Deploy NetMap AI Agents to $SERVER"
echo "========================================"

# 1. Sync agents directory
echo ""
echo "📦 Syncing agents/..."
scp -r "$LOCAL_PATH/agents" ${DEPLOY_USER:-admin}@$SERVER:$REMOTE_PATH/

# 2. Sync routes
echo ""
echo "📦 Syncing routes/agentRoutes.js..."
scp "$LOCAL_PATH/routes/agentRoutes.js" ${DEPLOY_USER:-admin}@$SERVER:$REMOTE_PATH/routes/

# 3. Sync server.js
echo ""
echo "📦 Syncing server.js..."
scp "$LOCAL_PATH/server.js" ${DEPLOY_USER:-admin}@$SERVER:$REMOTE_PATH/

# 4. Sync mac-tracker.html
echo ""
echo "📦 Syncing public/mac-tracker.html..."
scp "$LOCAL_PATH/public/mac-tracker.html" ${DEPLOY_USER:-admin}@$SERVER:$REMOTE_PATH/public/

# 5. Install dependencies on server
echo ""
echo "📦 Installing dependencies..."
ssh ${DEPLOY_USER:-admin}@$SERVER "cd $REMOTE_PATH && npm install @openai/agents openai zod@3"

# 6. Configure GROQ_API_KEY
echo ""
echo "🔑 Configuring GROQ_API_KEY..."
ssh ${DEPLOY_USER:-admin}@$SERVER "sudo grep -q GROQ_API_KEY /etc/systemd/system/netmap.service || echo 'WARNING: Set GROQ_API_KEY in /etc/systemd/system/netmap.service manually'"

# 7. Reload and restart
echo ""
echo "🔄 Restarting netmap service..."
ssh ${DEPLOY_USER:-admin}@$SERVER "sudo systemctl daemon-reload && sudo systemctl restart netmap"

# 8. Check status
echo ""
echo "✅ Checking status..."
ssh ${DEPLOY_USER:-admin}@$SERVER "sudo systemctl status netmap --no-pager | head -15"

echo ""
echo "========================================"
echo "🎉 Deploy complete!"
echo "Test: http://$SERVER:4000/mac-tracker.html"
echo "API:  http://$SERVER:4000/api/agent/status"
