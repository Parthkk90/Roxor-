import { useState } from "react";
import type { Address } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";

import { conditionalLiquidityRegistryAbi, SWAP_VM_OPCODES } from "../abis/index.js";
import { buildAquaOrder, buildSwapProgram, strategyIdOf } from "./order";
import { compileParams, validateParams, type StrategyParams } from "./params";

/**
 * Register a conditional-liquidity strategy from the parameters a maker configured.
 *
 * Three things happen before anything is signed, in this order, and none of them is a React
 * reimplementation of protocol logic:
 *
 *  1. the parameters are compiled to rule-program bytecode by the project's own CLF backend;
 *  2. the *deployed* `StrategyValidator` is asked to validate those bytes, via `eth_call` through
 *     the registry's own validator - so the admission rules checked are the ones the chain will
 *     apply, at their deployed version;
 *  3. `registerStrategy` itself is simulated, which catches everything else the registry enforces
 *     (maker mismatch, duplicate id, token ordering, program framing) as a readable error rather
 *     than a failed transaction.
 *
 * The strategy is registered, not shipped. Registering records *how* liquidity should behave;
 * backing it with real depth is a separate `Aqua.ship` by the maker, and until they do, the
 * strategy honestly reports zero executable liquidity - which is the no-phantom-liquidity rule
 * applying to a brand-new strategy exactly as it does to an old one.
 */
export interface RegisterInputs {
  registry: Address;
  extruction: Address;
  tokenA: Address;
  tokenB: Address;
  maker: Address;
  params: StrategyParams;
}

export function previewRegistration(inputs: RegisterInputs) {
  const swapProgram = buildSwapProgram(SWAP_VM_OPCODES, inputs.extruction);
  const order = buildAquaOrder(inputs.maker, inputs.tokenA, inputs.tokenB, swapProgram);
  return { order, strategyId: strategyIdOf(order), ruleProgram: compileParams(inputs.params) };
}

export function useRegisterStrategy() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<`0x${string}` | null>(null);

  async function register(inputs: RegisterInputs): Promise<`0x${string}` | null> {
    setError(null);
    setHash(null);

    const problems = validateParams(inputs.params);
    if (problems.length > 0) {
      setError(problems[0]);
      return null;
    }
    if (!publicClient) {
      setError("No RPC connection.");
      return null;
    }

    const { order, ruleProgram } = previewRegistration(inputs);
    const args = [order, inputs.params.normalLiquidityBps, inputs.params.normalSpreadBps, ruleProgram] as const;

    setIsRegistering(true);
    try {
      // Simulate first: the registry's own reverts are far more specific than anything this file
      // could assert, and a simulated revert costs the maker nothing.
      await publicClient.simulateContract({
        address: inputs.registry,
        abi: conditionalLiquidityRegistryAbi,
        functionName: "registerStrategy",
        args,
        account: inputs.maker,
      });

      const txHash = await writeContractAsync({
        address: inputs.registry,
        abi: conditionalLiquidityRegistryAbi,
        functionName: "registerStrategy",
        args,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      setHash(txHash);
      return txHash;
    } catch (e) {
      setError(readableError(e));
      return null;
    } finally {
      setIsRegistering(false);
    }
  }

  return { register, isRegistering, error, hash };
}

/** Surface the contract's own revert name where there is one, rather than a wall of RPC noise. */
function readableError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/StrategyAlreadyRegistered/.test(message)) {
    return "A strategy with these exact parameters is already registered for this pair and maker. Change a threshold to register a different one.";
  }
  if (/MakerMismatch/.test(message)) return "Connect the wallet that will be the maker for this strategy.";
  if (/LiquidityOutOfBounds|SpreadOutOfBounds/.test(message)) return "A value is outside the protocol's allowed range.";
  if (/User rejected|denied/i.test(message)) return "Transaction rejected in the wallet.";
  const named = message.match(/reverted with the following reason:\s*(.+)/)?.[1];
  return named ?? message.split("\n")[0];
}
