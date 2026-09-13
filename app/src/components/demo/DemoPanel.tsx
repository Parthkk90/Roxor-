import { useState } from "react";
import { ChevronDown, Droplets, ExternalLink, FlaskConical, TriangleAlert } from "lucide-react";
import { useAccount } from "wagmi";

import { addressUrl } from "../../chain/explorer";
import { FAUCET_AVAILABLE, useFaucet } from "../../hooks/useFaucet";
import { useShock } from "../../hooks/useShock";
import { useTradePair } from "../../trade/useTrade";

/**
 * Demo controls, behind disclosure and visually marked as not part of the product.
 *
 * These drive a market-state provider with no access control. They exist so the conditional-
 * liquidity behaviour can be *seen*: shock the market and the sources change mode, their executable
 * depth collapses, their fee widens, and the route re-splits - live, without reloading.
 *
 * Collapsed by default because a trader should not meet a "cause a market crash" button before they
 * meet the swap form.
 *
 * The token faucet is NOT here on the public testnet - see `useFaucet`. Instead the panel says what
 * the pair's tokens are and links to them, which is the honest version of the same help.
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
        <strong>Controlled market state.</strong> This deployment&apos;s market conditions come from a
        project-deployed provider with no access control, not a production oracle - which is exactly
        what makes them demonstrable. These controls move the <strong>Aqua maker&apos;s</strong>
        conditions on <strong>{pair.market.label}</strong> and leave the Uniswap pool alone, so you
        can watch that maker pull its liquidity back and the Solver shift your order onto the pool.
        Returning to full size takes about ten real minutes of sustained calm, because the recovery
        timer is enforced on-chain, not here.
      </p>

      <div className="demo-row" style={{ marginTop: "var(--s3)" }}>
        {FAUCET_AVAILABLE && (
          <button className="btn" onClick={() => address && faucet.mintAll(address)} disabled={!address || faucet.isMinting}>
            <Droplets size={14} strokeWidth={2} aria-hidden="true" />
            {faucet.isMinting ? "Minting..." : "Get test tokens"}
          </button>
        )}
        <button className="btn" onClick={shock.calm} disabled={shock.isSetting}>Calm</button>
        <button
          className="btn"
          onClick={shock.shock}
          disabled={shock.isSetting}
          style={{ borderColor: "var(--bad-line)", color: "var(--bad)" }}
        >
          <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
          Shock Aqua maker
        </button>
        <button className="btn" onClick={shock.recover} disabled={shock.isSetting}>Start recovery</button>
      </div>

      {!FAUCET_AVAILABLE && <TokenProvenance />}

      {!address && <p className="faint" style={{ fontSize: "var(--fs-xs)" }}>Connect a wallet to use these.</p>}
      {faucet.error && <p style={{ fontSize: "var(--fs-xs)", color: "var(--bad)" }}>{faucet.error}</p>}
      {shock.error && <p style={{ fontSize: "var(--fs-xs)", color: "var(--bad)" }}>{shock.error}</p>}
    </details>
  );
}

/**
 * What the pair's tokens actually are, with links.
 *
 * Replaces the faucet on the public deployment. It answers the question a visitor actually has -
 * "what am I trading and where did it come from" - without the interface appearing to issue assets.
 */
function TokenProvenance() {
  const pair = useTradePair();

  return (
    <p className="faint" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.55, marginTop: "var(--s3)" }}>
      <strong>Project test tokens.</strong> {pair.tokenIn.symbol} and {pair.tokenOut.symbol} are this
      project&apos;s own testnet ERC-20s. They carry no value and are not, and do not claim to be, any
      real asset.{" "}
      {[pair.tokenIn, pair.tokenOut].map((token, i) => {
        const url = addressUrl(token.address);
        return (
          <span key={token.address}>
            {i > 0 && " "}
            {url ? (
              <a href={url} target="_blank" rel="noreferrer">
                {token.symbol} contract
                <ExternalLink size={10} strokeWidth={2.5} aria-hidden="true" style={{ marginLeft: 3 }} />
              </a>
            ) : (
              token.symbol
            )}
          </span>
        );
      })}
    </p>
  );
}
