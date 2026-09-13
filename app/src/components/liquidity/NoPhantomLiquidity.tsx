import { useState } from "react";
import { ShieldCheck } from "lucide-react";

import { depthLayers } from "../../market/derive";
import type { LiquiditySource } from "../../market/types";
import { fmt } from "../../format";
import { Drawer } from "../ui/Drawer";

/**
 * The product's core promise, as a thing you can click and audit.
 *
 * The explainer walks the same four figures the chain walks, in the same order, using the live
 * values for a real source - so it is a demonstration rather than a description. Each step can only
 * make the number smaller, and seeing that happen to actual figures is what turns
 * "no phantom liquidity" from a slogan into something the visitor has checked for themselves.
 */
export function NoPhantomLiquidity({
  sources,
  symbol,
}: {
  sources: LiquiditySource[];
  symbol: string;
}) {
  const [open, setOpen] = useState(false);

  // Prefer a source that actually shows a shortfall - the mechanism is invisible on a source whose
  // numbers happen to be identical at every layer.
  const readable = sources.filter((s) => s.executable && !s.unavailable);
  const example =
    readable.find((s) => s.executable!.virtualLiquidity > s.executable!.conditionalLiquidity) ?? readable[0];

  return (
    <>
      <button type="button" className="nopl-chip" onClick={() => setOpen(true)}>
        <ShieldCheck size={14} strokeWidth={2.25} aria-hidden="true" />
        No phantom liquidity
        <span className="nopl-how">How?</span>
      </button>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="How we verify liquidity"
        subtitle="Every quote, before you see it"
      >
        <p className="dim" style={{ fontSize: "var(--fs-sm)", lineHeight: 1.65 }}>
          A source can advertise more than it can pay. We check what it can really settle, and route only
          that. Each step below can only reduce the number - never raise it.
        </p>

        {example?.executable ? (
          <Steps source={example} symbol={symbol} />
        ) : (
          <p className="dim" style={{ fontSize: "var(--fs-sm)" }}>
            Live figures aren&apos;t available right now, so we can&apos;t walk through a real example.
          </p>
        )}

        <div className="nopl-final">
          <ShieldCheck size={16} strokeWidth={2.25} aria-hidden="true" />
          <span>
            <strong>Only executable liquidity is routed.</strong>
            <p>
              The contract re-checks all of this again at the moment of settlement. If anything changed,
              the whole trade is cancelled rather than partly filled.
            </p>
          </span>
        </div>
      </Drawer>
    </>
  );
}

function Steps({ source, symbol }: { source: LiquiditySource; symbol: string }) {
  const layers = depthLayers(source)!;
  const scale = layers.scale === 0n ? 1n : layers.scale;
  const w = (v: bigint) => `${Math.min(100, Number((v * 10_000n) / scale) / 100)}%`;

  const steps = [
    {
      k: "Advertised liquidity",
      v: layers.advertised,
      why: `What ${source.name} says it will trade.`,
    },
    {
      k: "Maker wallet balance",
      v: layers.wallet,
      why: "What it actually holds. On a maker source the tokens never left their wallet.",
    },
    {
      k: "Maker allowance",
      v: layers.allowance,
      why: "How much it has given permission to spend. It can withdraw this at any time.",
    },
    {
      k: "Deliverable",
      v: layers.deliverable,
      why: "The smallest of the three above. Anything more would fail on settlement.",
    },
    {
      k: "Executable",
      v: layers.conditional,
      why: "After the strategy's current risk limit. This is the only figure a route may use.",
    },
  ];

  return (
    <div className="nopl-steps">
      <span className="label">Live example · {source.name}</span>
      {steps.map((step, i) => (
        <div className="nopl-step" key={step.k}>
          <span className="nopl-n">{i + 1}</span>
          <div className="nopl-body">
            <span className="nopl-k">
              {step.k}
              <b className="num">
                {fmt(step.v)} {symbol}
              </b>
            </span>
            <span className={`nopl-track${i === steps.length - 1 ? " nopl-track-final" : ""}`}>
              <i style={{ width: w(step.v) }} />
            </span>
            <span className="nopl-why">{step.why}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
