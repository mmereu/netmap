#!/bin/bash
# UNICO MODO per avviare NetMap - usa sempre systemctl

echo "⚠️  Non lanciare 'node server.js' manualmente!"
echo "   Usa sempre: sudo systemctl restart netmap"
echo ""
echo "Eseguo systemctl restart netmap..."
sudo systemctl restart netmap
sleep 2
sudo systemctl status netmap --no-pager | head -10
