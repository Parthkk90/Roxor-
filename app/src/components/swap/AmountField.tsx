import { formatUnits } from "viem";

import { useTradeActions, useTradeDraft } from "../../trade/useTrade";
import type { TokenInfo } from "../../trade/TradeContext";
import { TokenSelect } from "./TokenSelect";

/**
 * The "you pay" field, and the ONLY `useTradeDraft()` consumer in the application.
 *
 * That is a hard rule. `TradeDraftContext` is the one context that changes per keystroke; anything
 * subscribing to it re-renders per character. Keeping the subscription confined here is what lets
 * the liquidity table share the same amount without paying for it.
 *
 * The input is never debounced — only the value that feeds a network read is, in `useAmountIntent`.
 * Typing stays immediate no matter how slow the chain is.
 */
export function AmountField({
  token,
  counterpart,
  balance,
  disabled,
}: {
  token: TokenInfo;
  counterpart: TokenInfo;
  balance: bigint | undefined;
  disabled?: boolean;
}) {
  const { amount } = useTradeDraft();
  const { setAmount, reverse } = useTradeActions();

  const formatted = balance === undefined ? undefined : formatUnits(balance, token.decimals);

  return (
    <div className="tokenfield">
      <div className="tokenfield-row">
        <input
          id="swap-amount"
          // Not `type="number"` — it hands back an empty string for input the user can plainly see,
          // and its spinners are meaningless at token precision. `setAmount` validates instead.
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0"
          aria-label={`Amount of ${token.symbol} to swap`}
          value={amount}
          disabled={disabled}
          onChange={(event) => setAmount(event.target.value)}
        />
        <TokenSelect side="in" selected={token} counterpart={counterpart} onSwapSides={reverse} />
      </div>

      <div className="tokenfield-meta">
        <span>You pay</span>
        {formatted !== undefined && (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <span className="num">
              Balance {Number(formatted).toFixed(4)}
            </span>
            <button type="button" onClick={() => setAmount(formatted)} disabled={balance === 0n}>
              Max
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
