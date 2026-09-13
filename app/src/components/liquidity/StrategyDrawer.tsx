import { currentLiquidityBps, type SourceAllocation } from "../../market/derive";
import { coverageBand, coverageMeaning } from "../../market/coverage";
import { STRATEGY_MODES, type StrategyMode } from "../../market/types";
import { addressUrl, shortHash } from "../../chain/explorer";
import { fmt, fmtBps, fmtRate, fmtToken, type TokenDisplay } from "../../format";
import { href } from "../../nav/useNav";
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
 * Ordered as progressive disclosure, not as a data dump: what state it is in, then how much it can
 * actually pay and why that number is what it is, then how reliable it has been, then this trade's
 * share - and only then, collapsed, the addresses and raw bps a technical reader wants.
 *
 * The state machine is the *shape* of the strategy - three states and the transitions between them
 * - with the live one highlighted from `snapshot.mode`. What it deliberately does NOT show is a
 * percentage against each state: those multipliers live in the compiled rule program, which the
 * venue ABI does not expose. Printing "NORMAL 100% / DEFENSIVE 25%" here would be a plausible guess
 * sitting beside chain-read figures, which is the one thing this product must never do.
 *
 * They are not unknowable, only unavailable *here*: the Strategy screen reads the program itself
 * back from `ConditionalLiquidityRegistry.getRuleProgram` and decodes it, so it can state this
 * strategy's real thresholds. This drawer stays scoped to what a venue can answer about itself and
 * links across rather than duplicating that read on the trade surface.
 *
 * The two venues are genuinely different and the drawer says so rather than flattening them. Aqua
 * is a maker lending you their wallet balance, so solvency is the whole story; a v4 pool already
 * holds its reserves in custody, so there is no third party to run dry and the interesting facts
 * are the pool's own.
 */
export function StrategyDrawer({
  open,
  onClose,
  allocation,
  tokenIn,
  tokenOut,
}: {
  open: boolean;
  onClose: () => void;
  allocation: SourceAllocation;
  tokenIn: TokenDisplay;
  tokenOut: TokenDisplay;
}) {
  const { source } = allocation;
  const snapshot = source.snapshot;
  const executable = source.executable;
  const liquidityBps = currentLiquidityBps(source);
  const explorer = addressUrl(source.address);
  const isAqua = source.key === "aqua";

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

          {/* ---- the waterfall: the single most important thing in this drawer ---- */}
          <section className="dsec">
            <h3 className="dsec-title">How much can actually be paid out?</h3>
            <DepthChart source={source} token={tokenIn} strategyBps={liquidityBps} />
          </section>

          {/* ---- coverage, stated in words as well as a bar ---- */}
          <section className="dsec">
            <span className="label">Coverage</span>
            <CoverageIndicator bps={executable.coverageBps} size="lg" />
            <p className="cov-note">
              Only <b>{fmtBps(executable.coverageBps)}</b> of advertised liquidity can currently be
              delivered. {coverageMeaning(coverageBand(executable.coverageBps))}
            </p>
            {isAqua ? (
              <p className="faint" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.55 }}>
                Aqua balances are an allowance against a maker&apos;s own wallet, not tokens held in
                custody. The maker can spend or un-approve them at any moment, which is exactly why
                the figure above is checked rather than trusted.
              </p>
            ) : (
              <p className="faint" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.55 }}>
                A pool holds its reserves itself, so there is no third party to run dry and no
                approval to revoke. Coverage is computed the same way regardless, so a pool and a
                maker can be compared on one honest scale.
              </p>
            )}
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
                        <span className="machine-pct">{fmtBps(liquidityBps)} of deliverable</span>
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
            <a className="btn" href={href("strategy")} onClick={onClose}>
              See this strategy&apos;s rules
            </a>
            <p className="faint" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.55 }}>
              The thresholds behind these states, decoded from the rule program the registry stores -
              plus the recovery timer, and the form for registering a strategy of your own.
            </p>
          </section>

          {/* ---- pricing, which is where the two venues genuinely differ ---- */}
          <section className="dsec">
            <span className="label">{isAqua ? "Maker pricing" : "Pool"}</span>
            <div className="dlist">
              <DetailRow
                k="Price"
                v={`1 ${tokenIn.symbol} = ${fmtRate(10n ** BigInt(tokenIn.decimals), snapshot.referencePrice, tokenIn, tokenOut)} ${tokenOut.symbol}`}
                mono
                hint={
                  isAqua
                    ? "Aqua's own reserve ratio - what the curve actually prices against."
                    : "The pool's live spot price, read from its slot0."
                }
              />
              <DetailRow k="Fee" v={fmtBps(snapshot.spreadBps)} mono />
              <DetailRow
                k={isAqua ? "Maker inventory held" : "Pool reserves held"}
                v={fmtToken(executable.walletLiquidity, tokenIn)}
                mono
              />
              <DetailRow
                k="Allowance"
                v={
                  executable.allowance >= 2n ** 255n
                    ? "Not applicable"
                    : fmtToken(executable.allowance, tokenIn)
                }
                mono
                hint={
                  isAqua
                    ? "What the maker has approved Aqua to pull from their wallet."
                    : "A pool holds its own reserves, so no allowance can bind."
                }
              />
            </div>
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
                  <DetailRow k="Amount routed here" v={fmtToken(allocation.amountIn, tokenIn)} mono />
                  <DetailRow k="Expected out" v={fmtToken(allocation.expectedOut, tokenOut)} mono />
                </>
              )}
              <DetailRow
                k="Reliability"
                v={source.reliabilityBps === undefined ? "-" : fmtBps(source.reliabilityBps, 1)}
                mono
                hint="Historical fill rate from the index. Shown only when that index is available."
              />
            </div>
          </section>

          {/* ---- technical, last and collapsed ---- */}
          <details className="disclose dsec-details">
            <summary>Technical details</summary>
            <div className="dlist" style={{ paddingTop: "var(--s3)" }}>
              <DetailRow k="Reference price (WAD)" v={fmt(snapshot.referencePrice, 18, 6)} mono />
              <DetailRow k="Spread" v={`${snapshot.spreadBps} bps`} mono />
              <DetailRow
                k="Liquidity limit"
                v={liquidityBps === undefined ? "-" : `${liquidityBps} bps`}
                mono
                hint="Derived: conditionalLiquidity / deliverableLiquidity"
              />
              <DetailRow k="Coverage" v={`${executable.coverageBps} bps`} mono />
              <DetailRow k="Virtual liquidity" v={fmtToken(executable.virtualLiquidity, tokenIn)} mono />
              <DetailRow k="Wallet liquidity" v={fmtToken(executable.walletLiquidity, tokenIn)} mono />
              <DetailRow k="Deliverable" v={fmtToken(executable.deliverableLiquidity, tokenIn)} mono />
              <DetailRow k="Conditional" v={fmtToken(executable.conditionalLiquidity, tokenIn)} mono />
              <DetailRow
                k="Effective liquidity"
                v={fmtToken(snapshot.effectiveLiquidity, tokenIn)}
                mono
                hint="What the Solver reads. Always equal to the conditional figure above."
              />
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
