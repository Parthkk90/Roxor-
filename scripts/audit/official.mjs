/**
 * Step 3 of the Sepolia audit: is there official, reusable third-party infrastructure on Sepolia
 * that this project deployed its own copy of? Checked by reading code + calling the interface,
 * never by trusting a docs page.
 */
import { client } from "./lib.mjs";
import { parseAbi, getAddress } from "viem";

const CANDIDATES = {
  "Uniswap v4 PoolManager (official)": "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543",
  "Uniswap v4 PositionManager (official)": "0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4",
  "Uniswap v4 StateView (official)": "0xE1Dd9c3fA50EDB962E442f60DfBc432e24537E4C",
  "Uniswap v4 Quoter (official)": "0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227",
  "Uniswap v4 PoolSwapTest (official)": "0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe",
  "Uniswap v4 PoolModifyLiquidityTest (official)": "0x0C478023803a644c94c4CE1C1e7b9A087e411B0A",
  "Uniswap Permit2 (canonical)": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  "1inch Aqua (mainnet addr, checked on Sepolia)": "0x00000000009F1d5C6D9b1D2f6b3f3b0e5e5e5e5e",
  "Circle USDC (Sepolia, official)": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "project PoolManager (self-deployed)": "0x7C881eb559C77d67c94287Ca9AdEE7944D43ba21",
  "project PoolSwapTest (self-deployed)": "0xf29512A1800378B976a59B5D8e1643dbAa40062C",
  "project PoolModifyLiquidityTest (self-deployed)": "0x1a25B6ff2217a177657F6c33da847C1552bfC9B1",
};

const rows = [];
for (const [label, addr] of Object.entries(CANDIDATES)) {
  let address;
  try { address = getAddress(addr); } catch { rows.push({ label, addr, size: "bad checksum" }); continue; }
  const code = await client.getCode({ address }).catch(() => "0x");
  rows.push({ label, addr: address, size: code && code !== "0x" ? (code.length - 2) / 2 : 0 });
}
console.table(rows);

// Prove the official PoolManager is what it claims by calling a v4-only entrypoint.
const pm = parseAbi(["function extsload(bytes32) view returns (bytes32)", "function owner() view returns (address)"]);
for (const a of ["0xE03A1074c86CFeDd5C142C4F04F1a1536e203543", "0x7C881eb559C77d67c94287Ca9AdEE7944D43ba21"]) {
  try {
    const v = await client.readContract({ address: getAddress(a), abi: pm, functionName: "extsload", args: ["0x" + "00".repeat(32)] });
    console.log(`extsload ok  ${a} -> ${v}`);
  } catch (e) { console.log(`extsload FAIL ${a}: ${String(e.shortMessage ?? e.message).split("\n")[0]}`); }
  try {
    const v = await client.readContract({ address: getAddress(a), abi: pm, functionName: "owner" });
    console.log(`owner        ${a} -> ${v}`);
  } catch { console.log(`owner        ${a} -> (none)`); }
}

// USDC provenance + gas price
const erc = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)"]);
try {
  const u = getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
  const [n, s, d, t] = await Promise.all(["name","symbol","decimals","totalSupply"].map(f => client.readContract({ address: u, abi: erc, functionName: f })));
  console.log(`\nSepolia USDC ${u}: ${n} (${s}) dec=${d} totalSupply=${t}`);
} catch (e) { console.log("USDC probe failed:", e.shortMessage ?? e.message); }

const gp = await client.getGasPrice();
const blk = await client.getBlock();
console.log(`\ngasPrice=${gp} wei (${Number(gp) / 1e9} gwei)  baseFee=${blk.baseFeePerGas} block=${blk.number}`);
