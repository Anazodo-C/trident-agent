import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import "dotenv/config";

export type PaidRequest = express.Request & {
  payment?: {
    verified: boolean;
    payer: string;
    amount: string;
    network: string;
    transaction?: string;
  };
};

const SELLER_ADDRESS = (
  process.env.SELLER_ADDRESS || "0x3315ebaab06d6266e92f6063b9360ae10d24F0a0"
) as `0x${string}`;

const FACILITATOR_URL =
  process.env.GATEWAY_FACILITATOR_URL || "https://gateway-api-testnet.circle.com";

export const gateway = createGatewayMiddleware({
  sellerAddress: SELLER_ADDRESS,
  facilitatorUrl: FACILITATOR_URL,
  networks: ["eip155:5042002"],
});

export { SELLER_ADDRESS, FACILITATOR_URL };
