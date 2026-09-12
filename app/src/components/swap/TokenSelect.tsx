import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import type { Address } from "viem";

import { TOKENS, type TokenInfo } from "../../trade/TradeContext";

/** Deterministic colour per token so the same asset keeps the same sigil everywhere. */
export function sigilColor(symbol: string): string {
  const palette = ["#5aa9ff", "#3fd98a", "#f5a623", "#c07cf5", "#ff4d5a", "#35d3c4"];
  let hash = 0;
  for (const ch of symbol) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

export function TokenSigil({ symbol }: { symbol: string }) {
  return (
    <span className="token-sigil" style={{ background: sigilColor(symbol) }} aria-hidden="true">
      {symbol.slice(0, 2)}
    </span>
  );
}

/**
 * Token picker.
 *
 * Built from the configured token list rather than a hardcoded pair, so adding a token to the
 * deployment adds it here with no code change. Uses a native `<dialog>`: focus trapping, Escape to
 * dismiss, and the backdrop all come from the platform, and it renders as a bottom sheet on narrow
 * screens where that is the expected shape.
 */
export function TokenSelect({
  side,
  selected,
  counterpart,
  onSelect,
}: {
  side: "in" | "out";
  selected: TokenInfo;
  counterpart: TokenInfo;
  onSelect: (side: "in" | "out", address: Address) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // Native dialogs open imperatively; keep that confined to this component.
  const open = () => ref.current?.showModal();
  const close = () => ref.current?.close();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onClick = (event: MouseEvent) => {
      // Clicking the backdrop (the dialog element itself, outside its content box) dismisses.
      if (event.target === dialog) dialog.close();
    };
    dialog.addEventListener("click", onClick);
    return () => dialog.removeEventListener("click", onClick);
  }, []);

  const label = side === "in" ? "Select the token you're paying with" : "Select the token you'll receive";

  return (
    <>
      <button type="button" className="token-pick" onClick={open} aria-haspopup="dialog">
        <TokenSigil symbol={selected.symbol} />
        {selected.symbol}
        {TOKENS.length > 1 && <ChevronDown size={15} strokeWidth={2.5} aria-hidden="true" />}
      </button>

      <dialog className="sheet" ref={ref} aria-label={label}>
        <div className="sheet-inner">
          <h3>{side === "in" ? "You pay" : "You receive"}</h3>
          <div role="listbox" aria-label={label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {TOKENS.map((token) => {
              const isSelected = token.address.toLowerCase() === selected.address.toLowerCase();
              const isCounterpart = token.address.toLowerCase() === counterpart.address.toLowerCase();
              return (
                <button
                  key={token.address}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className="token-option"
                  onClick={() => {
                    onSelect(side, token.address);
                    close();
                  }}
                >
                  <TokenSigil symbol={token.symbol} />
                  <span className="t">
                    <strong>{token.symbol}</strong>
                    <span>{token.address}</span>
                  </span>
                  {/* Picking the other side's token swaps them rather than erroring, so say so. */}
                  {isCounterpart && !isSelected && <span className="badge">Swaps sides</span>}
                  {isSelected && <span className="badge badge-info">Selected</span>}
                </button>
              );
            })}
          </div>
        </div>
      </dialog>
    </>
  );
}
