#!/bin/bash
# Trident Agent — local development launcher
# Run from the project root: bash dev.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env
if [ -f "$SCRIPT_DIR/.env" ]; then
  export $(grep -v '^#' "$SCRIPT_DIR/.env" | xargs)
  echo "✅ .env loaded"
else
  echo "⚠️  No .env found — copy .env.example and fill in your keys"
  exit 1
fi

echo ""
echo "🔱 Starting Trident Agent development servers..."
echo ""

# Python backend
echo "🐍 Starting Python backend on port 8000..."
cd "$SCRIPT_DIR/apps/backend"
pip install -r requirements.txt -q
uvicorn main:app --reload --port 8000 &
PYTHON_PID=$!

sleep 2

# Node backend
echo "⚡ Starting Node backend on port 3001..."
cd "$SCRIPT_DIR/apps/node-backend"
npm install -q
npm run dev &
NODE_PID=$!

sleep 2

# Frontend
echo "🌐 Starting frontend on port 5173..."
cd "$SCRIPT_DIR/apps/frontend"
npm install -q
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✅ All services running:"
echo "   Frontend:        http://localhost:5173"
echo "   Python API:      http://localhost:8000/docs"
echo "   Node API:        http://localhost:3001"
echo "   Node API (llms): http://localhost:3001/llms.txt"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait and cleanup
trap "kill $PYTHON_PID $NODE_PID $FRONTEND_PID 2>/dev/null; echo '🛑 All stopped'" EXIT
wait
