import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
} from "viem";

/**
 * Error vocabulary.
 *
 * Nothing here ever reaches the user as a Solidity identifier or an RPC string. `NoRoute` is not an
 * error at all — it is modelled as a quote *result* in `useRouteQuote` — and everything that really
 * is a failure gets copy that says what happened and what to do, in the trader's terms.
 *
 * Quote failures and settle failures are described separately. The previous build used one
 * describer for both, so a failed swap told the user "Something went wrong getting a quote".
 */

/** Find a decoded revert anywhere in viem's cause chain. */
export function findRevert(error: unknown): ContractFunctionRevertedError | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? revert : null;
}

/**
 * Detect a cancelled wallet prompt by type, not by substring.
 *
 * The old code matched `shortMessage.includes("user rejected")`, which is wallet- and
 * locale-dependent. viem models this as a real error class, so use it.
 */
export function isUserRejection(error: unknown): boolean {
  if (error instanceof UserRejectedRequestError) return true;
  if (!(error instanceof BaseError)) return false;
  return error.walk((e) => e instanceof UserRejectedRequestError) instanceof UserRejectedRequestError;
}

/**
 * A receipt that never arrived is NOT a failure — the transaction may still land. Reporting it as
 * one would tell a user their swap failed while it was in fact pending.
 */
export function isReceiptTimeout(error: unknown): boolean {
  if (error instanceof WaitForTransactionReceiptTimeoutError) return true;
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk((e) => e instanceof WaitForTransactionReceiptTimeoutError) instanceof
    WaitForTransactionReceiptTimeoutError
  );
}

export interface SettleFailure {
  title: string;
  detail: string;
  /** The phantom-liquidity guard fired. The UI gives this its own treatment. */
  isPhantomLiquidity: boolean;
  /** Retrying unchanged is plausible — drives whether we offer a retry affordance. */
  retryable: boolean;
}

/**
 * Settle-phase failures, mapped from the Solver's real custom errors.
 *
 * `ExecutableLiquidityShortfall` is the most important outcome in the application: on-chain
 * revalidation refusing to route against liquidity that cannot settle. It is named and explained
 * rather than collapsed into a generic failure — it is the product working, not breaking.
 */
export function describeSettleFailure(error: unknown): SettleFailure {
  if (isUserRejection(error)) {
    return {
      title: "Transaction cancelled",
      detail: "You dismissed the request in your wallet. Nothing was swapped.",
      isPhantomLiquidity: false,
      retryable: true,
    };
  }

  if (isReceiptTimeout(error)) {
    return {
      title: "Confirmation taking longer than expected",
      detail:
        "Your transaction was submitted but hasn't confirmed yet. It may still succeed — the hash above tracks it.",
      isPhantomLiquidity: false,
      retryable: false,
    };
  }

  const revert = findRevert(error);
  const name = revert?.data?.errorName;

  switch (name) {
    case "ExecutableLiquidityShortfall":
      return {
        title: "Liquidity disappeared before settlement",
        detail:
          "A source could no longer deliver the amount routed to it, so the entire trade was rejected " +
          "rather than partially filled. Nothing was swapped. Get a fresh quote and try again.",
        isPhantomLiquidity: true,
        retryable: true,
      };
    case "NoRoute":
      return {
        title: "Not enough executable liquidity",
        detail: "There isn't enough depth that can actually settle right now. Try a smaller amount.",
        isPhantomLiquidity: true,
        retryable: false,
      };
    case "SlippageExceeded":
      return {
        title: "Price moved",
        detail:
          "The amount you'd receive fell below your minimum, so the swap was rejected. Nothing was " +
          "swapped. Raise your slippage tolerance or try again at the current price.",
        isPhantomLiquidity: false,
        retryable: true,
      };
    case "DuplicateRouteLeg":
      return {
        title: "Swap failed",
        detail: "The route was rejected as invalid. Get a fresh quote and try again.",
        isPhantomLiquidity: false,
        retryable: true,
      };
    case "SafeERC20FailedOperation":
      return {
        title: "Token transfer failed",
        detail: "The token transfer was rejected. Check your balance and approval, then try again.",
        isPhantomLiquidity: false,
        retryable: true,
      };
    default:
      return {
        title: "Swap failed",
        detail: "The transaction didn't go through. Nothing was swapped.",
        isPhantomLiquidity: false,
        retryable: true,
      };
  }
}

/** Quote-phase transport failures. Reverts never reach here — they are modelled as results. */
export function describeQuoteFailure(error: unknown): { title: string; detail: string } {
  if (isUserRejection(error)) {
    return { title: "Request cancelled", detail: "The request was dismissed." };
  }
  return {
    title: "Can't reach the network",
    detail: "We couldn't get a quote. Check your connection and retry.",
  };
}
