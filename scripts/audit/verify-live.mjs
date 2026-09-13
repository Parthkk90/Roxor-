/**
 * Post-deployment verification of the live Sepolia marketplace, read with the ABIs this
 * repository builds today. Everything printed here is an `eth_call` against the deployed
 * addresses in `deployments/11155111.json` - nothing is read from the manifest except addresses.
 *
 * Run: node scripts/audit/verify-live.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatUnits, getAddress } from "viem";
import { client, artifact, ROOT } from "./lib.mjs";

const manifest = JSON.parse(readFileSync(join(ROOT, "deployments", "11155111.json"), "utf8"));
const m = manifest.markets[0];
const abi = (n, f) => artifact(n, f).abi;
const J = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

console.log(`chainId ${manifest.chainId}  deployer ${manifest.deployer}  block ${await client.getBlockNumber()}`);
console.log(`deployer balance ${formatUnits(await client.getBalance({ address: getAddress(manifest.deployer) }), 18)} ETH\n`);

const erc = abi("MockERC20");
for (const [role, address] of [["tokenIn", m.tokenIn], ["tokenOut", m.tokenOut]]) {
  const [name, symbol, decimals] = await Promise.all(
    ["name", "symbol", "decimals"].map((f) => client.readContract({ address, abi: erc, functionName: f }))
  );
  const bal = await client.readContract({ address, abi: erc, functionName: "balanceOf", args: [manifest.deployer] });
  console.log(`${role.padEnd(8)} ${address}  ${name} (${symbol}) ${decimals}dp  maker holds ${formatUnits(bal, decimals)}`);
}

const venueAbi = abi("AquaVenue"); // ILiquidityVenue + IExecutableLiquidity, shared by both venues
console.log("\n-- venues --");
for (const [label, address] of [["Aqua / SwapVM", m.aquaVenue], ["Uniswap v4", m.uniswapV4Venue]]) {
  const [snap, exec] = await Promise.all(
    ["snapshot", "executableLiquidity"].map((fn) =>
      client.readContract({ address, abi: venueAbi, functionName: fn, args: [m.tokenIn, m.tokenOut] })
    )
  );
  console.log(`\n${label}  ${address}`);
  console.log(`  mode=${["NORMAL", "DEFENSIVE", "RECOVERY"][snap.mode]}  spread=${snap.spreadBps}bps  price=${formatUnits(snap.referencePrice, 18)}  coverage=${snap.coverageBps}bps`);
  console.log(`  advertised  ${formatUnits(exec.virtualLiquidity, 18)}`);
  console.log(`  wallet      ${formatUnits(exec.walletLiquidity, 18)}`);
  console.log(`  allowance   ${exec.allowance === 2n ** 256n - 1n ? "MAX (n/a)" : formatUnits(exec.allowance, 18)}`);
  console.log(`  deliverable ${formatUnits(exec.deliverableLiquidity, 18)}   = min(advertised, wallet, allowance)`);
  console.log(`  executable  ${formatUnits(exec.conditionalLiquidity, 18)}   = deliverable x ${snap.mode === 0 ? "100%" : "strategy multiplier"}`);
  console.log(`  snapshot.effectiveLiquidity === executable: ${snap.effectiveLiquidity === exec.conditionalLiquidity}`);
}

console.log("\n-- solver route, 1 token in --");
const plan = await client.readContract({
  address: m.solver, abi: abi("Solver"), functionName: "route",
  args: [{ tokenIn: m.tokenIn, tokenOut: m.tokenOut, amount: 10n ** 18n, maxSlippageBps: 10_000 }],
});
console.log(J(plan));
