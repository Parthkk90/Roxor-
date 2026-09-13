import { useState } from "react";
import { ChevronDown, Droplets, FlaskConical, TriangleAlert } from "lucide-react";
import { useAccount } from "wagmi";

import { useFaucet } from "../../hooks/useFaucet";
import { useShock } from "../../hooks/useShock";
import { useTradePair } from "../../trade/useTrade";

/**
 * Demo controls, behind disclosure and visually marked as not part of the product.
 *
 * These drive an oracle with no access control. They exist so the conditional-liquidity behaviour
 * can be *seen*: shock the market and the sources on the Liquidity page change mode, their
 * executable depth collapses, their fee widens, and the route on the swap screen re-splits — all
 * within one block, without reloading. Acts on whichever market is currently selected.
 *
 * Collapsed by default because a trader should not meet a "cause a market crash" button before
 * they meet the swap form.
 */
export function DemoPanel() {
  const { address } = useAccount();
  const pair = useTradePair();
  const faucet = useFaucet();
  const shock = useShock(pair.market);
  const [open, setOpen] = useState(false);

  return (
    <details className="demo" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
          listStyle: "none",
          fontSize: "var(--fs-sm)",
          color: "var(--text-dim)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <FlaskConical size={14} strokeWidth={2} aria-hidden="true" />
          Demo controls
        </span>
        <ChevronDown size={15} strokeWidth={2} aria-hidden="true" style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 130ms" }} />
      </summary>

      <p className="faint" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.5, marginTop: "var(--s3)" }}>
        Testnet only. Shocking moves <strong>{pair.market.label}</strong>&apos;s strategies into
        defensive mode: watch depth fall, fees widen and the route re-split on the Liquidity page.
        Returning to calm takes about ten real minutes plus a trade, because the recovery timer is
        enforced on-chain.
      </p>

      <div className="demo-row" style={{ marginTop: "var(--s3)" }}>
        <button className="btn" onClick={() => address && faucet.mintAll(address)} disabled={!address || faucet.isMinting}>
          <Droplets size={14} strokeWidth={2} aria-hidden="true" />
          {faucet.isMinting ? "Minting…" : "Get test tokens"}
        </button>
        <button className="btn" onClick={shock.calm} disabled={shock.isSetting}>Calm</button>
        <button
          className="btn"
          onClick={shock.shock}
          disabled={shock.isSetting}
          style={{ borderColor: "var(--bad-line)", color: "var(--bad)" }}
        >
          <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
          Shock market
        </button>
        <button className="btn" onClick={shock.recover} disabled={shock.isSetting}>Start recovery</button>
      </div>

      {!address && <p className="faint" style={{ fontSize: "var(--fs-xs)" }}>Connect a wallet to use these.</p>}
      {faucet.error && <p style={{ fontSize: "var(--fs-xs)", color: "var(--bad)" }}>{faucet.error}</p>}
      {shock.error && <p style={{ fontSize: "var(--fs-xs)", color: "var(--bad)" }}>{shock.error}</p>}
    </details>
  );
}
