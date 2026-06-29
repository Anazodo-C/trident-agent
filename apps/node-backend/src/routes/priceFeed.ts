import { Router } from "express";
import { gateway, PaidRequest } from "../gateway.js";
import axios from "axios";

export const priceFeedRouter = Router();

const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", USDC: "usd-coin",
  SOL: "solana", BNB: "binancecoin", MATIC: "matic-network",
  ARB: "arbitrum", OP: "optimism", LINK: "chainlink",
};

priceFeedRouter.get("/price-feed", gateway.require("$0.001"), async (req: PaidRequest, res) => {
  const symbols = ((req.query.symbols as string) || "BTC,ETH,USDC")
    .split(",").map((s) => s.trim().toUpperCase());
  const ids = symbols.map((s) => COINGECKO_IDS[s]).filter(Boolean).join(",");

  try {
    const apiKey = process.env.COINGECKO_API_KEY;
    const headers = apiKey ? { "x-cg-demo-api-key": apiKey } : {};
    const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
      params: { ids, vs_currencies: "usd,eur,btc", include_24hr_change: true },
      headers,
    });

    const prices: Record<string, object> = {};
    symbols.forEach((sym) => {
      const id = COINGECKO_IDS[sym];
      if (id && data[id]) {
        prices[sym] = { usd: data[id].usd, eur: data[id].eur, btc: data[id].btc, change_24h: data[id].usd_24h_change };
      }
    });

    res.json({ service: "price_feed", provider: "Trident / CoinGecko", timestamp: new Date().toISOString(), paid_by: req.payment?.payer, data: prices });
  } catch {
    res.status(500).json({ error: "Failed to fetch price data" });
  }
});
