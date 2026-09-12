// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";

import { IStrategyTypes } from "../../core/interfaces/IStrategyTypes.sol";

/// @title IHookStrategyAdapter
/// @notice Associates Uniswap v4 pools with strategies already registered in the existing
///         {IConditionalLiquidityRegistry}. Owns no strategy logic of its own.
interface IHookStrategyAdapter is IStrategyTypes {
    /// @notice Declared liquidity ceilings and the strategy governing a pool.
    /// @dev `baseLiquidity0`/`baseLiquidity1` are maker-declared, exactly as the amounts a maker
    ///      passes to `Aqua.ship`. Uniswap v4 has no equivalent of Aqua's per-strategy virtual
    ///      balance (pool liquidity is a shared AMM invariant, not a maker-scoped balance), so the
    ///      maker declares the notional ceiling their strategy governs, in each token's own units.
    struct PoolStrategy {
        bytes32 strategyId;
        uint256 baseLiquidity0;
        uint256 baseLiquidity1;
    }

    error PoolStrategyAlreadyRegistered(PoolId poolId);
    error NoStrategyForPool(PoolId poolId);
    error HookMismatch(PoolId poolId, address configuredHook);
    error NotStrategyMaker(bytes32 strategyId, address caller);
    error StrategyNotActiveForRegistration(bytes32 strategyId);
    error TokenMismatch(bytes32 strategyId, address currency0, address currency1);

    event PoolStrategyRegistered(
        PoolId indexed poolId,
        bytes32 indexed strategyId,
        address currency0,
        address currency1,
        uint256 baseLiquidity0,
        uint256 baseLiquidity1
    );

    /// @notice Bind `strategyId` to the pool identified by `key`. Immutable once set: the MVP
    ///         deliberately offers no update/replace path (see {PoolStrategyAlreadyRegistered}).
    /// @dev Only the strategy's registered maker may call this (same authority model as
    ///      `ConditionalLiquidityRegistry.registerStrategy`/`Aqua.ship`).
    function registerPoolStrategy(PoolKey calldata key, bytes32 strategyId, uint256 baseLiquidity0, uint256 baseLiquidity1) external;

    /* ------------------------------------------------------------------ frontend-facing reads */

    function getPoolStrategy(PoolId poolId) external view returns (PoolStrategy memory);

    function getStrategyId(PoolId poolId) external view returns (bytes32);

    function getRuntimeState(PoolId poolId) external view returns (RuntimeState memory);

    function getCurrentMode(PoolId poolId) external view returns (StrategyMode);

    function getEffectiveSpread(PoolId poolId) external view returns (uint16);

    /// @notice Effective liquidity ceiling for currency0, at the strategy's current liquidity
    ///         multiplier. See {getEffectiveLiquidityBothSides} for the currency1 side too.
    function getEffectiveLiquidity(PoolId poolId) external view returns (uint256);

    function getEffectiveLiquidityBothSides(PoolId poolId) external view returns (uint256 amount0, uint256 amount1);

    /// @notice Fully-live snapshot: mode, spread and both-side effective liquidity, all freshly
    ///         re-evaluated in a single call. Unlike {getCurrentMode}/{getEffectiveSpread} (which
    ///         read the last-committed `RuntimeState` and can be stale until the next swap/poke),
    ///         this never returns stale data — it is the read-only path a venue/solver should use.
    function quoteSnapshot(PoolId poolId) external view returns (StrategyMode mode, uint16 spreadBps, uint256 amount0, uint256 amount1);
}
