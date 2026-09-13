import { useState } from "react";
import { parseUnits } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";
import { mockMarketStateProviderAbi } from "../abis/index.js";
import type { MarketAddresses } from "../config/markets";

const REFERENCE_PRICE = parseUnits("4000", 18);

/**
 * Demo-only control: `MockMarketStateProvider.setVolatility` has no access control on this
 * deployment, so any connected wallet can drive market conditions and watch NORMAL -> DEFENSIVE ->
 * RECOVERY happen live. Never wire this pattern into a real deployment.
 *
 * Scoped to the market passed in, and - deliberately - to its **Aqua maker's** oracle only.
 *
 * Each venue has its own independent market-state provider on-chain, so both *could* be moved at
 * once. Doing so made a worse demonstration and a less realistic one. Driving both simultaneously
 * collapses the whole market's depth together, so a trade that was routable becomes unroutable and
 * the thing a viewer sees is an error state. Moving one maker shows what the product is actually
 * for: that maker's strategy pulls its liquidity back, the pool's does not, and the Solver
 * reallocates the order between them. A single maker reacting to risk while a pool sits unchanged
 * is also simply what happens in a real market.
 *
 * The UI names the target for exactly this reason - the button says which source it moves.
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
      const hash = await writeContractAsync({
        address: market.aquaOracle,
        abi: mockMarketStateProviderAbi,
        functionName: "setVolatility",
        args: [market.aquaStrategyId, BigInt(volatilityBps), REFERENCE_PRICE],
      });
      await publicClient?.waitForTransactionReceipt({ hash });
    } catch {
      setError("Couldn't update market conditions - please try again.");
    } finally {
      setIsSetting(false);
    }
  }

  return {
    calm: () => setVolatility(2000), // 20% - below the recovery threshold
    shock: () => setVolatility(6500), // 65% - above the defensive threshold
    recover: () => setVolatility(2400), // 24% - arms the recovery timer, matches StrategyFixtures
    isSetting,
    error,
  };
}
