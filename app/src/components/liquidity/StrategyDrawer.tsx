import { formatUnits } from "viem";

import { currentLiquidityBps, type SourceAllocation } from "../../market/derive";
import { STRATEGY_MODES, type StrategyMode } from "../../market/types";
import { addressUrl, shortHash } from "../../chain/explorer";
import { fmt } from "../../format";
import { Drawer, DetailRow } from "../ui/Drawer";
import { CoverageIndicator } from "./CoverageIndicator";
import { DepthChart } from "./DepthChart";

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

const MODE_MEANING: Record<StrategyMode, string> = {
  NORMAL: "Trading at full size. Market conditions are within this strategy's normal range.",
  DEFENSIVE:
    "Liquidity is currently reduced because the strategy is protecting against elevated market risk.",
  RECOVERY:
    "Liquidity is being restored after elevated risk. The strategy waits for calm to hold before returning to full size.",
};

/**
 * Everything one source will tell us, behind one deliberate click.
 *
 * The state machine below is the *shape* of the strategy - three states and the transitions between
 * them - with the live one highlighted from `snapshot.mode`. What it deliberately does NOT show is
 * a percentage against each state: those multipliers live in the compiled rule program, which the
 * venue ABI does not expose. Printing "NORMAL 100% / DEFENSIVE 25%" here would be a plausible
 * guess sitting beside chain-read figures, which is the one thing this product must never do.
 *
 * What *is* shown is the current multiplier, derived from two real figures
 * (`conditional ÷ deliverable`). That is the number that actually moves when a strategy reacts.
 */
export function StrategyDrawer({
  open,
  onClose,
  allocation,
  symbolIn,
  symbolOut,
}: {
  open: boolean;
  onClose: () => void;
  allocation: SourceAllocation;
  symbolIn: string;
  symbolOut: string;
}) {
  const { source } = allocation;
  const snapshot = source.snapshot;
  const executable = source.executable;
  const liquidityBps = currentLiquidityBps(source);
  const explorer = addressUrl(source.address);

  return (
    <Drawer open={open} onClose={onClose} title={source.name} subtitle={source.venueKind}>
      {!snapshot || !executable ? (
        <p className="dim">This source&apos;s live state couldn&apos;t be read.</p>
      ) : (
        <>
          {/* ---- headline: mode + what it means ---- */}
          <section className="dsec">
            <span className="badge" style={{ color: MODE_COLOR[snapshot.mode], borderColor: "currentColor" }}>
              <span className="dot" />
              {MODE_WORD[snapshot.mode]}
            </span>
            <p className="dim" style={{ fontSize: "var(--fs-sm)", lineHeight: 1.6 }}>
              {MODE_MEANING[snapshot.mode]}
            </p>
          </section>

          {/* ---- state machine ---- */}
          <section className="dsec">
            <span className="label">Strategy states</span>
            <div className="machine">
              {STRATEGY_MODES.map((mode, i) => {
                const active = mode === snapshot.mode;
                return (
                  <div key={mode} className="machine-step">
                    <div
                      className={`machine-node${active ? " machine-node-on" : ""}`}
                      style={active ? { borderColor: MODE_COLOR[mode], color: MODE_COLOR[mode] } : undefined}
                      aria-current={active ? "true" : undefined}
                    >
                      <span className="machine-name">{MODE_WORD[mode]}</span>
                      {active && liquidityBps !== undefined && (
                        <span className="machine-pct">{(liquidityBps / 100).toFixed(0)}% of deliverable</span>
                      )}
                      {active && <span className="machine-now">Current</span>}
                    </div>
                    {i < STRATEGY_MODES.length - 1 && (
                      <span className="machine-arrow" aria-hidden="true">
                        {i === 0 ? "volatility rises" : "calm holds"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="faint" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.55 }}>
              Liquidity here is conditional. This source can reduce how much of its balance is usable when
              conditions get riskier, and restores it only once calm has held. The percentage shown is its
              current limit, derived from live figures.
            </p>
          </section>

          {/* ---- depth layers ---- */}
          <section className="dsec">
            <span className="label">How much can actually be paid out</span>
            <DepthChart source={source} symbol={symbolIn} />
          </section>

          {/* ---- coverage ---- */}
          <section className="dsec">
            <span className="label">Coverage</span>
            <CoverageIndicator bps={executable.coverageBps} size="lg" explain />
          </section>

          {/* ---- route contribution ---- */}
          <section className="dsec">
            <span className="label">This trade</span>
            <div className="dlist">
              <DetailRow
                k="Route allocation"
                v={allocation.included ? `${allocation.sharePct.toFixed(0)}%` : "Not used"}
              />
              {allocation.included && (
                <>
                  <DetailRow k="Amount routed here" v={`${fmt(allocation.amountIn)} ${symbolIn}`} mono />
                  <DetailRow k="Expected out" v={`${fmt(allocation.expectedOut)} ${symbolOut}`} mono />
                </>
              )}
              <DetailRow k="Fee" v={`${(snapshot.spreadBps / 100).toFixed(2)}%`} mono />
              <DetailRow
                k="Reliability"
                v={source.reliabilityBps === undefined ? "-" : `${(source.reliabilityBps / 100).toFixed(1)}%`}
                mono
                hint="Historical fill rate from the index. Shown only when that index is available."
              />
            </div>
          </section>

          {/* ---- technical, last and collapsed ---- */}
          <details className="disclose dsec-details">
            <summary>Technical details</summary>
            <div className="dlist" style={{ paddingTop: "var(--s3)" }}>
              <DetailRow k="Reference price" v={formatUnits(snapshot.referencePrice, 18)} mono />
              <DetailRow k="Spread" v={`${snapshot.spreadBps} bps`} mono />
              <DetailRow
                k="Liquidity limit"
                v={liquidityBps === undefined ? "-" : `${liquidityBps} bps`}
                mono
                hint="Derived: conditionalLiquidity ÷ deliverableLiquidity"
              />
              <DetailRow k="Coverage" v={`${executable.coverageBps} bps`} mono />
              <DetailRow k="Virtual liquidity" v={fmt(executable.virtualLiquidity)} mono />
              <DetailRow k="Wallet liquidity" v={fmt(executable.walletLiquidity)} mono />
              <DetailRow k="Allowance" v={fmt(executable.allowance)} mono />
              <DetailRow k="Deliverable" v={fmt(executable.deliverableLiquidity)} mono />
              <DetailRow k="Conditional" v={fmt(executable.conditionalLiquidity)} mono />
              <DetailRow k="Effective liquidity" v={fmt(snapshot.effectiveLiquidity)} mono />
              <DetailRow k="Strategy id" v={shortHash(snapshot.strategyId)} mono />
              <DetailRow
                k="Venue"
                v={
                  explorer ? (
                    <a href={explorer} target="_blank" rel="noreferrer">
                      {shortHash(source.address)}
                    </a>
                  ) : (
                    shortHash(source.address)
                  )
                }
                mono
              />
            </div>
          </details>
        </>
      )}
    </Drawer>
  );
}
