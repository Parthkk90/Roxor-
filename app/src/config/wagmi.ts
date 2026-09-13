import { createConfig } from "@privy-io/wagmi";
import { http } from "viem";
import { anvil, sepolia } from "viem/chains";
import { chain, rpcUrl } from "./contracts";

/**
 * Exactly one chain is registered: the configured one.
 *
 * Registering the inactive chain "for free" is not free. wagmi opens a transport for every chain in
 * the list, and a Sepolia build with anvil also registered polled `http://127.0.0.1:8545` several
 * hundred times a minute - every one of them a connection-refused error in the console of a build
 * that has nothing to do with a local node. A public build must not reach for localhost at all,
 * even unsuccessfully.
 *
 * The branch below exists because `chain` is a union of two chain types, so a single
 * `createConfig({ chains: [chain], transports: { [chain.id]: ... } })` gives `transports` a union
 * key that `createConfig` cannot satisfy. Branching first collapses the union on each side, which
 * is the type-level cost of registering one chain instead of two.
 */
export const wagmiConfig =
  chain.id === anvil.id
    ? createConfig({
        chains: [anvil],
        transports: { [anvil.id]: http(rpcUrl) },
        // Required for wagmi's connector state (used by Privy's embedded/injected wallet bridge) to
        // hydrate correctly on first load instead of racing Privy's own auth check.
        ssr: true,
      })
    : createConfig({
        chains: [sepolia],
        transports: { [sepolia.id]: http(rpcUrl) },
        ssr: true,
      });
