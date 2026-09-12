import { useMemo } from "react";
import { ArrowLeftRight } from "lucide-react";

import { TOKENS, type TokenInfo } from "../../trade/TradeContext";
import { useTradeActions, useTradePair } from "../../trade/useTrade";
import { TokenSigil } from "../swap/TokenSelect";

/**
 * Pair selection.
 *
 * Built by enumerating the tokens this deployment actually configures, so adding a token adds its
 * pairs with no code change — the marketplace is structured for many markets. What it will not do
 * is list markets that do not exist: inventing an "ETH / DAI" row to make the page look busier
 * would be phantom liquidity of a different kind, on a screen whose entire argument is that we only
 * show you what is real.
 *
 * With the current two-token deployment that means one market, shown in both directions.
 */
export function MarketSelector() {
  const pair = useTradePair();
  const { selectToken, reverse } = useTradeActions();

  const markets = useMemo(() => {
    const out: Array<{ key: string; a: TokenInfo; b: TokenInfo }> = [];
    for (let i = 0; i < TOKENS.length; i += 1) {
      for (let j = i + 1; j < TOKENS.length; j += 1) {
        out.push({ key: `${TOKENS[i]!.address}-${TOKENS[j]!.address}`, a: TOKENS[i]!, b: TOKENS[j]! });
      }
    }
    return out;
  }, []);

  const activeKey = useMemo(() => {
    const found = markets.find(
      (m) =>
        (m.a.address === pair.tokenIn.address && m.b.address === pair.tokenOut.address) ||
        (m.b.address === pair.tokenIn.address && m.a.address === pair.tokenOut.address)
    );
    return found?.key;
  }, [markets, pair.tokenIn.address, pair.tokenOut.address]);

  return (
    <section className="mselect">
      <div className="mselect-list" role="tablist" aria-label="Markets">
        {markets.map((m) => {
          const active = m.key === activeKey;
          return (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={`mselect-item${active ? " mselect-item-on" : ""}`}
              onClick={() => {
                selectToken("in", m.a.address);
                selectToken("out", m.b.address);
              }}
            >
              <span className="mselect-sigils" aria-hidden="true">
                <TokenSigil symbol={m.a.symbol} />
                <TokenSigil symbol={m.b.symbol} />
              </span>
              <span className="mselect-name">
                {m.a.symbol} / {m.b.symbol}
              </span>
            </button>
          );
        })}

        {markets.length === 1 && (
          // Say plainly that there is one market rather than padding the row with fake ones.
          <span className="mselect-note">
            This deployment lists one market. More appear here as they&apos;re deployed.
          </span>
        )}
      </div>

      <div className="mselect-dir">
        <span className="badge">
          {pair.tokenIn.symbol} → {pair.tokenOut.symbol}
        </span>
        <button type="button" className="btn btn-ghost" onClick={reverse} aria-label="Reverse direction">
          <ArrowLeftRight size={15} strokeWidth={2} aria-hidden="true" />
          Reverse
        </button>
      </div>
    </section>
  );
}
