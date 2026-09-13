import { ArrowLeftRight } from "lucide-react";

import { markets as marketConfig } from "../../config/markets";
import { useMarketList } from "../../market/useMarkets";
import { useTradeActions, useTradePair } from "../../trade/useTrade";
import { TokenSigil } from "../swap/TokenSelect";

/**
 * Market selection.
 *
 * One button per deployed market - never a combination of tokens the frontend invented. Each
 * market corresponds to its own real `Solver` + venue pair (see `script/DeploySolver.s.sol`); a
 * market that has not actually been deployed simply is not in `config/markets.ts`, so it cannot
 * appear here. Symbols come from `useMarketList` (chain metadata), never a hardcoded map.
 */
export function MarketSelector() {
  const pair = useTradePair();
  const { selectMarket, reverse } = useTradeActions();
  const marketList = useMarketList();

  return (
    <section className="mselect">
      <div className="mselect-list" role="tablist" aria-label="Markets">
        {marketList.map((m, i) => {
          const active = i === pair.marketIndex;
          return (
            <button
              key={m.raw.label}
              type="button"
              role="tab"
              aria-selected={active}
              className={`mselect-item${active ? " mselect-item-on" : ""}`}
              onClick={() => selectMarket(i)}
            >
              <span className="mselect-sigils" aria-hidden="true">
                <TokenSigil symbol={m.tokenInSymbol} />
                <TokenSigil symbol={m.tokenOutSymbol} />
              </span>
              <span className="mselect-name">
                {m.tokenInSymbol} / {m.tokenOutSymbol}
              </span>
            </button>
          );
        })}

        {marketConfig.length === 1 && (
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
