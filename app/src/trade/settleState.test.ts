import { describe, expect, it } from "vitest";

import { deriveSettleState, shouldShowRoute, type SettleInputs } from "./settleState";

const TRADE_KEY = "31337:0xA:0xB:1000:50";

function inputs(overrides: Partial<SettleInputs> = {}): SettleInputs {
  return {
    isConnected: true,
    isWrongNetwork: false,
    amountWei: 1000n,
    amountInvalid: false,
    isDebouncing: false,
    balance: 10_000n,
    allowance: 10_000n,
    route: { kind: "routable", plan: { legs: [] } as never },
    routeIsQuoting: false,
    routeIsRpcFailure: false,
    routeIsStale: false,
    approveIsSigning: false,
    approveIsConfirming: false,
    approveFailed: false,
    simulateIsLoading: false,
    simulateError: undefined,
    settleIsSigning: false,
    settleIsConfirming: false,
    settleFailed: false,
    quoteDrifted: false,
    submittedForKey: null,
    tradeKey: TRADE_KEY,
    receiptStatus: undefined,
    ...overrides,
  };
}

const derive = (o: Partial<SettleInputs> = {}) => deriveSettleState(inputs(o), "DTA");

describe("deriveSettleState - the revert bug", () => {
  /**
   * The defect this whole state machine exists to make impossible. The previous implementation
   * awaited the receipt and set "success" without inspecting `receipt.status`; viem resolves
   * normally on a revert, so a settle rejected by the on-chain phantom-liquidity guard rendered
   * "Swap complete!".
   */
  it("reports a reverted receipt as failure, never success", () => {
    const state = derive({ submittedForKey: TRADE_KEY, receiptStatus: "reverted" });

    expect(state.stage).toBe("swap-failed");
    expect(state.stage).not.toBe("success");
  });

  it("reports a successful receipt as success", () => {
    expect(derive({ submittedForKey: TRADE_KEY, receiptStatus: "success" }).stage).toBe("success");
  });

  it("treats a thrown settle error as failure", () => {
    expect(derive({ submittedForKey: TRADE_KEY, settleFailed: true }).stage).toBe("swap-failed");
  });
});

describe("deriveSettleState - stale success is unrepresentable", () => {
  /**
   * Editing the amount changes `tradeKey`, so a success belonging to the previous trade can no
   * longer match. This is why no reset effect is needed: the guard resolves in the same render.
   */
  it("does not show success for a different trade", () => {
    const state = derive({ submittedForKey: "some:other:key", receiptStatus: "success" });
    expect(state.stage).not.toBe("success");
    expect(state.stage).toBe("ready");
  });

  it("does not show a failure belonging to a different trade", () => {
    expect(derive({ submittedForKey: "stale", receiptStatus: "reverted" }).stage).toBe("ready");
  });
});

describe("deriveSettleState - signing vs confirming are distinct", () => {
  it("distinguishes waiting for the wallet from waiting for the block", () => {
    expect(derive({ settleIsSigning: true }).stage).toBe("swap-signing");
    expect(derive({ settleIsConfirming: true }).stage).toBe("swap-confirming");
    expect(derive({ approveIsSigning: true }).stage).toBe("approval-signing");
    expect(derive({ approveIsConfirming: true }).stage).toBe("approval-confirming");
  });

  it("marks every in-flight stage busy and non-submittable", () => {
    for (const o of [
      { settleIsSigning: true },
      { settleIsConfirming: true },
      { approveIsSigning: true },
      { approveIsConfirming: true },
    ]) {
      const state = derive(o);
      expect(state.busy).toBe(true);
      expect(state.canSubmit).toBe(false);
    }
  });
});

describe("deriveSettleState - preconditions", () => {
  it("asks for an amount before anything else", () => {
    expect(derive({ amountWei: undefined }).stage).toBe("idle");
  });

  it("separates an unparseable amount from an empty one", () => {
    expect(derive({ amountWei: undefined, amountInvalid: true }).stage).toBe("invalid-amount");
  });

  it("surfaces an unreachable RPC as its own state, not as a spinner", () => {
    // The previous build rendered "loading…" forever here, because `error` was never read.
    expect(derive({ routeIsRpcFailure: true }).stage).toBe("quote-unavailable");
  });

  it("reports a thin market as no-route rather than an error", () => {
    const state = derive({ route: { kind: "no-route", requested: 5n, totalExecutable: 2n } });
    expect(state.stage).toBe("no-route");
    expect(state.canSubmit).toBe(false);
  });

  it("requires approval when the allowance is short", () => {
    const state = derive({ allowance: 10n });
    expect(state.stage).toBe("needs-approval");
    expect(state.label).toBe("Approve DTA");
    expect(state.canSubmit).toBe(true);
  });

  it("blocks on insufficient balance before asking for approval", () => {
    expect(derive({ balance: 10n, allowance: 0n }).stage).toBe("insufficient-balance");
  });

  it("is ready when everything checks out", () => {
    const state = derive();
    expect(state.stage).toBe("ready");
    expect(state.label).toBe("Swap");
    expect(state.canSubmit).toBe(true);
  });
});

