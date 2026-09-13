import type { RouteResult } from "./useRouteQuote";

/**
 * The swap lifecycle, as a pure function.
 *
 * Stage is DERIVED from inputs, never stored. That is what makes two long-standing bug classes
 * unrepresentable rather than merely handled:
 *
 * - A stale "Swap complete" cannot survive an amount change, because success requires
 *   `submittedForKey === tradeKey`. No reset effect, no ordering race.
 * - A reverted transaction cannot read as success, because success requires
 *   `receiptStatus === "success"`. The previous implementation awaited the receipt and set success
 *   unconditionally - and viem resolves normally on a revert, so a settle rejected by the
 *   phantom-liquidity guard displayed as a completed swap.
 *
 * Signing and confirming are separate stages throughout. "Waiting for you to sign" and "waiting for
 * the chain" are different events with different remedies, and collapsing them into one spinner -
 * which is what awaiting a receipt inside an `approving` stage does - leaves the user unable to tell
 * a wallet that never opened from a transaction that is simply slow.
 *
 * Being React-free, it is directly unit-testable; see settleState.test.ts.
 */
export type SettleStage =
  // preconditions
  | "disconnected"
  | "wrong-network"
  | "idle"
  | "invalid-amount"
  | "debouncing"
  | "quoting"
  | "quote-stale"
  | "no-route"
  | "quote-unavailable"
  | "insufficient-balance"
  // approval
  | "needs-approval"
  | "approval-signing"
  | "approval-confirming"
  | "approval-failed"
  // pre-flight
  | "simulating"
  | "settle-blocked"
  // review + swap
  | "quote-updated"
  | "ready"
  | "swap-signing"
  | "swap-confirming"
  | "swap-failed"
  | "success";

export interface SettleInputs {
  isConnected: boolean;
  isWrongNetwork: boolean;

  amountWei: bigint | undefined;
  amountInvalid: boolean;
  isDebouncing: boolean;

  balance: bigint | undefined;
  allowance: bigint | undefined;

  route: RouteResult | undefined;
  routeIsQuoting: boolean;
  routeIsRpcFailure: boolean;
  /** Displayed figures belong to a previous amount. Showable, never signable. */
  routeIsStale: boolean;

  approveIsSigning: boolean;
  approveIsConfirming: boolean;
  approveFailed: boolean;

  simulateIsLoading: boolean;
  simulateError: unknown;

  settleIsSigning: boolean;
  settleIsConfirming: boolean;
  settleFailed: boolean;

  /** True when the quote moved materially against the user since they last reviewed it. */
  quoteDrifted: boolean;

  /** Which trade the in-flight or completed settle belongs to. */
  submittedForKey: string | null;
  tradeKey: string;
  receiptStatus: "success" | "reverted" | undefined;
}

export interface SettleState {
  stage: SettleStage;
  /** Label for the primary button. */
  label: string;
  canSubmit: boolean;
  /** True while something is in flight - drives the spinner and `aria-busy`. */
  busy: boolean;
}

/**
 * Ordering is intentional: terminal outcomes for the *current* trade are checked before
 * preconditions, so a completed or failed swap is not immediately overwritten by "Enter an amount"
 * while its inputs are still on screen.
 */
