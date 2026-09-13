import { Check, Circle, ExternalLink, Loader2 } from "lucide-react";

import { explorerName, shortHash, txUrl } from "../../chain/explorer";
import { chain } from "../../config/contracts";
import type { SettleStage } from "../../trade/settleState";

/**
 * Approval and settlement, as two clearly separate transactions with four clearly separate waits.
 *
 * "Waiting for your signature" and "waiting for the chain" are different events with different
 * remedies - one needs you to look at your wallet, the other needs patience - and the previous
 * build collapsed both into a single "Approving…" label by awaiting the receipt inside the same
 * stage. Here each is its own step with its own icon, and both hashes are surfaced the moment they
 * exist rather than only the settlement one.
 */

type StepState = "pending" | "active" | "done";

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <Check size={16} strokeWidth={2.5} color="var(--ok)" aria-hidden="true" />;
  if (state === "active") return <Loader2 className="spin" size={16} strokeWidth={2.5} color="var(--accent)" aria-hidden="true" />;
  return <Circle size={14} strokeWidth={2} color="var(--text-faint)" aria-hidden="true" />;
}

function Step({
  state,
  title,
  detail,
  hash,
}: {
  state: StepState;
  title: string;
  detail?: string;
  hash?: `0x${string}`;
}) {
  const url = hash ? txUrl(hash) : null;
  const explorer = explorerName();
  return (
    <div className={`txstep txstep-${state}`}>
      <span className="icon">
        <StepIcon state={state} />
      </span>
      <span className="title">
        {title}
        {detail && <small>{detail}</small>}
      </span>
      {hash &&
        (url ? (
          <a className="txlink" href={url} target="_blank" rel="noreferrer" title={hash}>
            {explorer ? `View on ${explorer}` : shortHash(hash)}
            <ExternalLink size={11} strokeWidth={2.5} aria-hidden="true" />
          </a>
        ) : (
          // No explorer on this chain. The hash still matters - show it rather than a dead link.
          <span className="txlink">{shortHash(hash)}</span>
        ))}
    </div>
  );
}

const ORDER: SettleStage[] = [
  "approval-signing",
  "approval-confirming",
  "swap-signing",
  "swap-confirming",
  "success",
];

export function TxProgress({
  stage,
  symbolIn,
  approveHash,
  settleHash,
  needsApproval,
}: {
  stage: SettleStage;
  symbolIn: string;
  approveHash?: `0x${string}`;
  settleHash?: `0x${string}`;
  needsApproval: boolean;
}) {
  const index = ORDER.indexOf(stage);
  const at = (s: SettleStage) => ORDER.indexOf(s);
  const stateFor = (s: SettleStage): StepState =>
    index === at(s) ? "active" : index > at(s) ? "done" : "pending";

  return (
    <div className="txsteps" aria-live="polite">
      {needsApproval && (
        <>
          <Step
            state={stateFor("approval-signing")}
            title={`Approve ${symbolIn}`}
            detail={
              stage === "approval-signing" ? "Waiting for your wallet signature..." : "One-time permission"
            }
          />
          <Step
            state={stateFor("approval-confirming")}
            title="Approval confirming"
            detail={
              stage === "approval-confirming" ? `Submitted - confirming on ${chain.name}...` : undefined
            }
            hash={approveHash}
          />
        </>
      )}
      <Step
        state={stateFor("swap-signing")}
        title="Confirm swap"
        detail={stage === "swap-signing" ? "Waiting for your wallet signature..." : undefined}
      />
      <Step
        state={stateFor("swap-confirming")}
        title="Settling on-chain"
        detail={stage === "swap-confirming" ? `Submitted - confirming on ${chain.name}...` : undefined}
        hash={settleHash}
      />
    </div>
  );
}
