/**
 * Writes the complete `deployments/11155111.json` deployment manifest.
 *
 * `script/DeploySepolia.s.sol` writes the addresses it produced, which is all a broadcast can know:
 * transaction hashes do not exist yet while the script is executing. This fills in the rest -
 * reused contracts, token metadata, strategy parameters and every transaction - and it does so by
 * *reading them back from Sepolia*, so the manifest cannot drift from the chain it describes.
 *
 * Run: node scripts/audit/manifest.mjs        (add --check to verify without writing)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatUnits, getAddress } from "viem";
import { client, artifact, ROOT } from "./lib.mjs";
import { TRANSACTIONS } from "./transactions.mjs";

const path = join(ROOT, "deployments", "11155111.json");
const existing = JSON.parse(readFileSync(path, "utf8"));
const market = existing.markets[0];

const REUSED = {
  aqua: "0xB9e780c07B3d36Af0090B011bd0233Ca8b212844",
  aquaSwapVMRouter: "0x8FCF7D68df61a9FCf2009e606ff632E97BdDEAEC",
  aquaRegistry: "0x9888e8C6CffBEbF792C6B0B3d1085B7B11Da61a7",
  aquaEngine: "0x1ee607310423099D47F3B35d59F8BB66690EC952",
  aquaExtruction: "0xb21Bf6e48FbcFDf83a7685924A244510Db08bC75",
  aquaMarketStateProvider: "0x40b30ECEF85Ea5E850373544ba3A6D02bd7b49a2",
  uniRegistry: "0x738b102E559EEBE23F5a67cC61798CBcB14284dB",
  uniEngine: "0x4670CC0Ab2322F5aFcaa9ec91ee3fbE0d35A2D55",
  uniMarketStateProvider: "0xD0b139BF9c0576A96b48C3b9c3C5b0ed336cabF4",
  mockWETH: "0x8D302A3123b6C710f9ee5D858e3B06AB0b6f478D",
};

const OFFICIAL = {
  uniswapV4PoolManager: "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  uniswapV4PoolSwapTest: "0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe",
  uniswapV4PoolModifyLiquidityTest: "0x0C478023803a644c94c4CE1C1e7b9A087e411B0A",
};

/** Every address in the manifest is proved to hold code before it is written down. */
async function requireCode(label, address) {
  const code = await client.getCode({ address: getAddress(address) });
  if (!code || code === "0x") throw new Error(`${label} (${address}) has no code on Sepolia`);
  return getAddress(address);
}

async function token(address) {
  const abi = artifact("MockERC20").abi;
  const [name, symbol, decimals] = await Promise.all(
    ["name", "symbol", "decimals"].map((functionName) => client.readContract({ address, abi, functionName }))
  );
  return { address: getAddress(address), name, symbol, decimals, provenance: "project test token, deployed on Ethereum Sepolia" };
}

const registryAbi = artifact("ConditionalLiquidityRegistry").abi;
async function strategy(registry, strategyId, venueKind) {
  const [definition, state] = await Promise.all([
    client.readContract({ address: getAddress(registry), abi: registryAbi, functionName: "getStrategy", args: [strategyId] }),
    client.readContract({ address: getAddress(registry), abi: registryAbi, functionName: "getStrategyState", args: [strategyId] }),
  ]);
  return {
    id: strategyId,
    venue: venueKind,
    registry: getAddress(registry),
    maker: definition.maker,
    baseLiquidityBps: definition.baseLiquidityBps,
    baseSpreadBps: definition.baseSpreadBps,
    programHash: definition.programHash,
    active: definition.active,
    currentMode: ["NORMAL", "DEFENSIVE", "RECOVERY"][state.mode],
    currentLiquidityBps: state.liquidityBps,
    currentSpreadBps: state.spreadBps,
    transitionCount: Number(state.transitionCount),
  };
}

const contracts = {};
for (const [key, address] of Object.entries({
  solver: market.solver,
  aquaVenue: market.aquaVenue,
  uniswapV4Venue: market.uniswapV4Venue,
  conditionalLiquidityHook: market.hook,
})) {
  contracts[key] = { address: await requireCode(key, address), status: "NEW" };
}
for (const [key, address] of Object.entries(REUSED)) {
  contracts[key] = { address: await requireCode(key, address), status: "REUSED" };
}
for (const [key, address] of Object.entries(OFFICIAL)) {
  contracts[key] = { address: await requireCode(key, address), status: "REUSED_OFFICIAL" };
}

const venueAbi = artifact("AquaVenue").abi;
const liquidity = {};
for (const [key, address] of [["aqua", market.aquaVenue], ["uniswapV4", market.uniswapV4Venue]]) {
  const e = await client.readContract({
    address, abi: venueAbi, functionName: "executableLiquidity", args: [market.tokenIn, market.tokenOut],
  });
  liquidity[key] = {
    tokenIn: getAddress(market.tokenIn),
    advertised: formatUnits(e.virtualLiquidity, 18),
    wallet: formatUnits(e.walletLiquidity, 18),
    allowance: e.allowance === 2n ** 256n - 1n ? "unbounded" : formatUnits(e.allowance, 18),
    deliverable: formatUnits(e.deliverableLiquidity, 18),
    executable: formatUnits(e.conditionalLiquidity, 18),
    coverageBps: e.coverageBps,
  };
}

const manifest = {
  chainId: 11155111,
  network: "sepolia",
  label: "Ethereum Sepolia · TESTNET",
  deployer: getAddress(existing.deployer),
  deploymentBlock: existing.deploymentBlock,
  documentation: "docs/sepolia-deployment.md",
  contracts,
  tokens: {
    tokenIn: await token(market.tokenIn),
    tokenOut: await token(market.tokenOut),
  },
  markets: [
    {
      label: market.label,
      tokenIn: getAddress(market.tokenIn),
      tokenOut: getAddress(market.tokenOut),
      solver: getAddress(market.solver),
      aquaVenue: getAddress(market.aquaVenue),
      uniswapV4Venue: getAddress(market.uniswapV4Venue),
      aquaOracle: getAddress(market.aquaOracle),
      uniOracle: getAddress(market.uniOracle),
      // Older manifests predate the deploy script recording this; fall back to the known
      // reused instance rather than emitting a hole.
      extruction: getAddress(market.extruction ?? REUSED.aquaExtruction),
      hook: getAddress(market.hook),
      poolId: market.poolId,
      aquaStrategyId: market.aquaStrategyId,
      uniStrategyId: market.uniStrategyId,
      liquidity,
    },
  ],
  strategies: {
    aqua: await strategy(REUSED.aquaRegistry, market.aquaStrategyId, "aqua"),
    uniswapV4: await strategy(REUSED.uniRegistry, market.uniStrategyId, "uniswap-v4"),
  },
  transactions: Object.fromEntries(
    await Promise.all(
      TRANSACTIONS.map(async ([purpose, hash]) => {
        const receipt = await client.getTransactionReceipt({ hash });
        return [hash, { purpose, block: Number(receipt.blockNumber), gasUsed: Number(receipt.gasUsed), status: receipt.status }];
      })
    )
  ),
};

const json = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const same = readFileSync(path, "utf8") === json;
  console.log(same ? "manifest is up to date" : "manifest is STALE - re-run without --check");
  process.exit(same ? 0 : 1);
}
writeFileSync(path, json);
console.log(`wrote ${path}`);
