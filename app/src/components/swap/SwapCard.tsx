import { ArrowDown, CheckCircle2, ExternalLink, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import { usePrivy } from "@privy-io/react-auth";

import { useMarket } from "../../market/useMarket";
import { allocationsFor, summarize } from "../../market/derive";
import { coverageTone } from "../../market/coverage";
import { useSwapFlow } from "../../trade/useSwapFlow";
import { useTradeActions, useTradePair } from "../../trade/useTrade";
import { isTransacting, shouldShowRoute } from "../../trade/settleState";
import { shortHash, txUrl } from "../../chain/explorer";
import { fmt } from "../../format";
import { AmountField } from "./AmountField";
import { RouteAllocationBar } from "../route/RouteVisualizer";
import { SlippageControl } from "./SlippageControl";
import { TokenSelect, TokenSigil } from "./TokenSelect";
import { TxProgress } from "./TxProgress";

const TONE_CLASS = { success: "badge-ok", warning: "badge-warn", danger: "badge-bad", neutral: "" } as const;

export function SwapCard() {
  const pair = useTradePair();
  const { reverse } = useTradeActions();
  const flow = useSwapFlow();
  const market = useMarket(pair.tokenIn.address, pair.tokenOut.address, pair.market.aquaVenue, pair.market.uniswapV4Venue);
  const { login } = usePrivy();

  const { state, quote } = flow;
  const stage = state.stage;

  // `minOut` is the only figure the contract enforces, so it is the one shown large. `expectedOut`
  // is advisory by construction - `settle` re-derives the route - and is shown as secondary.
  const guaranteed = flow.signed?.minOut ?? flow.minOut;

  if (stage === "success") return <SuccessPanel flow={flow} />;

  if (isTransacting(stage)) {
    return (
      <div className="swap">
        <div className="card">
          <div className="card-head">
            <h2 style={{ fontSize: "var(--fs-md)" }}>
              Swapping {fmt(flow.signed?.amountWei)} {pair.tokenIn.symbol}
            </h2>
          </div>
          <TxProgress
            stage={stage}
            symbolIn={pair.tokenIn.symbol}
            approveHash={flow.approveHash}
            settleHash={flow.settleHash}
            needsApproval={Boolean(flow.approveHash)}
          />
        </div>
      </div>
    );
  }

  const summary = summarize(market.sources);
  const allocations = allocationsFor(market.sources, flow.plan);
  const healthBand = summary.marketBand;

  return (
    <div className="swap">
      <div className="card">
        <div className="card-head">
          <h2 style={{ fontSize: "var(--fs-md)" }}>Swap</h2>
          <SlippageControl />
        </div>

        <AmountField
          token={pair.tokenIn}
          counterpart={pair.tokenOut}
          balance={flow.balance}
          disabled={false}
        />

        <div className="reverse-wrap">
          <button type="button" className="reverse" onClick={reverse} aria-label="Reverse swap direction">
            <ArrowDown size={16} strokeWidth={2.5} aria-hidden="true" />
          </button>
        </div>

        {/* "You receive" is an output, never an input - the solver decides it. */}
        <div className="tokenfield">
          <div className="tokenfield-row">
            <span className={`out-amount${guaranteed === undefined ? " muted" : ""}`}>
              {quote.status === "quoting" && guaranteed === undefined ? (
                <span className="skeleton" style={{ width: 140, height: 30 }}>0</span>
              ) : (
                fmt(guaranteed, 4)
              )}
            </span>
            <TokenSelect side="out" selected={pair.tokenOut} counterpart={pair.tokenIn} onSwapSides={reverse} />
          </div>
          <div className="tokenfield-meta">
            <span>You receive at least</span>
            {flow.expectedOut !== undefined && (
              <span className="num">Expected {fmt(flow.expectedOut, 4)}</span>
            )}
          </div>
        </div>

        {/* ---- quote detail ---- */}
        {shouldShowRoute(stage) && flow.plan && (
          <div className="quote-block">
            <div className={`qrow${quote.isStale ? " is-stale" : ""}`}>
              <span>Rate</span>
              <span>
                1 {pair.tokenIn.symbol} ={" "}
                {flow.expectedOut !== undefined && quote.amountWei
                  ? (
                      Number(flow.expectedOut) / Number(quote.amountWei)
                    ).toFixed(5)
                  : "-"}{" "}
                {pair.tokenOut.symbol}
              </span>
            </div>
            <div className={`qrow${quote.isStale ? " is-stale" : ""}`}>
              <span>Max slippage</span>
              <span>{(pair.slippageBps / 100).toFixed(2)}%</span>
            </div>

            {/* Compact split here; the full diagram lives in the discovery column beside this
                card. Both render the same allocations, so they cannot disagree. */}
            <div className={`qrow${quote.isStale ? " is-stale" : ""}`} style={{ alignItems: "flex-start" }}>
              <span>Best route</span>
              <RouteAllocationBar allocations={allocations} />
            </div>
          </div>
        )}

        {/* ---- liquidity health, always tied to the amount being traded ---- */}
        {healthBand && !market.isError && (
          <div className="qrow">
            <span>Liquidity that can settle</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className="num">
                {fmt(market.totalExecutable)} {pair.tokenIn.symbol}
              </span>
              <span className={`badge ${TONE_CLASS[coverageTone(healthBand)]}`}>
                <span className="dot" />
                {healthBand.toLowerCase()}
              </span>
            </span>
          </div>
        )}

        <StatusArea flow={flow} />

        <button
          className="btn btn-primary btn-cta"
          onClick={stage === "disconnected" ? login : flow.submit}
          disabled={!state.canSubmit && !state.busy}
          aria-busy={state.busy}
        >
          {state.busy && <Loader2 className="spin" size={16} strokeWidth={2.5} aria-hidden="true" />}
          {state.label}
        </button>
      </div>
    </div>
  );
}

/** Everything between the quote and the button: warnings, failures, and non-error outcomes. */
function StatusArea({ flow }: { flow: ReturnType<typeof useSwapFlow> }) {
  const { state, failure, drift, quote } = flow;
  const pair = useTradePair();

  if (state.stage === "quote-unavailable") {
    return (
      <div className="notice notice-bad">
        <TriangleAlert size={16} aria-hidden="true" />
        <div>
          <strong>Can&apos;t reach the network</strong>
          <p>
            We couldn&apos;t get a quote.{" "}
            <button className="btn btn-ghost" style={{ minHeight: 0, padding: 0, color: "var(--accent)" }} onClick={quote.refetch}>
              Retry
            </button>
          </p>
        </div>
      </div>
    );
  }

  // NoRoute is an ordinary answer, not a failure. No alarm colouring, no retry loop.
  if (state.stage === "no-route") {
    const result = quote.result;
    return (
      <div className="notice">
        <ShieldAlert size={16} color="var(--text-dim)" aria-hidden="true" />
        <div>
          <strong>No executable route</strong>
          <p>
            {result?.kind === "no-route" ? (
              <>
                Only {fmt(result.totalExecutable)} {pair.tokenIn.symbol} can actually be settled right now,
                less than this trade needs. Try a smaller amount.
              </>
            ) : (
              <>There isn&apos;t enough liquidity that can settle this size. Try a smaller amount.</>
            )}
          </p>
        </div>
      </div>
    );
  }

  if (state.stage === "quote-updated" && drift.kind === "worse") {
    return (
      <div className="notice notice-warn">
        <TriangleAlert size={16} color="var(--warn)" aria-hidden="true" />
        <div>
          <strong>The quote changed</strong>
          <p>
            You&apos;d now receive about {(drift.dropBps / 100).toFixed(2)}% less than when you started.
            Review the new amount before swapping.
          </p>
        </div>
      </div>
    );
  }

  if (state.stage === "wrong-network") {
    return (
      <div className="notice notice-info">
        <TriangleAlert size={16} color="var(--info)" aria-hidden="true" />
        <div>
          <strong>Wrong network</strong>
          <p>Your wallet is connected elsewhere. Switch to continue.</p>
        </div>
      </div>
    );
  }

  if (failure) {
    return (
      <div className={`notice ${failure.isPhantomLiquidity ? "notice-warn" : "notice-bad"}`}>
        <ShieldAlert size={16} color={failure.isPhantomLiquidity ? "var(--warn)" : "var(--bad)"} aria-hidden="true" />
        <div>
          <strong>{failure.title}</strong>
          <p>{failure.detail}</p>
        </div>
      </div>
    );
  }

  return null;
}

function SuccessPanel({ flow }: { flow: ReturnType<typeof useSwapFlow> }) {
  const pair = useTradePair();
  const url = flow.settleHash ? txUrl(flow.settleHash) : null;

  return (
    <div className="swap">
      <div className="card">
        <div className="success">
          <span className="tick">
            <CheckCircle2 size={26} strokeWidth={2} aria-hidden="true" />
          </span>
          <h3>Swap complete</h3>

          <div className="amounts">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <TokenSigil symbol={pair.tokenIn.symbol} />
              {fmt(flow.signed?.amountWei, 4)} {pair.tokenIn.symbol}
            </span>
            <ArrowDown size={16} style={{ transform: "rotate(-90deg)" }} aria-hidden="true" />
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <TokenSigil symbol={pair.tokenOut.symbol} />
              {fmt(flow.signed?.minOut, 4)} {pair.tokenOut.symbol}
            </span>
          </div>

          <p className="dim" style={{ fontSize: "var(--fs-sm)" }}>
            Settled at your guaranteed minimum or better.
          </p>

          {flow.settleHash &&
            (url ? (
              <a className="txlink" href={url} target="_blank" rel="noreferrer">
                {shortHash(flow.settleHash)}
                <ExternalLink size={11} strokeWidth={2.5} aria-hidden="true" />
              </a>
            ) : (
              <span className="txlink">{shortHash(flow.settleHash)}</span>
            ))}
        </div>

        <button className="btn btn-primary btn-cta" onClick={flow.reset}>
          Swap again
        </button>
      </div>
    </div>
  );
}
