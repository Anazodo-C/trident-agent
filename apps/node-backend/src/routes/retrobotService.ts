import { Router } from "express";
import { gateway, PaidRequest } from "../gateway.js";
import axios from "axios";

export const retrobotServiceRouter = Router();

const PYTHON_BACKEND = process.env.PYTHON_API_URL || "http://localhost:8000";

retrobotServiceRouter.post("/audit", gateway.require("$0.005"), async (req: PaidRequest, res) => {
  const { wallet_address, lookback_hours = 24 } = req.body;
  if (!wallet_address) return res.status(400).json({ error: "wallet_address required" });
  try {
    const { data } = await axios.post(`${PYTHON_BACKEND}/api/retrobot/audit`, { wallet_address, lookback_hours });
    res.json({ ...data, service: "retrobot_audit", paid_by: req.payment?.payer, retrobot_version: "1.0.0" });
  } catch { res.status(500).json({ error: "Retrobot audit failed" }); }
});

retrobotServiceRouter.post("/scan", gateway.require("$0.001"), async (req: PaidRequest, res) => {
  const { payment_id, buyer_address, seller_address, amount, service_type, job_hash } = req.body;
  try {
    const { data } = await axios.post(`${PYTHON_BACKEND}/api/retrobot/scan`, { payment_id, buyer_address, seller_address, amount, service_type, job_hash });
    res.json({ ...data, service: "retrobot_scan", paid_by: req.payment?.payer });
  } catch { res.status(500).json({ error: "Retrobot scan failed" }); }
});

retrobotServiceRouter.post("/recover", gateway.require("$0.010"), async (req: PaidRequest, res) => {
  const { payment_id, requester_address } = req.body;
  try {
    const { data } = await axios.post(`${PYTHON_BACKEND}/api/retrobot/recover`, { payment_id, requester_address });
    res.json({ ...data, service: "retrobot_recover", paid_by: req.payment?.payer });
  } catch { res.status(500).json({ error: "Retrobot recovery failed" }); }
});
