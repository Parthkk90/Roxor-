import { memo, useState } from "react";
import { ArrowDown, Diamond, Hexagon } from "lucide-react";

import type { SourceAllocation } from "../../market/derive";
import { coverageBand } from "../../market/coverage";
import type { StrategyMode } from "../../market/types";
import { fmt, fmtBps, type TokenDisplay } from "../../format";
import { bandColor } from "./CoverageIndicator";
import { CoverageIndicator } from "./CoverageIndicator";
import { StrategyDrawer } from "./StrategyDrawer";

const MODE_WORD: Record<StrategyMode, string> = {
  NORMAL: "Normal",
  DEFENSIVE: "Defensive",
  RECOVERY: "Recovering",
};
const MODE_COLOR: Record<StrategyMode, string> = {
  NORMAL: "var(--ok)",
  DEFENSIVE: "var(--bad)",
  RECOVERY: "var(--warn)",
};

/**
 * One liquidity source, used identically by the swap screen and the marketplace.
 *
 * There is exactly one of these because there is exactly one normalized `LiquiditySource`. Two
 * renderings of venue state was how the old build ended up with a swap panel and a marketplace
 * panel quoting different depths for the same block.
 *
 * The two venues are visually distinguished - sigil, wording, and what the detail link is called -
 * because they really are different things. Aqua is a maker's wallet lending you its balance; a v4
 * pool already holds its own reserves. Flattening them into identical rows hides a difference the
 * trader's risk actually depends on.
 *
 * Memoised: the marketplace renders several of these and they redraw only when their own source or
 * allocation changes, never when the amount field does.
 */
export const LiquiditySourceCard = memo(function LiquiditySourceCard({
  allocation,
  tokenIn,
  tokenOut,
  compact = false,
}: {
  allocation: SourceAllocation;
  tokenIn: TokenDisplay;
  tokenOut: TokenDisplay;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { source } = allocation;
  const isAqua = source.key === "aqua";

  if (source.unavailable) {
    return (
      <article className="lsc lsc-dead">
        <header className="lsc-head">
          <span className="lsc-id">
            <SourceSigil isAqua={isAqua} />
            <span>
              <strong>{source.name}</strong>
              <span className="lsc-kind">{source.venueKind}</span>
            </span>
          </span>
          <span className="badge badge-bad">
            <span className="dot" />
            Unavailable
          </span>
        </header>
        <p className="dim" style={{ fontSize: "var(--fs-sm)" }}>
          We couldn&apos;t verify this source&apos;s liquidity, so nothing is being routed to it.
        </p>
      </article>
    );
  }

  const { snapshot, executable } = source;
  if (!snapshot || !executable) {
    return (
      <article className="lsc">
        <span className="skeleton" style={{ height: 20, width: "50%" }} />
        <span className="skeleton" style={{ height: 38, width: "70%" }} />
        <span className="skeleton" style={{ height: 48 }} />
      </article>
    );
  }

  const band = coverageBand(executable.coverageBps);
  const hasGap = executable.virtualLiquidity > executable.conditionalLiquidity;
  const dry = executable.conditionalLiquidity === 0n;

  return (
    <>
      <article
        className={`lsc${allocation.included ? " lsc-used" : ""}${dry ? " lsc-dead" : ""}`}
        style={allocation.included ? { borderColor: bandColor(band) } : undefined}
      >
        <header className="lsc-head">
          <span className="lsc-id">
            <SourceSigil isAqua={isAqua} />
            <span>
              <strong>{source.name}</strong>
              <span className="lsc-kind">{isAqua ? "Maker liquidity" : "Live pool liquidity"}</span>
            </span>
          </span>
          <span className="badge" style={{ color: MODE_COLOR[snapshot.mode], borderColor: "currentColor" }}>
            <span className="dot" />
            {MODE_WORD[snapshot.mode]}
          </span>
        </header>

        {/* Executable is the headline. Advertised is shown beneath it, struck, with an arrow - the
            gap has to read as a reduction, not as two unrelated numbers. */}
        <div className="lsc-depth">
          <span className="label">Executable liquidity</span>
          <span className="lsc-figure">
            {fmt(executable.conditionalLiquidity, tokenIn.decimals)} <em>{tokenIn.symbol}</em>
          </span>
          {hasGap && (
            <span className="lsc-gap">
              <span className="lsc-advertised">{fmt(executable.virtualLiquidity, tokenIn.decimals)}</span>{" "}
              advertised
              <ArrowDown size={12} strokeWidth={2.5} aria-hidden="true" />
              <b>{fmt(executable.conditionalLiquidity, tokenIn.decimals)}</b> can actually be paid
            </span>
          )}
        </div>

        <CoverageIndicator bps={executable.coverageBps} size={compact ? "sm" : "md"} />

        <div className="lsc-metrics">
          <span className="metric">
            <span className="k">Fee</span>
            <span className="v">{fmtBps(snapshot.spreadBps)}</span>
          </span>
          <span className="metric">
            <span className="k">Reliability</span>
            {/* "-" when the index isn't configured, never 0% - they mean opposite things. */}
            <span className="v">
              {source.reliabilityBps === undefined ? "-" : fmtBps(source.reliabilityBps, 1)}
            </span>
          </span>
          <span className="metric">
            <span className="k">This trade</span>
            <span className="v" style={allocation.included ? { color: bandColor(band) } : undefined}>
              {allocation.included ? `${allocation.sharePct.toFixed(0)}%` : "-"}
            </span>
          </span>
        </div>

        <button type="button" className="btn btn-ghost lsc-more" onClick={() => setOpen(true)}>
          {isAqua ? "View strategy" : "View pool"}
        </button>
      </article>

      <StrategyDrawer
        open={open}
        onClose={() => setOpen(false)}
        allocation={allocation}
        tokenIn={tokenIn}
        tokenOut={tokenOut}
      />
    </>
  );
});

function SourceSigil({ isAqua }: { isAqua: boolean }) {
  return (
    <span className={`lsc-sigil ${isAqua ? "lsc-sigil-aqua" : "lsc-sigil-uni"}`} aria-hidden="true">
      {isAqua ? <Hexagon size={15} strokeWidth={2.25} /> : <Diamond size={15} strokeWidth={2.25} />}
    </span>
  );
}
