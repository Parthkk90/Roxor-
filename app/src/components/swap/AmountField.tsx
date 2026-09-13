import { formatUnits } from "viem";

import { fmt } from "../../format";
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
 * The input is never debounced - only the value that feeds a network read is, in `useAmountIntent`.
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

  // Two different strings on purpose: `exact` is what the Max button types into the field, because
  // rounding a balance before spending it leaves dust or overdraws. `readable` is what a person
  // sees - a mock token minted at type(uint128).max is otherwise a 21-digit wall.
  const exact = balance === undefined ? undefined : formatUnits(balance, token.decimals);
  const readable = balance === undefined ? undefined : fmt(balance, token.decimals);

  return (
    <div className="tokenfield">
      <div className="tokenfield-row">
        <input
          id="swap-amount"
          // Not `type="number"` - it hands back an empty string for input the user can plainly see,
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
        {exact !== undefined && (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <span className="num" title={`${exact} ${token.symbol}`}>
              Balance {readable}
            </span>
            <button type="button" onClick={() => setAmount(exact)} disabled={balance === 0n}>
              Max
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
