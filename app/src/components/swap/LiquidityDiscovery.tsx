import { ChevronDown, Info, Loader2, ShieldAlert } from "lucide-react";

import type { MarketSummary, SourceAllocation } from "../../market/derive";
import type { RegimeChange } from "../../market/useRegimeChange";
import type { RouteChange } from "../../market/useRouteChange";
import type { TokenInfo } from "../../trade/TradeContext";
import type { QuoteStatus, RouteResult } from "../../trade/useRouteQuote";
import { fmt, fmtBps, fmtRate, fmtToken } from "../../format";
import { LiquiditySourceCard } from "../liquidity/LiquiditySourceCard";
import { MarketConditions } from "../liquidity/MarketConditions";
import { NoPhantomLiquidity } from "../liquidity/NoPhantomLiquidity";
import { StrategySummary } from "../liquidity/StrategySummary";
import { RouteVisualizer } from "../route/RouteVisualizer";

/**
 * The discovery column: where the trade gets assembled.
 *
 * The order of the sections is the product's argument, and it changed deliberately. The route now
 * sits directly under market conditions, *above* the source cards: "here is how your order will be
 * filled" is the answer, and the per-source detail is the working behind it. Previously the working
 * came first and a reader had to scroll past two cards to reach the point.
 *
 * Before an amount is entered there is no route to show, so the sources lead - a visitor should be
 * able to see what liquidity exists before committing to a number.
 */
export function LiquidityDiscovery({
  status,
  result,
  allocations,
  summary,
  change,
  regimeChange,
  onDismissRegimeChange,
  volatilityBps,
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
  regimeChange: RegimeChange | null;
  onDismissRegimeChange: () => void;
  volatilityBps: number | undefined;
  amountWei: bigint | undefined;
  expectedOut: bigint | undefined;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  isStale: boolean;
  marketError: boolean;
}) {
  const sources = allocations.map((a) => a.source);
  const aqua = allocations.find((a) => a.source.key === "aqua");

  const sourceCards = marketError ? (
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
        <LiquiditySourceCard key={a.source.key} allocation={a} tokenIn={tokenIn} tokenOut={tokenOut} />
      ))}
    </div>
  );

  const liquidityHeader = (
    <header className="disco-head">
      <div className="disco-head-text">
        <span className="label">
          {status === "quoting" ? "Checking executable liquidity..." : "Available liquidity"}
        </span>
        <p className="disco-lede">
          Executable liquidity is the amount a source can actually settle right now.
        </p>
      </div>
      <NoPhantomLiquidity sources={sources} token={tokenIn} />
    </header>
  );

  return (
    <div className="disco">
      <MarketConditions
        summary={summary}
        change={change}
        regimeChange={regimeChange}
        onDismissRegimeChange={onDismissRegimeChange}
        volatilityBps={volatilityBps}
        token={tokenIn}
      />

      {/* The conditional-liquidity mechanism, on the main screen rather than only in a drawer. */}
      {aqua && <StrategySummary allocation={aqua} tokenIn={tokenIn} tokenOut={tokenOut} />}

      {/* ---- the route, first, once there is one ---- */}
      {amountWei !== undefined && status === "quoting" && !result && (
        <div className="disco-sec disco-quoting">
          <Loader2 className="spin" size={16} strokeWidth={2.5} aria-hidden="true" />
          Assembling the best route...
        </div>
      )}

      {amountWei !== undefined && result?.kind === "routable" && (
        <div className="disco-sec">
          <span className="label">Your route</span>
          <RouteVisualizer
            allocations={allocations}
            amountIn={amountWei}
            expectedOut={expectedOut}
            tokenIn={tokenIn}
            tokenOut={tokenOut}
            isStale={isStale}
          />
          <WhyThisRoute allocations={allocations} tokenIn={tokenIn} tokenOut={tokenOut} />
        </div>
      )}

      {amountWei !== undefined && result?.kind === "no-route" && (
        <div className="disco-sec">
          {/* Not an error. The market is simply too thin for this size right now. */}
          <div className="notice">
            <ShieldAlert size={16} color="var(--text-dim)" aria-hidden="true" />
            <div>
              <strong>No executable route</strong>
              <p>
                Only {fmtToken(result.totalExecutable, tokenIn)} is currently executable for this trade.
                Try a smaller amount.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ---- the sources the route was built from ---- */}
      <div className="disco-sec">
        {liquidityHeader}
        {sourceCards}
        {amountWei === undefined && (
          <p className="disco-hint">Enter an amount to see how your order would be filled.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Why the solver chose this split.
 *
 * Opens with the explanation in one plain sentence per source, because that is the sentence a judge
 * needs and it should not be assembled out of three labelled factors. The factors stay underneath
 * for a reader who wants the reasoning decomposed, and protocol vocabulary stays further down still,
 * inside each source's own drawer.
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
        {/* The plain-language answer, first. Every figure in it is read from chain. */}
        <div className="why-story">
          {allocations.map((a) => {
            const executable = a.source.executable?.conditionalLiquidity;
            const mode = a.source.snapshot?.mode;
            if (executable === undefined || mode === undefined) {
              return (
                <p key={a.source.key}>
                  <b>{a.source.name}</b>&apos;s liquidity couldn&apos;t be read, so nothing was routed to
                  it.
                </p>
              );
            }
            return (
              <p key={a.source.key}>
                <b>{a.source.name}</b> is in <b>{mode.toLowerCase()}</b> mode and can execute{" "}
                <b>{fmtToken(executable, tokenIn)}</b>
                {a.included ? (
                  <>
                    {" "}
                    - the Solver filled <b>{fmtToken(a.amountIn, tokenIn)}</b> here
                    {cappedOut.includes(a) ? ", its entire executable depth." : "."}
                  </>
                ) : (
                  <>, but the order was covered before reaching it.</>
                )}
              </p>
            );
          })}
          {used.length > 1 && (
            <p className="why-story-conclusion">
              The split is not a preference. Once a source is filled to what it can actually settle, the
              remainder has to go somewhere that can pay.
            </p>
          )}
        </div>

        <Factor
          k="Best price first"
          v={`${cheapest.source.name} at ${fmtBps(cheapest.source.snapshot?.spreadBps)} fee`}
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
                {fmt(a.amountIn, tokenIn.decimals)} {tokenIn.symbol} -&gt;{" "}
                {fmt(a.expectedOut, tokenOut.decimals)} {tokenOut.symbol}
                <em className="faint"> @ {fmtRate(a.amountIn, a.expectedOut, tokenIn, tokenOut)}</em>
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
