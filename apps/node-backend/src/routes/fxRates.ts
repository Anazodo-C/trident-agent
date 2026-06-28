import { Router } from "express";
import { gateway, PaidRequest } from "../server.js";
import axios from "axios";

export const fxRatesRouter = Router();

fxRatesRouter.get("/fx-rates", gateway.require("$0.001"), async (req: PaidRequest, res) => {
  const base = ((req.query.base as string) || "USD").toUpperCase();
  const targets = ((req.query.targets as string) || "EUR,GBP,NGN,JPY,BRL,GHS,KES,ZAR")
    .split(",").map((t) => t.trim().toUpperCase());

  try {
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    const ratePromises = targets.map(async (target) => {
      try {
        const { data } = await axios.get("https://www.alphavantage.co/query", {
          params: { function: "CURRENCY_EXCHANGE_RATE", from_currency: base, to_currency: target, apikey: apiKey || "demo" },
        });
        const rate = data["Realtime Currency Exchange Rate"]?.["5. Exchange Rate"];
        return { symbol: target, rate: rate ? parseFloat(rate) : null };
      } catch {
        return { symbol: target, rate: null };
      }
    });

    const rates = await Promise.all(ratePromises);
    const rateMap: Record<string, number | null> = {};
    rates.forEach(({ symbol, rate }) => { rateMap[symbol] = rate; });

    res.json({
      service: "fx_rates", provider: "Trident / Alpha Vantage",
      base_currency: base, timestamp: new Date().toISOString(),
      paid_by: req.payment?.payer,
      note: "Includes emerging market currencies: NGN, GHS, KES, ZAR, BRL",
      data: rateMap,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch FX data" });
  }
});
