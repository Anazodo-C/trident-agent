#!/bin/bash
# Seeds demo agents and services into the running local backend
# Run from project root: bash seed.sh

API="http://localhost:8000"
NODE="http://localhost:3001"

echo "🌱 Seeding Trident demo data..."

# Register agents
echo "📋 Registering agents..."
curl -s -X POST "$API/api/agents/register" -H "Content-Type: application/json" -d '{"wallet_address":"0xabc1000000000000000000000000000000000001","name":"AlphaBot","description":"High-frequency data seller on Arc Testnet","agent_type":"seller","service_types":["price_feed","fx_rates","compute_score"]}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✅ AlphaBot:', d.get('status','error'))" 2>/dev/null

curl -s -X POST "$API/api/agents/register" -H "Content-Type: application/json" -d '{"wallet_address":"0xabc2000000000000000000000000000000000002","name":"DataMaven","description":"AI-powered research and risk scoring agent","agent_type":"seller","service_types":["risk_score","research_summary"]}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✅ DataMaven:', d.get('status','error'))" 2>/dev/null

curl -s -X POST "$API/api/agents/register" -H "Content-Type: application/json" -d '{"wallet_address":"0xabc3000000000000000000000000000000000003","name":"RetroSweep","description":"Autonomous payment anomaly detection and recovery","agent_type":"retrobot"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✅ RetroSweep:', d.get('status','error'))" 2>/dev/null

curl -s -X POST "$API/api/agents/register" -H "Content-Type: application/json" -d '{"wallet_address":"0xabc4000000000000000000000000000000000004","name":"BuyerX","description":"AI buyer agent consuming financial intelligence","agent_type":"buyer"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✅ BuyerX:', d.get('status','error'))" 2>/dev/null

# Register services
echo "🛒 Registering services..."
curl -s -X POST "$API/api/marketplace/services/register?wallet_address=0xabc1000000000000000000000000000000000001" -H "Content-Type: application/json" -d '{"service_type":"price_feed","name":"Live Crypto Price Feed","description":"Real-time BTC/ETH/SOL prices via CoinGecko","price_per_call":1000,"endpoint":"'"$NODE"'/data/price-feed"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✅ Price Feed:', d.get('service_id','error'))" 2>/dev/null

curl -s -X POST "$API/api/marketplace/services/register?wallet_address=0xabc1000000000000000000000000000000000001" -H "Content-Type: application/json" -d '{"service_type":"fx_rates","name":"FX Rates (Emerging Markets)","description":"USD/NGN, USD/GHS, USD/KES and 10+ currency pairs","price_per_call":1000,"endpoint":"'"$NODE"'/data/fx-rates"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✅ FX Rates:', d.get('service_id','error'))" 2>/dev/null

curl -s -X POST "$API/api/marketplace/services/register?wallet_address=0xabc2000000000000000000000000000000000002" -H "Content-Type: application/json" -d '{"service_type":"risk_score","name":"Wallet Risk Score","description":"On-chain risk assessment for any EVM address","price_per_call":5000,"endpoint":"'"$NODE"'/data/risk-score"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✅ Risk Score:', d.get('service_id','error'))" 2>/dev/null

curl -s -X POST "$API/api/marketplace/services/register?wallet_address=0xabc2000000000000000000000000000000000002" -H "Content-Type: application/json" -d '{"service_type":"research_summary","name":"AI Research Summary","description":"Claude-powered financial research on any crypto asset","price_per_call":10000,"endpoint":"'"$NODE"'/data/research-summary"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✅ Research Summary:', d.get('service_id','error'))" 2>/dev/null

curl -s -X POST "$API/api/marketplace/services/register?wallet_address=0xabc1000000000000000000000000000000000001" -H "Content-Type: application/json" -d '{"service_type":"compute_score","name":"Portfolio Compute Score","description":"Sharpe ratio, VaR, and risk-adjusted portfolio scoring","price_per_call":20000,"endpoint":"'"$NODE"'/data/compute-score"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print('  ✅ Compute Score:', d.get('service_id','error'))" 2>/dev/null

echo ""
echo "✅ Done! Refresh http://localhost:5173 to see live data."
