import { useState } from "react";
import { parseUnits } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";
import { mockMarketStateProviderAbi } from "../abis/index.js";
import type { MarketAddresses } from "../config/markets";

const REFERENCE_PRICE = parseUnits("4000", 18);

/**
 * Demo-only control: `MockMarketStateProvider.setVolatility` has no access control on this
 * deployment, so any connected wallet can drive a market's strategies' volatility to watch
 * NORMAL -> DEFENSIVE -> RECOVERY happen live. Never wire this pattern into a real deployment.
 *
 * Scoped to whichever market is passed in - each market has its own independent oracles, so
 * shocking one market never touches another's state.
 */
export function useShock(market: MarketAddresses) {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [isSetting, setIsSetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setVolatility(volatilityBps: number) {
    setIsSetting(true);
    setError(null);
    try {
      for (const [oracle, strategyId] of [
        [market.aquaOracle, market.aquaStrategyId],
        [market.uniOracle, market.uniStrategyId],
      ] as const) {
        const hash = await writeContractAsync({
          address: oracle,
          abi: mockMarketStateProviderAbi,
          functionName: "setVolatility",
          args: [strategyId, BigInt(volatilityBps), REFERENCE_PRICE],
        });
        await publicClient?.waitForTransactionReceipt({ hash });
      }
    } catch {
      setError("Couldn't update market conditions - please try again.");
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
