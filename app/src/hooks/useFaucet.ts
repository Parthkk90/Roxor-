import { useState } from "react";
import { type Address, parseUnits } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";
import { mockERC20Abi } from "../abis/index.js";
import { addresses } from "../config/contracts";

const FAUCET_AMOUNT = parseUnits("100", 18);

/** `MockERC20.mint` has no access control on this deployment: any wallet can self-serve test tokens. */
export function useFaucet() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [isMinting, setIsMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mintBoth(to: Address) {
    setIsMinting(true);
    setError(null);
    try {
      for (const token of [addresses.tokenA, addresses.tokenB] as const) {
        const hash = await writeContractAsync({
          address: token as Address,
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

  return { mintBoth, isMinting, error };
}
