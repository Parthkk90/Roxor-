import { useState } from "react";
import { Settings2 } from "lucide-react";

import { useTradeActions, useTradePair } from "../../trade/useTrade";

const PRESETS = [10, 50, 100, 300];

/**
 * Slippage tolerance, shared by every quote consumer through `TradePairContext`.
 *
 * The swap card and the marketplace previously passed different values (100 bps and 10000 bps) to
 * the same quote hook, so the two panels could disagree about whether a trade was routable at all.
 * There is now exactly one value and one place to set it.
 *
 * It controls `minTotalAmountOut` on settle, not the solver's `maxSlippageBps` - see the note in
 * `useRouteQuote` - so the label says "minimum received" rather than naming a contract parameter.
 */
export function SlippageControl() {
  const { slippageBps } = useTradePair();
  const { setSlippageBps } = useTradeActions();
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ minHeight: 32, padding: "0 10px", gap: 6 }}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Settings2 size={15} strokeWidth={2} aria-hidden="true" />
        <span className="mono" style={{ fontSize: "var(--fs-xs)" }}>
          {(slippageBps / 100).toFixed(2)}%
        </span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            zIndex: 30,
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-lg)",
            padding: "var(--s4)",
            boxShadow: "var(--shadow-pop)",
            width: 250,
            display: "flex",
            flexDirection: "column",
            gap: "var(--s3)",
          }}
        >
          <span className="label">Minimum received tolerance</span>
          <div className="slip">
            {PRESETS.map((bps) => (
              <button
                key={bps}
                type="button"
                className="slip-opt"
                aria-pressed={bps === slippageBps}
                onClick={() => setSlippageBps(bps)}
              >
                {bps / 100}%
              </button>
            ))}
          </div>
          <p className="faint" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.45 }}>
            Your swap is rejected rather than filled if it would return less than this. It never
            costs you more than you agreed.
          </p>
        </div>
      )}
    </div>
  );
}
