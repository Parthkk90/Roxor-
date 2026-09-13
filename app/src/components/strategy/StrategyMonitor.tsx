import { DetailRow } from "../ui/Drawer";
import { addressUrl, shortHash } from "../../chain/explorer";
import { fmt, fmtBps, fmtDuration, fmtToken, type TokenDisplay } from "../../format";
import { describeAction, describeCondition } from "../../strategy/decode";
import { recoveryProgress, useChainNow, type LiveStrategy } from "../../strategy/useStrategy";
import type { StrategyMode } from "../../market/types";

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
 * The live strategy, entirely from chain.
 *
 * Two things here are worth being precise about:
 *
 * - The rules listed are decoded from `REGISTRY.getRuleProgram`, so they are *this* strategy's
 *   thresholds. The previous build deliberately showed no per-state multipliers because the venue
 *   ABI did not expose them; reading the program is what makes showing them honest rather than a
 *   guess sitting next to chain-read figures.
 * - The recovery clock is driven by `RuntimeState.armedSince`, which the engine sets when the
 *   duration-gated rule *first* evaluated true and clears the moment the condition lapses. A bar
 *   that just counted wall-clock since the last transition would keep filling through a market
 *   that never actually calmed down.
 */
export function StrategyMonitor({ strategy, token }: { strategy: LiveStrategy; token: TokenDisplay }) {
  const now = useChainNow();
  const progress = now === undefined ? undefined : recoveryProgress(strategy, now);
  const explorer = addressUrl(strategy.registry);

  return (
    <>
      <section className="mcond" style={{ marginTop: "var(--s5)" }}>
        <header className="mcond-head">
          <span className="label">Current regime</span>
          <span className="badge" style={{ color: MODE_COLOR[strategy.mode], borderColor: "currentColor" }}>
            <span className="dot" />
            {MODE_WORD[strategy.mode]}
            {!strategy.active && " · deactivated"}
          </span>
        </header>

        <div className="mcond-grid strat-grid">
          <Figure
            label="Liquidity multiplier"
            value={fmtBps(strategy.liquidityBps, 0)}
            hint="Share of deliverable liquidity this strategy is currently willing to quote."
          />
          <Figure label="Spread" value={fmtBps(strategy.spreadBps)} />
          <Figure
            label="Executable liquidity"
            value={strategy.executable ? fmtToken(strategy.executable.conditionalLiquidity, token) : "-"}
            hint="Deliverable liquidity after the multiplier - the only figure a route may allocate against."
          />
          <Figure
            label="Market value"
            value={
              strategy.market
                ? `${fmt(strategy.market.price, 18, 2)} - vol ${fmtBps(strategy.market.volatilityBps, 0)}`
                : "-"
            }
            hint="What the market-state provider is currently telling the engine."
          />
        </div>
      </section>

      {/* ---- recovery ---- */}
      <section className="dsec">
        <span className="label">Recovery requirement</span>
        {strategy.recovery === undefined ? (
          <p className="dim">This strategy has no sustained-calm rule.</p>
        ) : (
          <p className="dim" style={{ fontSize: "var(--fs-sm)", lineHeight: 1.6 }}>
            Liquidity only starts coming back once volatility has stayed below{" "}
            <strong>{fmtBps(strategy.recovery.thresholdBps, 0)}</strong> for{" "}
            <strong>{fmtDuration(strategy.recovery.seconds)}</strong> without interruption.
          </p>
        )}

        {progress ? (
          <>
            <div
              className="nopl-track nopl-track-final"
              role="img"
              aria-label={`${progress.elapsed} of ${progress.required} seconds of calm elapsed`}
            >
              <i style={{ width: `${Math.min(100, (progress.elapsed / progress.required) * 100)}%` }} />
            </div>
            <span className="label">
              Recovery timer: {fmtDuration(progress.remaining)} of calm still required
            </span>
          </>
        ) : (
          <span className="label">
            {strategy.mode === "DEFENSIVE"
              ? "Recovery timer: not counting - the market is not calm enough yet."
              : "Recovery timer: idle."}
          </span>
        )}
      </section>

      {/* ---- the actual rule program ---- */}
      <section className="dsec">
        <span className="label">Rules, decoded from the registered program</span>
        {strategy.program === undefined ? (
          <p className="dim">This build cannot decode this strategy&apos;s rule program.</p>
        ) : (
          <ol className="rules">
            {strategy.program.rules.map((rule, i) => (
              <li key={i} className="rule">
                <span className="rule-when">
                  when {rule.conditions.map(describeCondition).join(" and ")}
                  {rule.durationSeconds > 0 && ` for ${fmtDuration(rule.durationSeconds)}`}
                </span>
                <span className="rule-then">{rule.actions.map(describeAction).join(", ")}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="faint" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.55 }}>
          The engine takes the first rule whose conditions all hold, and at most one rule may fire
          per evaluation. Order is therefore meaningful: a relapse rule written above a recovery
          timer beats it.
        </p>
      </section>

      <details className="disclose dsec-details">
        <summary>Technical details</summary>
        <div className="dlist" style={{ paddingTop: "var(--s3)" }}>
          <DetailRow k="Strategy id" v={shortHash(strategy.strategyId)} mono />
          <DetailRow k="Maker" v={shortHash(strategy.maker)} mono />
          <DetailRow
            k="Registry"
            v={
              explorer ? (
                <a href={explorer} target="_blank" rel="noreferrer">
                  {shortHash(strategy.registry)}
                </a>
              ) : (
                shortHash(strategy.registry)
              )
            }
            mono
          />
          <DetailRow k="Engine" v={shortHash(strategy.engine)} mono />
          <DetailRow k="Base liquidity" v={`${strategy.baseLiquidityBps} bps`} mono />
          <DetailRow k="Base spread" v={`${strategy.baseSpreadBps} bps`} mono />
          <DetailRow k="Transitions so far" v={String(strategy.transitionCount)} mono />
          <DetailRow
            k="Last transition"
            v={strategy.lastTransition === 0 ? "-" : new Date(strategy.lastTransition * 1000).toISOString()}
            mono
          />
          <DetailRow
            k="Armed rule"
            v={strategy.armedRule === 0 ? "none" : `rule ${strategy.armedRule} since ${new Date(strategy.armedSince * 1000).toISOString()}`}
            mono
            hint="The duration-gated rule currently counting down, as the engine recorded it."
          />
          <DetailRow k="Oracle confidence" v={strategy.market ? `${strategy.market.oracleConfidenceBps} bps` : "-"} mono />
        </div>
      </details>
    </>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="strat-cell">
      <span className="label" title={hint}>
        {label}
      </span>
      <span className="mcond-big">{value}</span>
    </div>
  );
}
