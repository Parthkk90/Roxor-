import { type Address, concatHex, encodeAbiParameters, keccak256, toHex } from "viem";

/**
 * The SwapVM order a conditional-liquidity strategy is attached to, built in the browser.
 *
 * A strategy has no identity of its own: it *is* a SwapVM order backed by Aqua liquidity, and its
 * id is `keccak256(abi.encode(order))` - the same 32 bytes `Aqua.ship` and `SwapVM.hash` derive.
 * `ConditionalLiquidityRegistry.registerStrategy` takes the order itself, so a UI that registers a
 * strategy has to be able to build one.
 *
 * This mirrors `MakerTraitsLib.build` (`@1inch/swap-vm`) for the one configuration this product
 * uses: Aqua-backed, no receiver override, no transfer hooks. In that case every hook slice is
 * empty, so all four order-data indexes are 40 (the length of `tokenA ++ tokenB`) and `data` is
 * simply `tokenA ++ tokenB ++ program`.
 *
 * `order.test.ts` pins this against the strategy already registered on Sepolia: the builder has to
 * reproduce that exact id from its public inputs, which it could not do if any bit were wrong.
 */

const USE_AQUA_INSTEAD_OF_SIGNATURE = 1n << 254n;
const ORDER_DATA_SLICES_INDEXES_BIT_OFFSET = 160n;

/** Length of the `tokenA ++ tokenB` prefix, which is where every (empty) hook slice begins. */
const PROGRAM_OFFSET = 40n;

export interface SwapVmOrder {
  maker: Address;
  traits: bigint;
  data: `0x${string}`;
}

const ORDER_ABI = [
  {
    type: "tuple",
    components: [
      { name: "maker", type: "address" },
      { name: "traits", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

export function buildAquaOrder(maker: Address, tokenA: Address, tokenB: Address, program: `0x${string}`): SwapVmOrder {
  if (tokenA.toLowerCase() >= tokenB.toLowerCase()) {
    throw new Error("tokenA must sort before tokenB - SwapVM rejects an unsorted pair.");
  }

  // uint64(bytes8(abi.encodePacked(index3, index2, index1, index0))), all four equal to 40 here.
  let indexes = 0n;
  for (let i = 0; i < 4; i++) indexes = (indexes << 16n) | PROGRAM_OFFSET;

  return {
    maker,
    traits: USE_AQUA_INSTEAD_OF_SIGNATURE | (indexes << ORDER_DATA_SLICES_INDEXES_BIT_OFFSET),
    data: concatHex([tokenA, tokenB, program]),
  };
}

/** `StrategyLib.strategyId` / `Aqua.ship`'s `strategyHash` / `SwapVM.hash`'s Aqua branch. */
export function strategyIdOf(order: SwapVmOrder): `0x${string}` {
  return keccak256(encodeAbiParameters(ORDER_ABI, [order]));
}

/**
 * The SwapVM program an Aqua-backed conditional-liquidity order runs, mirroring
 * `ConditionalLiquidityProgramLib.build`: the constant-product curve, then an Extruction that
 * gates the curve's own output through the conditional-liquidity engine.
 *
 * Instruction framing is `[opcode][argsLength][args]`, which is what the deployed
 * `StrategyValidator._validateProgramShape` walks. The two opcode values are read from the
 * compiled artifacts rather than guessed - see `xycSwapOpcode`/`extructionOpcode` below.
 */
export function buildSwapProgram(opcodes: { xycSwap: number; extruction: number }, extructionTarget: Address): `0x${string}` {
  return concatHex([
    toHex(opcodes.xycSwap, { size: 1 }),
    toHex(0, { size: 1 }),
    toHex(opcodes.extruction, { size: 1 }),
    toHex(20, { size: 1 }),
    // Lower-cased deliberately: the program is hashed into the strategy id, and a checksummed
    // address would be different *bytes* from what Solidity's `abi.encodePacked` produces.
    extructionTarget.toLowerCase() as `0x${string}`,
  ]);
}
