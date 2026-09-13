import { memo } from "react";

import { depthLayers } from "../../market/derive";
import type { LiquiditySource } from "../../market/types";
import { fmt, fmtBps, type TokenDisplay } from "../../format";

/**
 * "How much can actually be paid out?" - the product's central claim, drawn as a picture.
 *
 * Each bar can only be shorter than the one above it, because the chain derives each from the last.
 * Advertised is the promise; executable is what a route may allocate against. Sharing one axis is
 * what makes the gap impossible to misread as "nearly the same number".
 *
 * The first and last rows are deliberately emphasised over the two in between: those two are the
 * *claim* and the *answer*, and the middle rows are the working. A reader who takes only the top
 * and bottom line away has taken away the right thing.
 *
 * Every value is read from `executableLiquidity` - nothing here is modelled or estimated.
 */
export const DepthChart = memo(function DepthChart({
  source,
  token,
  strategyBps,
}: {
  source: LiquiditySource;
  token: TokenDisplay;
  /** The strategy's live multiplier, shown as the step between deliverable and executable. */
  strategyBps?: number;
}) {
  const layers = depthLayers(source);
  if (!layers) return null;

  const scale = layers.scale === 0n ? 1n : layers.scale;
  const width = (v: bigint) => `${Math.min(100, Number((v * 10_000n) / scale) / 100)}%`;

  const rows = [
    {
      k: "Advertised",
      v: layers.advertised,
      cls: "depth-advertised",
      note: "What this source says it will trade",
      emphasis: true,
    },
    {
      k: "In the wallet",
      v: layers.wallet,
      cls: "depth-wallet",
      note: "What it actually holds right now",
      emphasis: false,
    },
    {
      k: "Deliverable",
      v: layers.deliverable,
      cls: "depth-deliverable",
      note: "The smallest of advertised, held and permitted",
      emphasis: false,
    },
    {
      k: "Executable",
      v: layers.conditional,
      cls: "depth-executable",
      note:
        strategyBps === undefined
          ? "After the strategy's current limit - the only depth a route may use"
          : `Deliverable at the strategy's current limit of ${fmtBps(strategyBps)} - the only depth a route may use`,
      emphasis: true,
    },
  ];

  return (
    <div className="depthchart">
      {rows.map((row, i) => (
        <div className={`depthrow${row.emphasis ? " depthrow-key" : ""}`} key={row.k}>
          <div className="depthrow-head">
            <span>{row.k}</span>
            <b className="num">
              {fmt(row.v, token.decimals)} {token.symbol}
            </b>
          </div>
          <div className={`depthrow-track ${row.cls}`}>
            <i style={{ width: width(row.v) }} />
          </div>
          <span className="depthrow-note">{row.note}</span>
          {/* The multiplier is the one step that is a strategy decision rather than an arithmetic
              minimum, so it is labelled on the edge between the two rows it applies to. */}
          {i === 2 && strategyBps !== undefined && strategyBps < 10_000 && (
            <span className="depthrow-op">x {fmtBps(strategyBps)} strategy limit</span>
          )}
        </div>
      ))}
    </div>
  );
});

/**
 * Whole-market depth, split by source.
 *
 * One bar per source, sized against total executable depth, so "who has the liquidity" reads at a
 * glance before any number is parsed.
 */
export const MarketDepthBar = memo(function MarketDepthBar({
  sources,
  total,
  token,
}: {
  sources: LiquiditySource[];
  total: bigint;
  token: TokenDisplay;
}) {
  const usable = sources.filter((s) => (s.executable?.conditionalLiquidity ?? 0n) > 0n);
  if (total === 0n || usable.length === 0) return null;

  return (
    <div className="mdepth">
      <div
        className="mdepth-bar"
        role="img"
        aria-label={`Executable depth by source, total ${fmt(total, token.decimals)} ${token.symbol}`}
      >
        {usable.map((source, i) => {
          const share = Number((source.executable!.conditionalLiquidity * 10_000n) / total) / 100;
          return (
            <span
              key={source.key}
              className={`mdepth-seg mdepth-seg-${i % 3}`}
              style={{ flexGrow: Math.max(share, 0.5) }}
              title={`${source.name}: ${fmt(source.executable!.conditionalLiquidity, token.decimals)} ${token.symbol}`}
            />
          );
        })}
      </div>
      <div className="mdepth-keys">
        {usable.map((source, i) => (
          <span className="route-key" key={source.key}>
            <i className={`mdepth-dot-${i % 3}`} />
            <span>
              {source.name}{" "}
              <b className="num">
                {fmt(source.executable!.conditionalLiquidity, token.decimals)} {token.symbol}
              </b>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
});
