import { Router } from "express";
import { gateway, PaidRequest } from "../server.js";

export const computeRouter = Router();

computeRouter.get("/compute-score", gateway.require("$0.020"), async (req: PaidRequest, res) => {
  const portfolioStr = req.query.portfolio as string;
  const model = ((req.query.model as string) || "sharpe").toLowerCase();

  if (!portfolioStr) {
    return res.status(400).json({ error: "portfolio parameter required", example: "?portfolio=BTC:0.4,ETH:0.3,USDC:0.3&model=sharpe" });
  }

  try {
    const holdings = portfolioStr.split(",").map((h) => {
      const [asset, weight] = h.split(":");
      return { asset: asset.trim().toUpperCase(), weight: parseFloat(weight) };
    });
    const totalWeight = holdings.reduce((s, h) => s + h.weight, 0);

    const assetParams: Record<string, { return: number; vol: number }> = {
      BTC: { return: 0.65, vol: 0.82 }, ETH: { return: 0.58, vol: 0.88 },
      SOL: { return: 0.72, vol: 1.1 }, USDC: { return: 0.05, vol: 0.001 },
      ARB: { return: 0.45, vol: 1.2 }, DEFAULT: { return: 0.3, vol: 0.7 },
    };

    const portfolioReturn = holdings.reduce((sum, h) => {
      const params = assetParams[h.asset] || assetParams.DEFAULT;
      return sum + (h.weight / totalWeight) * params.return;
    }, 0);

    const portfolioVol = Math.sqrt(
      holdings.reduce((sum, h) => {
        const params = assetParams[h.asset] || assetParams.DEFAULT;
        return sum + Math.pow((h.weight / totalWeight) * params.vol, 2);
      }, 0)
    );

    const sharpe = (portfolioReturn - 0.05) / portfolioVol;
    const var95 = portfolioVol * 1.645;

    res.json({
      service: "compute_score", provider: "Trident Quant Engine",
      model, timestamp: new Date().toISOString(), paid_by: req.payment?.payer,
      data: {
        portfolio: holdings,
        metrics: {
          expected_annual_return: `${(portfolioReturn * 100).toFixed(1)}%`,
          annual_volatility: `${(portfolioVol * 100).toFixed(1)}%`,
          sharpe_ratio: sharpe.toFixed(3),
          var_95: `${(var95 * 100).toFixed(1)}%`,
          risk_adjusted_rating: sharpe > 1.5 ? "Excellent" : sharpe > 1 ? "Good" : sharpe > 0.5 ? "Fair" : "Poor",
        },
        disclaimer: "Illustrative model. Not financial advice.",
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to compute portfolio score" });
  }
});
