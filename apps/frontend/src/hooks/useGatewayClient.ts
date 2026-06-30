import { GatewayClient } from "@circle-fin/x402-batching/client";
import { useWalletClient, useAccount } from "wagmi";
import { useState, useCallback } from "react";

export function useGatewayClient() {
  const { data: _walletClient } = useWalletClient();
  const { address } = useAccount();
  const [balances, setBalances] = useState<{
    gateway: { formattedAvailable: string; available: bigint };
    wallet: { formatted: string };
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getClient = useCallback((privateKey: `0x${string}`) => {
    return new GatewayClient({ chain: "arcTestnet", privateKey });
  }, []);

  const fetchBalances = useCallback(async (privateKey: `0x${string}`) => {
    setLoading(true);
    setError(null);
    try {
      const client = getClient(privateKey);
      const bal = await client.getBalances();
      setBalances(bal as any);
      return bal;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [getClient]);

  const deposit = useCallback(async (privateKey: `0x${string}`, amountUsdc: string) => {
    setLoading(true);
    setError(null);
    try {
      const client = getClient(privateKey);
      const result = await client.deposit(amountUsdc);
      await fetchBalances(privateKey);
      return result;
    } catch (e: any) {
      setError(e.message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [getClient, fetchBalances]);

  const pay = useCallback(async (privateKey: `0x${string}`, url: string) => {
    setLoading(true);
    setError(null);
    try {
      const client = getClient(privateKey);
      const support = await client.supports(url);
      if (!support.supported) throw new Error("Endpoint does not support Gateway payments");
      return await client.pay(url);
    } catch (e: any) {
      setError(e.message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [getClient]);

  const withdraw = useCallback(async (privateKey: `0x${string}`, amountUsdc: string) => {
    const client = getClient(privateKey);
    return client.withdraw(amountUsdc);
  }, [getClient]);

  return { address, balances, loading, error, fetchBalances, deposit, pay, withdraw };
}
