import { Router } from "express";
import { gateway, PaidRequest } from "../server.js";
import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";

export const researchRouter = Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

researchRouter.get("/research-summary", gateway.require("$0.010"), async (req: PaidRequest, res) => {
  const asset = ((req.query.asset as string) || "BTC").toUpperCase();

  try {
    let priceContext = "";
    try {
      const priceIds: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", USDC: "usd-coin", ARB: "arbitrum" };
      const id = priceIds[asset] || asset.toLowerCase();
      const { data } = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
        params: { ids: id, vs_currencies: "usd", include_24hr_change: true },
      });
      if (data[id]) {
        priceContext = `Current price: $${data[id].usd} USD (24h change: ${data[id].usd_24h_change?.toFixed(2)}%)`;
      }
    } catch { priceContext = "Live price data temporarily unavailable"; }

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `You are a concise financial analyst. Generate a brief research summary for ${asset}.
${priceContext}

Provide:
1. One-line market overview
2. Key opportunity (2 sentences max)
3. Key risk (2 sentences max)
4. Outlook: Bullish/Neutral/Bearish with one reason

Keep total response under 150 words. Be direct and data-driven.`,
      }],
    });

    const summary = message.content[0].type === "text" ? message.content[0].text : "";
    res.json({
      service: "research_summary", provider: "Trident / Claude",
      asset, timestamp: new Date().toISOString(), paid_by: req.payment?.payer,
      data: { summary, price_context: priceContext, generated_by: "claude-sonnet-4-6", disclaimer: "AI-generated. Not financial advice." },
    });
  } catch {
    res.status(500).json({ error: "Failed to generate research summary" });
  }
});
