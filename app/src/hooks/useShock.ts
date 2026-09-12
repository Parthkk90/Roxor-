import { useState } from "react";
import { type Address, parseUnits } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";
import { mockMarketStateProviderAbi } from "../abis/index.js";
import { addresses } from "../config/contracts";

const REFERENCE_PRICE = parseUnits("4000", 18);

/**
 * Demo-only control: `MockMarketStateProvider.setVolatility` has no access control on this
 * deployment, so any connected wallet can drive both strategies' volatility to watch
 * NORMAL -> DEFENSIVE -> RECOVERY happen live. Never wire this pattern into a real deployment.
 */
export function useShock() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [isSetting, setIsSetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setVolatility(volatilityBps: number) {
    setIsSetting(true);
    setError(null);
    try {
      for (const [oracle, strategyId] of [
        [addresses.aquaOracle, addresses.aquaStrategyId],
        [addresses.uniOracle, addresses.uniStrategyId],
      ] as const) {
        const hash = await writeContractAsync({
          address: oracle as Address,
          abi: mockMarketStateProviderAbi,
          functionName: "setVolatility",
          args: [strategyId as `0x${string}`, BigInt(volatilityBps), REFERENCE_PRICE],
        });
        await publicClient?.waitForTransactionReceipt({ hash });
      }
    } catch {
      setError("Couldn't update market conditions — please try again.");
    } finally {
      setIsSetting(false);
    }
  }

  return {
    calm: () => setVolatility(2000), // 20% - NORMAL
    shock: () => setVolatility(6500), // 65% - DEFENSIVE
    recover: () => setVolatility(2400), // 24% - arms the recovery timer, matches StrategyFixtures
    isSetting,
    error,
  };
}
