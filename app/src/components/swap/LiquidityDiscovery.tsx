import { ChevronDown, Info, Loader2, ShieldAlert } from "lucide-react";
import { formatUnits } from "viem";

import type { MarketSummary, SourceAllocation } from "../../market/derive";
import type { RouteChange } from "../../market/useRouteChange";
import type { TokenInfo } from "../../trade/TradeContext";
import type { QuoteStatus, RouteResult } from "../../trade/useRouteQuote";
import { fmt } from "../../format";
import { LiquiditySourceCard } from "../liquidity/LiquiditySourceCard";
import { MarketConditions } from "../liquidity/MarketConditions";
import { NoPhantomLiquidity } from "../liquidity/NoPhantomLiquidity";
import { RouteVisualizer } from "../route/RouteVisualizer";

/**
 * The discovery column: where the trade gets assembled.
 *
 * Deliberately sequential - sources, then the solver's split, then why. The order is the product's
 * argument: we found these, we verified what each can really pay, and here is how your order was
 * composed from them. A quote that appeared as one number would assert the same conclusion while
 * hiding every step that makes it trustworthy.
 */
export function LiquidityDiscovery({
  status,
  result,
  allocations,
  summary,
  change,
  amountWei,
  expectedOut,
  tokenIn,
  tokenOut,
  isStale,
  marketError,
}: {
  status: QuoteStatus;
  result: RouteResult | undefined;
  allocations: SourceAllocation[];
  summary: MarketSummary;
  change: RouteChange | null;
  amountWei: bigint | undefined;
  expectedOut: bigint | undefined;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  isStale: boolean;
  marketError: boolean;
}) {
  const sources = allocations.map((a) => a.source);

  // Nothing entered yet: show the market, not an empty frame. A visitor should be able to see what
  // liquidity exists before committing to an amount.
  if (amountWei === undefined) {
    return (
      <div className="disco">
        <MarketConditions summary={summary} change={null} symbol={tokenIn.symbol} />
        <div className="disco-sec">
          <header className="disco-head">
            <span className="label">Available liquidity</span>
            <NoPhantomLiquidity sources={sources} symbol={tokenIn.symbol} />
          </header>
          <div className="disco-sources">
            {allocations.map((a) => (
              <LiquiditySourceCard
                key={a.source.key}
                allocation={a}
                symbolIn={tokenIn.symbol}
                symbolOut={tokenOut.symbol}
              />
            ))}
          </div>
          <p className="disco-hint">Enter an amount to see how your order would be filled.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="disco">
      <MarketConditions summary={summary} change={change} symbol={tokenIn.symbol} />

      {/* ---- the sources ---- */}
      <div className="disco-sec">
        <header className="disco-head">
          <span className="label">
            {status === "quoting" ? "Checking executable liquidity…" : "Liquidity for this trade"}
          </span>
          <NoPhantomLiquidity sources={sources} symbol={tokenIn.symbol} />
        </header>

        {marketError ? (
          <div className="notice notice-bad">
            <ShieldAlert size={16} aria-hidden="true" />
            <div>
              <strong>Liquidity data unavailable</strong>
              <p>Unable to verify current on-chain liquidity.</p>
            </div>
          </div>
        ) : (
          <div className="disco-sources">
            {allocations.map((a) => (
              <LiquiditySourceCard
                key={a.source.key}
                allocation={a}
                symbolIn={tokenIn.symbol}
                symbolOut={tokenOut.symbol}
              />
            ))}
          </div>
        )}
      </div>

      {/* ---- the split ---- */}
      {status === "quoting" && !result && (
        <div className="disco-sec disco-quoting">
          <Loader2 className="spin" size={16} strokeWidth={2.5} aria-hidden="true" />
          Assembling the best route…
        </div>
      )}

      {result?.kind === "routable" && (
        <div className="disco-sec">
          <span className="label">Best execution</span>
          <RouteVisualizer
            allocations={allocations}
            amountIn={amountWei}
            expectedOut={expectedOut}
            symbolIn={tokenIn.symbol}
            symbolOut={tokenOut.symbol}
            isStale={isStale}
          />
          <WhyThisRoute allocations={allocations} tokenIn={tokenIn} tokenOut={tokenOut} />
        </div>
      )}

      {result?.kind === "no-route" && (
        <div className="disco-sec">
          {/* Not an error. The market is simply too thin for this size right now. */}
          <div className="notice">
            <ShieldAlert size={16} color="var(--text-dim)" aria-hidden="true" />
            <div>
              <strong>No executable route</strong>
              <p>
                Only {fmt(result.totalExecutable)} {tokenIn.symbol} is currently executable for this trade.
                Try a smaller amount.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Why the solver chose this split, in three factors a trader already understands: price, depth, and
 * how much risk each source is currently taking. Protocol vocabulary stays in the technical
 * expansion inside each source's own drawer.
 */
function WhyThisRoute({
  allocations,
  tokenIn,
  tokenOut,
}: {
  allocations: SourceAllocation[];
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
}) {
  const used = allocations.filter((a) => a.included);
  if (used.length === 0) return null;

  const cheapest = [...used].sort(
    (a, b) => (a.source.snapshot?.spreadBps ?? 1e9) - (b.source.snapshot?.spreadBps ?? 1e9)
  )[0]!;
  const cappedOut = used.filter(
    (a) => a.source.executable && a.amountIn >= a.source.executable.conditionalLiquidity
  );
  const stressed = used.filter((a) => a.source.snapshot && a.source.snapshot.mode !== "NORMAL");

  return (
    <details className="disclose why">
      <summary>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Info size={14} strokeWidth={2} aria-hidden="true" />
          Why this route?
        </span>
        <ChevronDown className="chev" size={16} strokeWidth={2} aria-hidden="true" />
      </summary>

      <div className="disclose-body">
        <Factor
          k="Best price first"
          v={`${cheapest.source.name} at ${((cheapest.source.snapshot?.spreadBps ?? 0) / 100).toFixed(2)}% fee`}
          detail={
            used.length > 1
              ? `It was filled first because it returns the most ${tokenOut.symbol} per ${tokenIn.symbol}.`
              : `It covered the whole order at the best available price.`
          }
        />
        <Factor
          k="Enough executable depth"
          v={
            cappedOut.length > 0
              ? `${cappedOut.map((a) => a.source.name).join(" and ")} filled to capacity`
              : "Covered without reaching any source's limit"
          }
          detail={
            cappedOut.length > 0
              ? `Once a source hits what it can actually pay, the remainder moves to the next best. We never allocate past that limit.`
              : `No source was asked for more than it can settle.`
          }
        />
        <Factor
          k="Current risk state"
          v={
            stressed.length === 0
              ? "All sources trading normally"
              : `${stressed.map((a) => a.source.name).join(", ")} holding back`
          }
          detail={
            stressed.length === 0
              ? `No source is limiting its size right now.`
              : `A source under elevated risk reduces how much it will trade, so less of your order can go there.`
          }
        />

        <div className="why-alloc">
          {used.map((a) => (
            <div className="why-alloc-row" key={a.source.key}>
              <span>{a.source.name}</span>
              <span className="num">
                {fmt(a.amountIn)} {tokenIn.symbol} → {fmt(a.expectedOut, 4)} {tokenOut.symbol}
                {a.source.snapshot && (
                  <em className="faint">
                    {" "}
                    @ {(
                      Number(formatUnits(a.expectedOut, tokenOut.decimals)) /
                      Math.max(Number(formatUnits(a.amountIn, tokenIn.decimals)), 1e-18)
                    ).toFixed(5)}
                  </em>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function Factor({ k, v, detail }: { k: string; v: string; detail: string }) {
  return (
    <div className="factor">
      <span className="factor-k">{k}</span>
      <span className="factor-v">{v}</span>
      <p className="factor-d">{detail}</p>
    </div>
  );
}
