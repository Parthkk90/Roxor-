import { memo } from "react";

import { depthLayers } from "../../market/derive";
import type { LiquiditySource } from "../../market/types";
import { fmt } from "../../format";

/**
 * The four depth layers on one shared axis.
 *
 * This is the product's central claim drawn as a picture: each bar can only be shorter than the one
 * above it, because the chain derives each from the last. Advertised is the promise; conditional is
 * what a route may actually allocate against. Showing them stacked on a common scale is what makes
 * the gap impossible to misread as "nearly the same number".
 *
 * Every value is read from `executableLiquidity` - nothing here is modelled or estimated.
 */
export const DepthChart = memo(function DepthChart({
  source,
  symbol,
}: {
  source: LiquiditySource;
  symbol: string;
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
    },
    {
      k: "In the wallet",
      v: layers.wallet,
      cls: "depth-wallet",
      note: "What it actually holds right now",
    },
    {
      k: "Deliverable",
      v: layers.deliverable,
      cls: "depth-deliverable",
      note: "The smallest of advertised, held and permitted",
    },
    {
      k: "Executable",
      v: layers.conditional,
      cls: "depth-executable",
      note: "After the strategy's current limit - the only depth a route may use",
    },
  ];

  return (
    <div className="depthchart">
      {rows.map((row) => (
        <div className="depthrow" key={row.k}>
          <div className="depthrow-head">
            <span>{row.k}</span>
            <b className="num">
              {fmt(row.v)} {symbol}
            </b>
          </div>
          <div className={`depthrow-track ${row.cls}`}>
            <i style={{ width: width(row.v) }} />
          </div>
          <span className="depthrow-note">{row.note}</span>
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
  symbol,
}: {
  sources: LiquiditySource[];
  total: bigint;
  symbol: string;
}) {
  const usable = sources.filter((s) => (s.executable?.conditionalLiquidity ?? 0n) > 0n);
  if (total === 0n || usable.length === 0) return null;

  return (
    <div className="mdepth">
      <div className="mdepth-bar" role="img" aria-label={`Executable depth by source, total ${fmt(total)} ${symbol}`}>
        {usable.map((source, i) => {
          const share = Number((source.executable!.conditionalLiquidity * 10_000n) / total) / 100;
          return (
            <span
              key={source.key}
              className={`mdepth-seg mdepth-seg-${i % 3}`}
              style={{ flexGrow: Math.max(share, 0.5) }}
              title={`${source.name}: ${fmt(source.executable!.conditionalLiquidity)} ${symbol}`}
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
                {fmt(source.executable!.conditionalLiquidity)} {symbol}
              </b>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
});
