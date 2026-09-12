// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IStrategyTypes } from "../../core/interfaces/IStrategyTypes.sol";
import { IExecutableLiquidity } from "../../venues/interfaces/IExecutableLiquidity.sol";

/// @title ILiquidityVenue
/// @notice Normalized view of one execution backend's currently-executable liquidity for a single
///         token pair, used by {ISolver} to compare heterogeneous backends without knowing their
///         internals.
///
/// @dev Every venue is wired to exactly one token pair at construction (mirrors how every existing
///      fixture ships exactly one strategy per pair). A venue holds no strategy/rule logic of its
///      own: every field of {VenueSnapshot} is read straight from the existing
///      {IConditionalLiquidityEngine}/{IConditionalLiquidityRegistry}, or, for Uniswap, the hook
///      built on top of them — the same "holds no copy of the rule engine" invariant
///      {HookStrategyAdapter} already documents for the Uniswap side.
interface ILiquidityVenue is IStrategyTypes, IExecutableLiquidity {
    /// @notice One venue's currently-executable state for a given token pair/direction.
    /// @param venue Address of the venue adapter that produced this snapshot (self-identifying).
    /// @param strategyId Underlying strategy governing this venue's liquidity for the pair.
    /// @param mode Freshly re-evaluated strategy mode (never last-committed/stale).
    /// @param effectiveLiquidity Maximum amount of `tokenIn` this venue can currently absorb,
    ///        already bounded by the strategy's live liquidity multiplier.
    /// @param spreadBps Freshly re-evaluated spread this venue will charge, in bps.
    /// @param referencePrice WAD price of one unit of `tokenIn` denominated in `tokenOut`, read
    ///        live from the market/pool at snapshot time (never a possibly-stale stored value).
    /// @param coverageBps How much of this venue's advertised depth is actually deliverable, in
    ///        bps (see {IExecutableLiquidity}). Carried on the snapshot so discovery and the UI
    ///        get solvency quality in the same read as depth and price; `effectiveLiquidity` is
    ///        already bounded by it, so a router never needs to apply it a second time.
    struct VenueSnapshot {
        address venue;
        bytes32 strategyId;
        StrategyMode mode;
        uint256 effectiveLiquidity;
        uint16 spreadBps;
        uint256 referencePrice;
        uint16 coverageBps;
    }

    /// @notice Thrown when `tokenIn`/`tokenOut` is not the pair this venue instance was built for.
    error UnknownPair(address tokenIn, address tokenOut);

    /// @notice Live, non-mutating snapshot of this venue's executable state for `tokenIn -> tokenOut`.
    /// @dev Must be built from a live re-evaluation path (e.g. `ENGINE.preview`), never from
    ///      last-committed registry state directly. `effectiveLiquidity` must already be bounded
    ///      by {IExecutableLiquidity.executableLiquidity}'s `conditionalLiquidity`, so that a
    ///      venue can never advertise depth to the solver that it could not actually settle.
    function snapshot(address tokenIn, address tokenOut) external view returns (VenueSnapshot memory);

    /// @notice Execute a real `amountIn` of `tokenIn -> tokenOut` through this venue, sending the
    ///         output to `recipient`. Assumes `amountIn` has already been transferred to this
    ///         venue's own balance by the caller.
    /// @dev Real settlement only — no bookkeeping shortcuts. The venue is expected never to be
    ///      called with more than its most recent `effectiveLiquidity`; it does not re-check that
    ///      itself here (the underlying protocol enforces its own cap regardless).
    /// @return amountOut The actual amount of `tokenOut` delivered to `recipient`.
    function execute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    )
        external
        returns (uint256 amountOut);
}
