import { useState } from "react";
import { type Address, parseUnits } from "viem";
import { anvil } from "viem/chains";
import { usePublicClient, useWriteContract } from "wagmi";
import { mockERC20Abi } from "../abis/index.js";
import { chainId } from "../config/contracts";
import { marketTokenAddresses } from "../config/markets";

/**
 * Local-development faucet. Available on anvil only.
 *
 * `MockERC20.mint` has no access control on either deployment, so this *would* work on the public
 * testnet too - and that is exactly why it is gated rather than merely hidden. A public trading
 * interface with a "get tokens" button invites the reading that the application issues assets, and
 * no amount of labelling fully undoes that. On a local chain there is nobody to mislead and a
 * developer needs a balance in one click.
 *
 * Testnet users get a link to the project's own token contracts instead, so they can see exactly
 * what these are before acquiring any.
 */
export const FAUCET_AVAILABLE = chainId === anvil.id;

const FAUCET_AMOUNT = parseUnits("10", 18);

export function useFaucet() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [isMinting, setIsMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mintAll(to: Address) {
    if (!FAUCET_AVAILABLE) return;
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
      setError("Couldn't mint test tokens - please try again.");
    } finally {
      setIsMinting(false);
    }
  }

  return { mintAll, isMinting, error, available: FAUCET_AVAILABLE };
}
