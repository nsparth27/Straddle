#!/usr/bin/env bash

# Terminal Title
echo -ne "\033]0;BLOOMBERG TERMINAL - DHAN STRADDLE PRO\007"

clear
echo "==============================================================================="
echo "     🏛️  BLOOMBERG TERMINAL - DHAN STRADDLE PRO (READY TO SHIP)"
echo "==============================================================================="
echo ""

# 1. Check Node.js
echo "[*] Checking Node.js environment..."
if ! command -v node &> /dev/null; then
    echo "[!] ERROR: Node.js is NOT installed on this machine!"
    echo "    Please install Node.js LTS (>= 18.0) from https://nodejs.org/"
    exit 1
fi

NODE_VER=$(node -v)
echo "[+] Node.js detected: $NODE_VER"
echo ""

# 2. Check and install dependencies
echo "[*] Verifying package dependencies..."
if [ -f "package.json" ]; then
    npm install --no-audit --no-fund
    echo "[+] Packages verified!"
fi
echo ""

# 3. Check files
if [ ! -f "server.js" ]; then
    echo "[!] ERROR: server.js missing!"
    exit 1
fi

echo "==============================================================================="
echo " 👉 Starting Dhan Straddle Pro Server on http://localhost:3000"
echo "==============================================================================="
echo ""

# Launch browser if supported
if command -v xdg-open &> /dev/null; then
    (sleep 2 && xdg-open http://localhost:3000) &
elif command -v open &> /dev/null; then
    (sleep 2 && open http://localhost:3000) &
fi

# Run server
node server.js
