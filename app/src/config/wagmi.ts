import { createConfig } from "@privy-io/wagmi";
import { http } from "viem";
import { anvil, sepolia } from "viem/chains";
import { chain, rpcUrl } from "./contracts";

/**
 * Both supported targets are registered, with the configured one first so wagmi treats it as the
 * default. Declaring only the active chain would make the transports map's key a union type that
 * `createConfig` cannot satisfy, and registering the inactive chain costs nothing - no connection
 * is opened until something actually reads from it.
 */
export const wagmiConfig = createConfig({
  chains: chain.id === anvil.id ? [anvil, sepolia] : [sepolia, anvil],
  transports: {
    [sepolia.id]: http(chain.id === sepolia.id ? rpcUrl : undefined),
    [anvil.id]: http(chain.id === anvil.id ? rpcUrl : undefined),
  },
  // Required for wagmi's connector state (used by Privy's embedded/injected wallet bridge) to
  // hydrate correctly on first load instead of racing Privy's own auth check.
  ssr: true,
});
