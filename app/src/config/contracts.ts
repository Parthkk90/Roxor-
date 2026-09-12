import { anvil, sepolia } from "viem/chains";

/**
 * Deployment target.
 *
 * Defaults to the published Sepolia deployment so the hosted demo needs no configuration. Set
 * `VITE_CHAIN_ID=31337` plus the address overrides below to point the same UI at a local
 * `anvil` + `script/DeploySolver.s.sol` deployment — which is the only way to exercise a build of
 * the contracts newer than what is currently live on Sepolia.
 */
const configuredChainId = Number(import.meta.env.VITE_CHAIN_ID ?? sepolia.id);

export const chain = configuredChainId === anvil.id ? anvil : sepolia;
export const chainId = chain.id;

export const rpcUrl =
  import.meta.env.VITE_RPC_URL ??
  (chain.id === anvil.id ? "http://127.0.0.1:8545" : "https://ethereum-sepolia-rpc.publicnode.com");

/** Prefer an env override, else the baked-in Sepolia address. */
function address(override: string | undefined, fallback: string): string {
  return override && override.length > 0 ? override : fallback;
}

/**
 * Live Sepolia deployment of the conditional-liquidity marketplace.
 *
 * Redeploy with `script/DeploySolver.s.sol` / `script/DeployAquaFix.s.sol` and update here, or
 * override per-environment through the `VITE_*` variables.
 */
export const addresses = {
  solver: address(import.meta.env.VITE_SOLVER, "0xD8F26302929952DD220582C6eDCB4058E875b57A"),
  aquaVenue: address(import.meta.env.VITE_AQUA_VENUE, "0x47da4A55562AaDe84B7AEC13287e56125f6dfCe1"),
  uniswapV4Venue: address(import.meta.env.VITE_UNISWAP_V4_VENUE, "0x29364BB65a835b2A1e9776558E1f1966aDfaB120"),
  tokenA: address(import.meta.env.VITE_TOKEN_A, "0x246b76e37825a473Ae784Ce14A2Bb42733A8f922"),
  tokenB: address(import.meta.env.VITE_TOKEN_B, "0xFE14a75D92e1A028ebb497dAc4D25bF2e08B3Af3"),
  // Oracles + strategy ids, needed only by the demo shock controls (MockMarketStateProvider has
  // no access control, so any connected wallet can drive these).
  aquaOracle: address(import.meta.env.VITE_AQUA_ORACLE, "0x40b30ecEf85eA5e850373544Ba3a6d02BD7b49A2"),
  aquaStrategyId: address(
    import.meta.env.VITE_AQUA_STRATEGY_ID,
    "0xd4e296704cf420357c0d20976f594a2e301e01b4da3734f2b37d5184d852a2df"
  ),
  uniOracle: address(import.meta.env.VITE_UNI_ORACLE, "0xD0b139BF9c0576A96b48C3b9c3C5b0ed336cabF4"),
  uniStrategyId: address(
    import.meta.env.VITE_UNI_STRATEGY_ID,
    "0xacdbaa77ce0882057769fb71336eb3deff305c7a15a2bb821b62ffc55d77d911"
  ),
} as const;

export const tokenSymbols = {
  [addresses.tokenA.toLowerCase()]: "DTA",
  [addresses.tokenB.toLowerCase()]: "DTB",
} as const;
