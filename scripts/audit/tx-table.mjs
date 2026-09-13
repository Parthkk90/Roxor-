/**
 * Builds the Sepolia transaction table in `docs/sepolia-deployment.md` from receipts, so every row
 * in that document is a real receipt rather than something transcribed by hand.
 *
 * Run: node scripts/audit/tx-table.mjs
 */
import { formatEther } from "viem";

import { client } from "./lib.mjs";
import { TRANSACTIONS as TXS } from "./transactions.mjs";

let totalGas = 0n;
let totalFee = 0n;
const rows = [];
for (const [purpose, hash] of TXS) {
  const [receipt, tx] = await Promise.all([
    client.getTransactionReceipt({ hash }),
    client.getTransaction({ hash }),
  ]);
  const fee = receipt.gasUsed * receipt.effectiveGasPrice;
  totalGas += receipt.gasUsed;
  totalFee += fee;
  rows.push(
    `| ${purpose} | \`${hash}\` | ${receipt.blockNumber} | ${tx.to ?? "(contract creation)"} | ${
      tx.value === 0n ? "0" : formatEther(tx.value)
    } | ${receipt.gasUsed.toLocaleString()} | ${receipt.status} |`
  );
}

console.log("| Purpose | Transaction hash | Block | To | Value (ETH) | Gas used | Result |");
console.log("|---|---|---|---|---|---|---|");
console.log(rows.join("\n"));
console.log(`\nTotal: ${TXS.length} transactions, ${totalGas.toLocaleString()} gas, ${formatEther(totalFee)} ETH in fees.`);
