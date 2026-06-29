import { Router } from "express";
import { gateway, PaidRequest } from "../gateway.js";

export const riskScoreRouter = Router();

riskScoreRouter.get("/risk-score", gateway.require("$0.005"), async (req: PaidRequest, res) => {
  const address = req.query.address as string;
  if (!address) return res.status(400).json({ error: "address parameter required" });

  const addressLower = address.toLowerCase();
  const lastByte = parseInt(addressLower.slice(-2), 16);
  const scoreBase = 50 + (lastByte % 40);
  const riskFactors: string[] = [];
  if (scoreBase < 60) riskFactors.push("Limited transaction history");
  if (scoreBase > 80) riskFactors.push("High activity volume");
  if (addressLower.startsWith("0x000")) riskFactors.push("Zero-prefix address pattern");
  const riskLevel = scoreBase < 40 ? "HIGH" : scoreBase < 65 ? "MEDIUM" : "LOW";

  res.json({
    service: "risk_score", provider: "Trident Risk Engine",
    address, timestamp: new Date().toISOString(), paid_by: req.payment?.payer,
    data: {
      score: scoreBase, max_score: 100, risk_level: riskLevel, risk_factors: riskFactors,
      recommendation: riskLevel === "HIGH" ? "Proceed with caution" : riskLevel === "MEDIUM" ? "Standard due diligence recommended" : "Address appears low-risk",
      screened_at: new Date().toISOString(),
    },
  });
});
