import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { erc20Abi, maxUint256, type Address } from "viem";
import {
  useAccount,
  useChainId,
  useReadContract,
  useSimulateContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

import { solverAbi } from "../abis/index.js";
import { addresses, chainId as targetChainId } from "../config/contracts";
import { useObservedBlock } from "../chain/ObservedBlockContext";
import { useSettlementRefresh } from "../chain/refresh";
import { describeSettleFailure, type SettleFailure } from "./errors";
import { compareQuote, minOutFor, type DriftVerdict, type QuoteSnapshot } from "./quoteDrift";
import { deriveSettleState, type SettleState } from "./settleState";
import { useRouteQuote } from "./useRouteQuote";
import { useAmountIntent, useTradePair } from "./useTrade";

/** See `useRouteQuote`: the solver's own check is pinned open, protection lives in `minOut`. */
const ROUTE_CHECK_DISABLED_BPS = 10_000n;

export function useSwapFlow() {
  const pair = useTradePair();
  const intent = useAmountIntent(pair.tokenIn.decimals);
  const quote = useRouteQuote();
  const { address, isConnected } = useAccount();
  const connectedChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { block } = useObservedBlock();
  const refreshAfterSettlement = useSettlementRefresh();

  /** What the user last looked at. Drift is measured against this, not against the last block. */
  const [reviewed, setReviewed] = useState<QuoteSnapshot | null>(null);
  /** What was actually signed — frozen at click so a poll cannot change it mid-flight. */
  const [signed, setSigned] = useState<QuoteSnapshot | null>(null);
  const [submittedForKey, setSubmittedForKey] = useState<string | null>(null);

  const isWrongNetwork = isConnected && connectedChainId !== targetChainId;

  const tradeKey = `${targetChainId}:${pair.tokenIn.address}:${pair.tokenOut.address}:${
    intent.amountWei?.toString() ?? "-"
  }:${pair.slippageBps}`;

  // ---- balance + allowance ----
  // `scopeKey`, NOT `query.queryKey`: wagmi types `QueryParameter` as
  // `UnionLooseOmit<QueryOptions, "queryKey" | "queryFn">`, so a caller-supplied key is rejected.
  // `scopeKey` is folded into the key wagmi generates, which is the supported way to make a read
  // depend on something that is not one of its own arguments.
  //
  // Both keep previous data because a new block otherwise returns them to `undefined` for a
  // round-trip — and `undefined` balance/allowance are exactly the values the state machine reads
  // as "nothing blocking", so the button would flash through to "Swap" on every block.
  const { data: balance } = useReadContract({
    address: pair.tokenIn.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    scopeKey: block?.toString() ?? "pending",
    query: { enabled: Boolean(address), placeholderData: keepPreviousData, refetchInterval: false },
  });

  const { data: allowance } = useReadContract({
    address: pair.tokenIn.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, addresses.solver as Address] : undefined,
    scopeKey: block?.toString() ?? "pending",
    query: { enabled: Boolean(address), placeholderData: keepPreviousData, refetchInterval: false },
  });

  const expectedOut = quote.plan?.totalExpectedAmountOut;
  const minOut = useMemo(
    () => (expectedOut === undefined ? undefined : minOutFor(expectedOut, pair.slippageBps)),
    [expectedOut, pair.slippageBps]
  );

  const needsApproval =
    allowance !== undefined && intent.amountWei !== undefined && allowance < intent.amountWei;

  // ---- writes: approve and settle are separate mutations so their states never blur ----
  const approveWrite = useWriteContract();
  const settleWrite = useWriteContract();

  const approveReceipt = useWaitForTransactionReceipt({
    hash: approveWrite.data,
    query: { enabled: Boolean(approveWrite.data) },
  });
  const settleReceipt = useWaitForTransactionReceipt({
    hash: settleWrite.data,
    query: { enabled: Boolean(settleWrite.data) },
  });

  /**
   * Pre-flight simulation of the real `settle` path, including the contract's on-chain
   * revalidation. A source that went insolvent since the quote is caught before the wallet prompt,
   * so the user never signs a transaction that was already doomed.
   *
   * Deliberately no `keepPreviousData`: serving a safety verdict computed against a previous block
   * or a previous amount is the one thing this must not do.
   */
  const simulate = useSimulateContract({
    address: addresses.solver as Address,
    abi: solverAbi,
    functionName: "settle",
    args:
      intent.amountWei !== undefined && minOut !== undefined
        ? [
            {
              tokenIn: pair.tokenIn.address,
              tokenOut: pair.tokenOut.address,
              amount: intent.amountWei,
              maxSlippageBps: ROUTE_CHECK_DISABLED_BPS,
            },
            minOut,
          ]
        : undefined,
    account: address,
    scopeKey: block?.toString() ?? "pending",
    query: {
      enabled:
        Boolean(address) &&
        !isWrongNetwork &&
        !needsApproval &&
        quote.plan !== undefined &&
        minOut !== undefined,
      retry: false,
    },
  });

  const drift: DriftVerdict = compareQuote(reviewed, expectedOut, pair.slippageBps);

  const state: SettleState = deriveSettleState(
    {
      isConnected,
      isWrongNetwork,
      amountWei: intent.amountWei,
      amountInvalid: intent.status === "invalid",
      isDebouncing: intent.isDebouncing,
      balance,
      allowance,
      route: quote.result,
      routeIsQuoting: quote.status === "quoting",
      routeIsRpcFailure: quote.status === "rpc-failure",
      routeIsStale: quote.isStale,
      approveIsSigning: approveWrite.isPending,
      approveIsConfirming: Boolean(approveWrite.data) && approveReceipt.isLoading,
      approveFailed: approveWrite.isError || approveReceipt.data?.status === "reverted",
      simulateIsLoading: simulate.isLoading,
      simulateError: simulate.error,
      settleIsSigning: settleWrite.isPending,
      settleIsConfirming: Boolean(settleWrite.data) && settleReceipt.isLoading,
      settleFailed: settleWrite.isError,
      quoteDrifted: drift.kind === "worse",
      submittedForKey,
      tradeKey,
      receiptStatus: settleReceipt.data?.status,
    },
    pair.tokenIn.symbol
  );

  // ---- clear per-trade transaction state when the trade itself changes ----
  // Correctness does not rely on this firing: `deriveSettleState` already refuses to show a result
  // whose `submittedForKey` no longer matches. This only frees hashes and cache.
  useEffect(() => {
    approveWrite.reset();
    settleWrite.reset();
    setReviewed(null);
    setSigned(null);
    setSubmittedForKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeKey]);

  // ---- causal refresh: advance the clock and invalidate, on the receipt's own block ----
  useEffect(() => {
    const receipt = settleReceipt.data;
    if (receipt?.status === "success") refreshAfterSettlement(receipt.blockNumber);
  }, [settleReceipt.data, refreshAfterSettlement]);

  useEffect(() => {
    const receipt = approveReceipt.data;
    if (receipt?.status === "success") refreshAfterSettlement(receipt.blockNumber);
  }, [approveReceipt.data, refreshAfterSettlement]);

  // Record what the user is looking at as soon as a signable quote exists, so drift has a baseline.
  useEffect(() => {
    if (state.stage !== "ready" || expectedOut === undefined || minOut === undefined) return;
    if (intent.amountWei === undefined) return;
    setReviewed((current) => current ?? { amountWei: intent.amountWei!, expectedOut, minOut });
  }, [state.stage, expectedOut, minOut, intent.amountWei]);

  const approve = useCallback(() => {
    if (!address) return;
    approveWrite.writeContract({
      address: pair.tokenIn.address,
      abi: erc20Abi,
      functionName: "approve",
      // Infinite approval is a testnet-demo convenience so a trader is not prompted per swap.
      // A production build should offer exact-amount approval as the default.
      args: [addresses.solver as Address, maxUint256],
    });
  }, [address, approveWrite, pair.tokenIn.address]);

  const swap = useCallback(() => {
    if (intent.amountWei === undefined || expectedOut === undefined || minOut === undefined) return;

    // Freeze what the user saw. Without this the click closes over a plan a background poll may
    // have replaced between paint and click, so the signed transaction would not be the one on
    // screen. The quote is still advisory — `settle` re-derives — but `minOut` is a real promise.
    const snapshot: QuoteSnapshot = { amountWei: intent.amountWei, expectedOut, minOut };
    setSigned(snapshot);
    setSubmittedForKey(tradeKey);

    settleWrite.writeContract({
      address: addresses.solver as Address,
      abi: solverAbi,
      functionName: "settle",
      args: [
        {
          tokenIn: pair.tokenIn.address,
          tokenOut: pair.tokenOut.address,
          amount: snapshot.amountWei,
          maxSlippageBps: ROUTE_CHECK_DISABLED_BPS,
        },
        snapshot.minOut,
      ],
    });
  }, [intent.amountWei, expectedOut, minOut, tradeKey, pair.tokenIn.address, pair.tokenOut.address, settleWrite]);

  /** Re-baseline on the current figure. The user has now seen the new number. */
  const acceptUpdatedQuote = useCallback(() => {
    if (intent.amountWei === undefined || expectedOut === undefined || minOut === undefined) return;
    setReviewed({ amountWei: intent.amountWei, expectedOut, minOut });
  }, [intent.amountWei, expectedOut, minOut]);

  const reset = useCallback(() => {
    approveWrite.reset();
    settleWrite.reset();
    setReviewed(null);
    setSigned(null);
    setSubmittedForKey(null);
  }, [approveWrite, settleWrite]);

  const submit = useCallback(() => {
    switch (state.stage) {
      case "wrong-network":
        switchChain({ chainId: targetChainId });
        return;
      case "needs-approval":
      case "approval-failed":
        approve();
        return;
      case "quote-updated":
        acceptUpdatedQuote();
        return;
      case "success":
        reset();
        return;
      default:
        if (state.canSubmit) swap();
    }
  }, [state.stage, state.canSubmit, switchChain, approve, acceptUpdatedQuote, reset, swap]);

  const failure: SettleFailure | null = useMemo(() => {
    if (state.stage === "swap-failed") {
      // A reverted receipt carries no decodable error, so the simulation's error — captured from
      // the same call path — is the better explanation when one is available.
      return describeSettleFailure(settleWrite.error ?? simulate.error);
    }
    if (state.stage === "settle-blocked") return describeSettleFailure(simulate.error);
    if (state.stage === "approval-failed") return describeSettleFailure(approveWrite.error);
    return null;
  }, [state.stage, settleWrite.error, simulate.error, approveWrite.error]);

  return {
    state,
    submit,
    failure,
    drift,
    quote,
    plan: quote.plan,
    expectedOut,
    minOut,
    balance,
    allowance,
    signed,
    approveHash: approveWrite.data,
    settleHash: settleWrite.data,
    /** Realised output is only known once the receipt lands. */
    receipt: settleReceipt.data,
    isWrongNetwork,
    reset,
  };
}
