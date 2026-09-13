import { useState } from "react";
import { type Address, parseUnits } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";
import { mockERC20Abi } from "../abis/index.js";
import { marketTokenAddresses } from "../config/markets";

const FAUCET_AMOUNT = parseUnits("100", 18);

/**
 * `MockERC20.mint` has no access control on this deployment: any wallet can self-serve test
 * tokens. Mints every token across every configured market — not just the one currently
 * selected — so switching markets never leaves a trader without balance to try it.
 */
export function useFaucet() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [isMinting, setIsMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mintAll(to: Address) {
    setIsMinting(true);
    setError(null);
    try {
      for (const token of marketTokenAddresses) {
        const hash = await writeContractAsync({
          address: token,
          abi: mockERC20Abi,
          functionName: "mint",
          args: [to, FAUCET_AMOUNT],
        });
        await publicClient?.waitForTransactionReceipt({ hash });
      }
    } catch {
      setError("Couldn't mint test tokens — please try again.");
    } finally {
      setIsMinting(false);
    }
  }

  return { mintAll, isMinting, error };
}
