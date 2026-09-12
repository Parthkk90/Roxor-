import { chain } from "../config/contracts";

/**
 * Block-explorer link for a transaction, or `null` when the chain has none.
 *
 * The previous build hardcoded `sepolia.etherscan.io` while the app was configured for anvil, so
 * every "view transaction" link pointed at a Sepolia transaction that does not exist. Returning
 * `null` lets the UI omit the link entirely rather than offer a broken one — on a local chain there
 * is genuinely nowhere to send the user.
 */
export function txUrl(hash: `0x${string}` | undefined): string | null {
  if (!hash) return null;
  const base = chain.blockExplorers?.default?.url;
  return base ? `${base}/tx/${hash}` : null;
}

export function addressUrl(address: `0x${string}` | undefined): string | null {
  if (!address) return null;
  const base = chain.blockExplorers?.default?.url;
  return base ? `${base}/address/${address}` : null;
}

export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}
