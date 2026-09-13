import { useMemo, useState } from "react";
import { useAccount } from "wagmi";

import { Drawer, DetailRow } from "../ui/Drawer";
import { txUrl, shortHash } from "../../chain/explorer";
import type { MarketAddresses } from "../../config/markets";
import { DEFAULT_PARAMS, validateParams, type StrategyParams } from "../../strategy/params";
import { describeAction, describeCondition, decodeProgram } from "../../strategy/decode";
import { previewRegistration, useRegisterStrategy } from "../../strategy/useRegisterStrategy";
import { StrategyPreview } from "./StrategyPreview";
import { fmtDuration } from "../../format";
import { useStrategy } from "../../strategy/useStrategy";

/**
 * The maker's configuration surface.
 *
 * Every control here maps to an operand in the rule program that gets registered - there is no
 * setting that only the frontend understands. The preview underneath is not a mock-up of what the
 * strategy will do: it is the emitted bytecode, decoded back through the same decoder the monitor
 * uses on the live strategy, so what a maker reads before signing is literally what the engine will
 * execute afterwards.
 *
 * What is intentionally *not* offered is an arbitrary rule editor. The protocol's rule program can
 * express far more than these five knobs, but every additional degree of freedom in a browser form
 * is another way to register something valid and nonsensical. The shape is fixed to the volatility
 * shield; the thresholds are the maker's.
 */
const FIELDS: {
  key: keyof StrategyParams;
  label: string;
  hint: string;
  unit: "pct" | "seconds";
}[] = [
  { key: "enterDefensiveBps", label: "Defensive volatility threshold", hint: "Pull back at or above this volatility.", unit: "pct" },
  { key: "defensiveLiquidityBps", label: "Defensive liquidity", hint: "Share of deliverable depth to keep quoting while defending.", unit: "pct" },
  { key: "leaveDefensiveBps", label: "Recovery volatility threshold", hint: "Calm only counts below this. Must be under the defensive threshold.", unit: "pct" },
  { key: "calmPeriodSeconds", label: "Calm duration", hint: "How long that calm must hold, uninterrupted, before any liquidity returns.", unit: "seconds" },
  { key: "recoveryLiquidityBps", label: "Recovery liquidity", hint: "Share quoted while recovering, before returning to full size.", unit: "pct" },
  { key: "recoveryPeriodSeconds", label: "Recovery duration", hint: "How long recovery holds before returning to normal.", unit: "seconds" },
  { key: "normalLiquidityBps", label: "Normal liquidity", hint: "Share quoted in calm markets. Also the base the registry records.", unit: "pct" },
  { key: "normalSpreadBps", label: "Normal spread", hint: "Fee charged in calm markets.", unit: "pct" },
  { key: "defensiveSpreadBps", label: "Defensive spread", hint: "Fee charged while defending.", unit: "pct" },
  { key: "recoverySpreadBps", label: "Recovery spread", hint: "Fee charged while recovering.", unit: "pct" },
];

const toDisplay = (p: StrategyParams, f: (typeof FIELDS)[number]) =>
  f.unit === "pct" ? String(p[f.key] / 100) : String(p[f.key]);

const fromDisplay = (raw: string, f: (typeof FIELDS)[number]) =>
  f.unit === "pct" ? Math.round(Number(raw) * 100) : Math.round(Number(raw));