export function deriveSettleState(input: SettleInputs, symbolIn: string): SettleState {
  const isCurrentTrade = input.submittedForKey === input.tradeKey;

  // ---- terminal outcomes for this exact trade ----
  if (isCurrentTrade && input.receiptStatus === "success") {
    return { stage: "success", label: "Swap again", canSubmit: false, busy: false };
  }
  if (isCurrentTrade && (input.receiptStatus === "reverted" || input.settleFailed)) {
    return { stage: "swap-failed", label: "Try again", canSubmit: true, busy: false };
  }

  // ---- in flight: signing and confirming never share a stage ----
  if (input.settleIsSigning) {
    return { stage: "swap-signing", label: "Confirm in your wallet", canSubmit: false, busy: true };
  }
  if (input.settleIsConfirming) {
    return { stage: "swap-confirming", label: "Swapping", canSubmit: false, busy: true };
  }
  if (input.approveIsSigning) {
    return { stage: "approval-signing", label: "Confirm in your wallet", canSubmit: false, busy: true };
  }
  if (input.approveIsConfirming) {
    return { stage: "approval-confirming", label: "Approving", canSubmit: false, busy: true };
  }
  if (input.approveFailed) {
    return { stage: "approval-failed", label: `Approve ${symbolIn}`, canSubmit: true, busy: false };
  }

  // ---- amount preconditions ----
  if (input.amountInvalid) {
    return { stage: "invalid-amount", label: "Enter a valid amount", canSubmit: false, busy: false };
  }
  if (input.amountWei === undefined) {
    return { stage: "idle", label: "Enter an amount", canSubmit: false, busy: false };
  }

  // ---- quote ----
  if (input.routeIsRpcFailure) {
    return { stage: "quote-unavailable", label: "Quote unavailable", canSubmit: false, busy: false };
  }
  if (input.routeIsQuoting || input.route === undefined) {
    return { stage: "quoting", label: "Finding best route", canSubmit: false, busy: true };
  }
  if (input.isDebouncing) {
    return { stage: "debouncing", label: "Updating quote", canSubmit: false, busy: true };
  }
  if (input.routeIsStale) {
    // A route IS on screen and stays on screen - dimmed, not blanked. It simply describes a
    // different amount, so it must not be signable.
    return { stage: "quote-stale", label: "Updating quote", canSubmit: false, busy: true };
  }
  if (input.route.kind !== "routable") {
    return { stage: "no-route", label: "No executable route", canSubmit: false, busy: false };
  }

  // ---- wallet, checked only once a real quote exists so a visitor can browse freely ----
  if (!input.isConnected) {
    return { stage: "disconnected", label: "Connect wallet", canSubmit: true, busy: false };
  }
  if (input.isWrongNetwork) {
    return { stage: "wrong-network", label: "Switch network", canSubmit: true, busy: false };
  }
  if (input.balance !== undefined && input.amountWei > input.balance) {
    return { stage: "insufficient-balance", label: `Not enough ${symbolIn}`, canSubmit: false, busy: false };
  }
  if (input.allowance !== undefined && input.allowance < input.amountWei) {
    return { stage: "needs-approval", label: `Approve ${symbolIn}`, canSubmit: true, busy: false };
  }

  // ---- pre-flight simulation ----
  if (input.simulateIsLoading) {
    return { stage: "simulating", label: "Checking route", canSubmit: false, busy: true };
  }
  if (input.simulateError) {
    // Runs the real `settle` path including the contract's on-chain revalidation, so a source that
    // went insolvent between quote and click is caught BEFORE the user signs and pays gas to fail.
    return { stage: "settle-blocked", label: "Can't swap right now", canSubmit: false, busy: false };
  }

  // ---- the quote moved under the user since they reviewed it ----
  if (input.quoteDrifted) {
    return { stage: "quote-updated", label: "Accept updated quote", canSubmit: true, busy: false };
  }

  return { stage: "ready", label: "Swap", canSubmit: true, busy: false };
}

/** Stages where showing the route breakdown is meaningful. */
export function shouldShowRoute(stage: SettleStage): boolean {
  return (
    stage !== "idle" &&
    stage !== "invalid-amount" &&
    stage !== "quote-unavailable" &&
    stage !== "no-route"
  );
}

/** Stages that represent an in-flight or completed transaction, i.e. show the progress panel. */
export function isTransacting(stage: SettleStage): boolean {
  return (
    stage === "approval-signing" ||
    stage === "approval-confirming" ||
    stage === "swap-signing" ||
    stage === "swap-confirming"
  );
}