describe("deriveSettleState - browsing without a wallet", () => {
  /**
   * A visitor should be able to see depth and get a quote before connecting; the wallet gate comes
   * after the quote so the product is legible to someone who has not connected yet.
   */
  it("still quotes, then asks to connect", () => {
    expect(derive({ isConnected: false }).stage).toBe("disconnected");
  });

  it("asks for an amount before asking to connect", () => {
    expect(derive({ isConnected: false, amountWei: undefined }).stage).toBe("idle");
  });

  it("offers a network switch when connected to the wrong chain", () => {
    const state = derive({ isWrongNetwork: true });
    expect(state.stage).toBe("wrong-network");
    expect(state.canSubmit).toBe(true);
  });
});

describe("deriveSettleState - pre-flight simulation", () => {
  it("blocks submission when the simulation reverts", () => {
    // Catches a maker that went insolvent between quote and click, before the user signs.
    const state = derive({ simulateError: new Error("ExecutableLiquidityShortfall") });
    expect(state.stage).toBe("settle-blocked");
    expect(state.canSubmit).toBe(false);
  });

  it("waits while simulating", () => {
    expect(derive({ simulateIsLoading: true }).stage).toBe("simulating");
  });
});

describe("deriveSettleState - a stale quote is not signable", () => {
  /**
   * `useSwapFlow` freezes the quote at click so a background poll cannot change what gets signed.
   * That is necessary but not sufficient: if the figure on screen is a `keepPreviousData`
   * placeholder for an amount the user has already typed over, freezing it just freezes the wrong
   * number. The state machine is where that is caught.
   */
  it("blocks submission while the displayed quote belongs to a previous amount", () => {
    const state = derive({ routeIsStale: true });

    expect(state.stage).toBe("quote-stale");
    expect(state.canSubmit).toBe(false);
    expect(state.busy).toBe(true);
  });

  it("keeps showing the route while it is stale, rather than blanking it", () => {
    expect(shouldShowRoute(derive({ routeIsStale: true }).stage)).toBe(true);
  });

  it("prefers the outright absence of a quote to staleness", () => {
    expect(derive({ routeIsStale: true, route: undefined }).stage).toBe("quoting");
  });

  it("becomes signable once the quote catches up", () => {
    expect(derive({ routeIsStale: false }).stage).toBe("ready");
  });
});

describe("deriveSettleState - the quote is never presented as locked", () => {
  /**
   * `Solver.settle` re-derives the route on-chain, so the displayed figure is advisory. Freezing it
   * at click is necessary but not sufficient: if the number on screen drifted materially since the
   * user looked at it, freezing just captures the wrong one. The machine surfaces that first.
   */
  it("asks the user to review a quote that moved against them", () => {
    const state = derive({ quoteDrifted: true });

    expect(state.stage).toBe("quote-updated");
    expect(state.canSubmit).toBe(true);
    expect(state.label).toBe("Accept updated quote");
  });

  it("does not interrupt when the quote has not drifted", () => {
    expect(derive({ quoteDrifted: false }).stage).toBe("ready");
  });

  it("puts approval ahead of a drift prompt - you cannot swap without it anyway", () => {
    expect(derive({ quoteDrifted: true, allowance: 0n }).stage).toBe("needs-approval");
  });
});

describe("deriveSettleState - typing never looks like a failure", () => {
  it("reports debouncing as its own state, distinct from quoting", () => {
    const state = derive({ isDebouncing: true });

    expect(state.stage).toBe("debouncing");
    expect(state.busy).toBe(true);
    expect(state.canSubmit).toBe(false);
  });

  it("never reports no-route while the amount is still settling", () => {
    // A held-over "no route" from the previous keystroke must not flash as the user types past it.
    const state = derive({ isDebouncing: true, route: { kind: "no-route", requested: 1n, totalExecutable: 0n } });
    expect(state.stage).not.toBe("no-route");
  });
});