export function StrategyBuilder({
  open,
  onClose,
  market,
}: {
  open: boolean;
  onClose: () => void;
  market: MarketAddresses;
}) {
  const { address } = useAccount();
  const { strategy } = useStrategy(market);
  const { register, isRegistering, error, hash } = useRegisterStrategy();
  const [params, setParams] = useState<StrategyParams>(DEFAULT_PARAMS);
  const [text, setText] = useState<Partial<Record<keyof StrategyParams, string>>>({});

  const problems = useMemo(() => validateParams(params), [params]);

  const preview = useMemo(() => {
    if (problems.length > 0 || !address || !market.extruction || !strategy) return undefined;
    try {
      const p = previewRegistration({
        registry: strategy.registry,
        extruction: market.extruction,
        tokenA: market.tokenIn,
        tokenB: market.tokenOut,
        maker: address,
        params,
      });
      return { ...p, decoded: decodeProgram(p.ruleProgram) };
    } catch {
      return undefined;
    }
  }, [problems.length, address, market.extruction, market.tokenIn, market.tokenOut, strategy, params]);

  const explorerLink = txUrl(hash ?? undefined);
  const canSubmit = problems.length === 0 && !!address && !!preview && !isRegistering;

  return (
    <Drawer open={open} onClose={onClose} title="Configure a strategy" subtitle="Registers on-chain">
      {!market.extruction && (
        <p className="dim">
          This deployment does not record its conditional-liquidity extruction address, which is
          needed to build the SwapVM program a new strategy runs. Redeploy with the current scripts
          to enable this.
        </p>
      )}

      <section className="dsec">
        <div className="sbuild">
          {FIELDS.map((f) => (
            <div key={f.key} className="sbuild-row">
              <label htmlFor={`sb-${f.key}`}>
                {f.label}
                <span className="hint">{f.hint}</span>
              </label>
              <input
                id={`sb-${f.key}`}
                inputMode="decimal"
                value={text[f.key] ?? toDisplay(params, f)}
                onChange={(e) => {
                  const raw = e.currentTarget.value;
                  setText((t) => ({ ...t, [f.key]: raw }));
                  const parsed = fromDisplay(raw, f);
                  if (Number.isFinite(parsed)) setParams((p) => ({ ...p, [f.key]: parsed }));
                }}
                aria-describedby={`sb-${f.key}-unit`}
              />
              <span id={`sb-${f.key}-unit`} className="label" style={{ gridColumn: 2 }}>
                {f.unit === "pct" ? "%" : "seconds"}
              </span>
            </div>
          ))}
        </div>

        {problems.length > 0 && (
          <ul className="sbuild-errors">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </section>

      {problems.length === 0 && (
        <section className="dsec">
          <span className="label">What this strategy will do</span>
          <StrategyPreview params={params} />
        </section>
      )}

      {preview && (
        <section className="dsec">
          <span className="label">The program that will be registered</span>
          <p className="faint" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.55 }}>
            Decoded back out of the bytes your parameters compiled to - so what you read here is
            literally what the on-chain engine will execute.
          </p>
          <ol className="rules">
            {preview.decoded.rules.map((rule, i) => (
              <li key={i} className="rule">
                <span className="rule-when">
                  when {rule.conditions.map(describeCondition).join(" and ")}
                  {rule.durationSeconds > 0 && ` for ${fmtDuration(rule.durationSeconds)}`}
                </span>
                <span className="rule-then">{rule.actions.map(describeAction).join(", ")}</span>
              </li>
            ))}
          </ol>
          <div className="dlist">
            <DetailRow k="Strategy id" v={shortHash(preview.strategyId)} mono hint="keccak256(abi.encode(order)) - the same id Aqua and SwapVM derive." />
            <DetailRow k="Registry" v={shortHash(strategy!.registry)} mono />
            <DetailRow k="Rule program" v={`${(preview.ruleProgram.length - 2) / 2} bytes`} mono />
          </div>
        </section>
      )}

      <section className="dsec">
        <button className="btn btn-primary" onClick={() => preview && register({
          registry: strategy!.registry,
          extruction: market.extruction!,
          tokenA: market.tokenIn,
          tokenB: market.tokenOut,
          maker: address!,
          params,
        })} disabled={!canSubmit}>
          {isRegistering ? "Registering…" : "Register strategy"}
        </button>

        {!address && <p className="faint" style={{ fontSize: "var(--fs-xs)" }}>Connect a wallet to register.</p>}
        {error && <p style={{ fontSize: "var(--fs-xs)", color: "var(--bad)" }}>{error}</p>}
        {hash && (
          <p style={{ fontSize: "var(--fs-xs)", color: "var(--ok)" }}>
            Registered.{" "}
            {explorerLink ? (
              <a href={explorerLink} target="_blank" rel="noreferrer">
                {shortHash(hash)}
              </a>
            ) : (
              shortHash(hash)
            )}
          </p>
        )}

        <p className="faint" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.55 }}>
          Registering records how your liquidity should behave. It does not move any tokens: until
          you ship depth into Aqua and approve it, the strategy honestly reports zero executable
          liquidity - the same rule that applies to every other source here.
        </p>
      </section>
    </Drawer>
  );
}
