import { anvil, sepolia } from "viem/chains";

/**
 * Deployment target.
 *
 * Defaults to the published Sepolia deployment so the hosted demo needs no configuration. Set
 * `VITE_CHAIN_ID=31337` to point the same UI at a local `anvil` + `script/DeploySolver.s.sol` +
 * `script/seed-markets.sh` deployment - which is the only way to exercise a build of the contracts
 * newer than what is currently live on Sepolia.
 *
 * Per-market contract addresses live in `./markets`, not here: each market has its own Solver and
 * venues, so a single flat `addresses` object stopped making sense once there was more than one.
 */
const configuredChainId = Number(import.meta.env.VITE_CHAIN_ID ?? sepolia.id);

export const chain = configuredChainId === anvil.id ? anvil : sepolia;
export const chainId = chain.id;

/**
 * How the environment is named everywhere in the UI.
 *
 * Spelled out rather than abbreviated: "Sepolia" alone reads as a network name to someone who
 * already knows it is a testnet, and as nothing at all to someone who does not.
 */
export const NETWORK_LABEL = chain.id === anvil.id ? "Anvil - LOCAL" : "Ethereum Sepolia - TESTNET";

/** The longer form, for the footer: names the network AND what it implies about the money. */
export const NETWORK_TRUST_LABEL =
  chain.id === anvil.id ? "Anvil - LOCAL CHAIN - NO REAL FUNDS" : "Ethereum Sepolia - TESTNET - NO REAL FUNDS";

export const rpcUrl =
  import.meta.env.VITE_RPC_URL ??
  (chain.id === anvil.id ? "http://127.0.0.1:8545" : "https://ethereum-sepolia-rpc.publicnode.com");
