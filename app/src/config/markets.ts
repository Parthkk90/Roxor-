import type { Address } from "viem";
import { anvil } from "viem/chains";

import { chainId } from "./contracts";

/**
 * One deployed market: a token pair, each with its own {Solver} (a Solver snapshots every venue
 * it holds unconditionally, so one Solver serves exactly one pair — see `Solver.sol`) and its own
 * Aqua + Uniswap-v4 venue pair, each independently driven by its own oracle/strategy.
 *
 * No token symbols or decimals here — those come from chain (`ERC20.symbol()`/`decimals()`), never
 * from a hardcoded map. See `market/useTokenMetadata.ts`.
 */
export interface MarketAddresses {
  label: string;
  tokenIn: Address;
  tokenOut: Address;
  solver: Address;
  aquaVenue: Address;
  uniswapV4Venue: Address;
  aquaOracle: Address;
  aquaStrategyId: `0x${string}`;
  uniOracle: Address;
  uniStrategyId: `0x${string}`;
}

/**
 * `script/DeploySolver.s.sol` writes these same addresses to `deployments/<chainId>.json` on every
 * run — this is the checked-in mirror the frontend actually reads at build time. Redeploying to
 * anvil means updating this list (matching the existing single-market convention this replaces:
 * the old `config/contracts.ts` also baked in addresses and documented "redeploy and update here").
 *
 * Market 2 (DUSDC/DDAI) is only at RECOVERY once `script/seed-markets.sh` has run after the
 * deploy — before that it reads NORMAL, which is still a real, honest on-chain state.
 */
const ANVIL_MARKETS: MarketAddresses[] = [
  {
    label: "DWA/DUSDC",
    tokenIn: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    tokenOut: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    solver: "0x998abeb3E57409262aE5b751f60747921B33613E",
    aquaVenue: "0xf5059a5D33d5853360D16C683c16e67980206f36",
    uniswapV4Venue: "0x95401dc811bb5740090279Ba06cfA8fcF6113778",
    aquaOracle: "0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE",
    aquaStrategyId: "0xceb2d45b3fa2e98430487f410e8c7d54c7221146b5d3197c1bcbffcfa67e0412",
    uniOracle: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
    uniStrategyId: "0x8429ddba19c5c5096cbd2a187788bdb1f16b7bd8eb30b29af53f781814b22db7",
  },
  {
    label: "DWA/DDAI",
    tokenIn: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    tokenOut: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    solver: "0x922D6956C99E12DFeB3224DEA977D0939758A1Fe",
    aquaVenue: "0xB0D4afd8879eD9F52b28595d31B441D079B2Ca07",
    uniswapV4Venue: "0x162A433068F51e18b7d13932F27e66a3f99E6890",
    aquaOracle: "0x99bbA657f2BbC93c02D617f8bA121cB8Fc104Acf",
    aquaStrategyId: "0x1dab741c124f4fcd41774472c5110ce0ca45ea5de363598d92a968eb82984d6e",
    uniOracle: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
    uniStrategyId: "0x70e2e736e985beddfb6d896f756a5c1740dfb827b74e09c81151fbac5c6eec70",
  },
  {
    label: "DDAI/DUSDC",
    tokenIn: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    tokenOut: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    solver: "0x4631BCAbD6dF18D94796344963cB60d44a4136b6",
    aquaVenue: "0x7A9Ec1d04904907De0ED7b6839CcdD59c3716AC9",
    uniswapV4Venue: "0x49fd2BE640DB2910c2fAb69bB8531Ab6E76127ff",
    aquaOracle: "0x2E2Ed0Cfd3AD2f1d34481277b3204d807Ca2F8c2",
    aquaStrategyId: "0xeff6b54e26555189ea965643d86beabd12191e7bf547581d2d68d252f243f921",
    uniOracle: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
    uniStrategyId: "0x8b40df7378e8bb478d889e2783f0ff63a55b66d9dc241590f4008152da77fc28",
  },
];

/** The live Sepolia deployment: one market, unchanged from before this multi-market work. */
const SEPOLIA_MARKETS: MarketAddresses[] = [
  {
    label: "DTA/DTB",
    tokenIn: "0x246b76e37825a473Ae784Ce14A2Bb42733A8f922",
    tokenOut: "0xFE14a75D92e1A028ebb497dAc4D25bF2e08B3Af3",
    solver: "0xD8F26302929952DD220582C6eDCB4058E875b57A",
    aquaVenue: "0x47da4A55562AaDe84B7AEC13287e56125f6dfCe1",
    uniswapV4Venue: "0x29364BB65a835b2A1e9776558E1f1966aDfaB120",
    aquaOracle: "0x40b30ecEf85eA5e850373544Ba3a6d02BD7b49A2",
    aquaStrategyId: "0xd4e296704cf420357c0d20976f594a2e301e01b4da3734f2b37d5184d852a2df",
    uniOracle: "0xD0b139BF9c0576A96b48C3b9c3C5b0ed336cabF4",
    uniStrategyId: "0xacdbaa77ce0882057769fb71336eb3deff305c7a15a2bb821b62ffc55d77d911",
  },
];

/** Every market this build knows how to talk to, for the currently configured chain. */
export const markets: MarketAddresses[] = chainId === anvil.id ? ANVIL_MARKETS : SEPOLIA_MARKETS;

/** Every distinct token address across all configured markets — the universe `useTokenMetadata` reads. */
export const marketTokenAddresses: Address[] = Array.from(
  new Set(markets.flatMap((m) => [m.tokenIn.toLowerCase(), m.tokenOut.toLowerCase()]))
) as Address[];
