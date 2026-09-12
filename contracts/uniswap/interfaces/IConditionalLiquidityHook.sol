// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";

import { IStrategyTypes } from "../../core/interfaces/IStrategyTypes.sol";

/// @title IConditionalLiquidityHook
/// @notice Errors and events for the Uniswap v4 execution backend.
interface IConditionalLiquidityHook is IStrategyTypes {
    error StrategyNotActiveForExecution(bytes32 strategyId);
    error PoolNotInitialized(PoolId poolId);

    /// @notice A requested swap would consume more than the strategy's current effective
    ///         liquidity allows. The Uniswap-backend counterpart of
    ///         `IConditionalLiquidityExtruction.ExceedsEffectiveLiquidity`, kept as a revert (not
    ///         an event) for the same reason: a rejected trade's state changes, including any log
    ///         emitted in the same call frame, are unwound by the EVM. See {ConditionalSwapRejected}
    ///         for why that event exists in this interface but can only ever be observed via
    ///         trace/simulation tooling, never as a persisted log.
    error ExceedsEffectiveLiquidity(PoolId poolId, bytes32 strategyId, uint256 requestedAmount, uint256 effectiveLiquidity);

    /// @notice Emitted only when a swap causes the strategy's mode to actually change — a filtered
    ///         view of {ConditionalLiquidityApplied} for indexers that only care about
    ///         NORMAL/DEFENSIVE/RECOVERY transitions, not every swap. Mirrors
    ///         `IConditionalLiquidityEngine.StateTransition` on the Aqua/SwapVM side.
    event HookStateTransition(
        PoolId indexed poolId, bytes32 indexed strategyId, StrategyMode previousMode, StrategyMode newMode, uint256 timestamp
    );

    /// @notice Emitted whenever a swap is allowed through, describing the strategy decision that
    ///         governed it.
    event ConditionalLiquidityApplied(
        PoolId indexed poolId,
        bytes32 indexed strategyId,
        StrategyMode previousMode,
        StrategyMode currentMode,
        uint256 requestedAmount,
        uint256 effectiveLiquidity,
        uint16 effectiveSpreadBps,
        uint256 timestamp
    );

    /// @notice Documents the shape a rejection would have. Declared for indexer/ABI completeness
    ///         and for off-chain tooling that inspects reverted-transaction traces, but it can
    ///         never appear as a mined, persisted log: emitting it and then reverting (as
    ///         {ExceedsEffectiveLiquidity} requires) would unwind the emission along with
    ///         everything else in that call frame. This is a fundamental EVM constraint, not an
    ///         oversight — see `docs/uniswap-v4.md` for the full explanation.
    event ConditionalSwapRejected(
        PoolId indexed poolId,
        bytes32 indexed strategyId,
        StrategyMode mode,
        uint256 requestedAmount,
        uint256 effectiveLiquidity,
        string reason
    );
}
