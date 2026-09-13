// Shared helpers for the Sepolia audit scripts. Read-only: every call here is eth_call/eth_getCode.
import { createPublicClient, http, keccak256 } from "viem";
import { sepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

export const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

/** Foundry artifact loader: `artifact("Solver")` -> out/Solver.sol/Solver.json. */
export function artifact(name, file = `${name}.sol`) {
  return JSON.parse(readFileSync(join(ROOT, "out", file, `${name}.json`), "utf8"));
}

/**
 * Solidity appends a CBOR metadata blob to deployed bytecode; its last two bytes are the blob
 * length. Two builds of identical source with different compiler settings/paths differ only
 * there, so comparisons strip it before hashing.
 */
export function stripMetadata(hex) {
  const b = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (b.length < 4) return b;
  const len = parseInt(b.slice(-4), 16) * 2 + 4;
  return len > b.length ? b : b.slice(0, b.length - len);
}

/** Immutables are baked into deployed code, so an exact match is only expected for immutable-free
 *  contracts. `ratio` reports how much of the stripped code is byte-identical. */
export function similarity(a, b) {
  const x = stripMetadata(a), y = stripMetadata(b);
  if (x.length !== y.length) return { sameLength: false, ratio: 0, lenOn: x.length / 2, lenArt: y.length / 2 };
  let same = 0;
  for (let i = 0; i < x.length; i += 2) if (x.slice(i, i + 2) === y.slice(i, i + 2)) same++;
  return { sameLength: true, ratio: same / (x.length / 2), lenOn: x.length / 2, lenArt: y.length / 2 };
}

export { keccak256 };
