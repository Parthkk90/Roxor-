// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { BaseHook } from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { BeforeSwapDelta, BeforeSwapDeltaLibrary } from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import { LPFeeLibrary } from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";

import { HookStrategyAdapter } from "./HookStrategyAdapter.sol";
import { IConditionalLiquidityHook } from "./interfaces/IConditionalLiquidityHook.sol";
import { IConditionalLiquidityEngine } from "../engine/interfaces/IConditionalLiquidityEngine.sol";
import { IConditionalLiquidityRegistry } from "../core/interfaces/IConditionalLiquidityRegistry.sol";
import { FixedPointMath } from "../libraries/FixedPointMath.sol";

/// @title ConditionalLiquidityHook
/// @notice Real Uniswap v4 hook enforcing conditional-liquidity strategy state on swaps.
///
/// @dev NO DUPLICATED STRATEGY LOGIC
///      This contract contains no volatility math, no hysteresis, no mode transitions, and no
///      liquidity/spread formulas. Every strategy decision is delegated to the same
///      {IConditionalLiquidityEngine}/{IConditionalLiquidityRegistry} the Aqua/SwapVM backend uses
///      (via {ENGINE}.poke, inherited from {HookStrategyAdapter}). `RuleEngineLib` is invoked
///      exactly once, from exactly one place in the whole protocol: `ConditionalLiquidityEngine`.
///      Two backends, one state machine.
///
/// @dev ENFORCEMENT MECHANISM (see docs/uniswap-v4-implementation-notes.md for the full survey of
///      the installed v4 API that led here)
///      `_beforeSwap` is the only hook callback implemented. It:
///        1. Resolves the pool's strategy and calls `ENGINE.poke` — the same permissionless state
///           advance the SwapVM path drives via `ConditionalLiquidityExtruction`.
///        2. Computes the requested amount's cap from the strategy's current liquidity multiplier
///           and the maker-declared base liquidity for the relevant token side, and reverts
///           `ExceedsEffectiveLiquidity` if the request exceeds it. This is a hard cap via revert,
///           not a custom-accounting truncation (`BeforeSwapDelta` is returned as zero) — matching
///           the Aqua backend's behavior exactly: an oversized trade is refused outright on both
///           backends, never silently shrunk on one and rejected on the other.
///        3. Returns a dynamic-fee override derived from the strategy's current spread, applied
///           only if the pool was created with a dynamic fee (harmless no-op otherwise).
///      No other callback is implemented: `getHookPermissions` enables only `beforeSwap`.
contract ConditionalLiquidityHook is HookStrategyAdapter, BaseHook, IConditionalLiquidityHook {
    using PoolIdLibrary for PoolKey;
    using FixedPointMath for uint256;

    constructor(
        IPoolManager manager,
        IConditionalLiquidityEngine engine,
        IConditionalLiquidityRegistry registry
    )
        BaseHook(manager)
        HookStrategyAdapter(engine, registry)
    { }

    /// @inheritdoc BaseHook
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice Bind a strategy to a pool that uses this hook.
    /// @dev Adds the one check {HookStrategyAdapter} cannot perform itself (it has no PoolManager
    ///      dependency): the pool must actually be initialized.
    function registerPoolStrategy(PoolKey calldata key, bytes32 strategyId, uint256 baseLiquidity0, uint256 baseLiquidity1) external {
        PoolId poolId = key.toId();
        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(poolManager, poolId);
        require(sqrtPriceX96 != 0, PoolNotInitialized(poolId));

        _registerPoolStrategy(key, strategyId, baseLiquidity0, baseLiquidity1);
    }

    function _beforeSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata
    )
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId poolId = key.toId();
        PoolStrategy memory ps = _poolStrategyOf(poolId);
        bytes32 strategyId = ps.strategyId;

        require(REGISTRY.isActive(strategyId), StrategyNotActiveForExecution(strategyId));

        StrategyMode previousMode = REGISTRY.getStrategyState(strategyId).mode;
        LiquidityConfig memory config = ENGINE.poke(strategyId);

        // exactIn (amountSpecified < 0): the specified amount is what gets pulled in. zeroForOne
        // pulls currency0 in, so the cap is currency0's ceiling; otherwise currency1's.
        // exactOut (amountSpecified > 0): the specified amount is what gets paid out. zeroForOne
        // pays currency1 out, so the cap is currency1's ceiling; otherwise currency0's.
        // Mirrors ConditionalLiquidityExtruction exactly: exact-in caps the input side, exact-out
        // caps the output side.
        bool exactIn = params.amountSpecified < 0;
        uint256 requested = exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        bool capOnCurrency0 = exactIn ? params.zeroForOne : !params.zeroForOne;
        uint256 base = capOnCurrency0 ? ps.baseLiquidity0 : ps.baseLiquidity1;
        uint256 cap = base.mulBps(config.liquidityBps);

        require(requested <= cap, ExceedsEffectiveLiquidity(poolId, strategyId, requested, cap));

        if (config.mode != previousMode) {
            emit HookStateTransition(poolId, strategyId, previousMode, config.mode, block.timestamp);
        }

        // Dynamic-fee override: ignored by PoolManager unless the pool was created with
        // LPFeeLibrary.DYNAMIC_FEE_FLAG, so it is always safe to return.
        uint24 feeOverride = (uint24(config.spreadBps) * 100) | LPFeeLibrary.OVERRIDE_FEE_FLAG;

        emit ConditionalLiquidityApplied(poolId, strategyId, previousMode, config.mode, requested, cap, config.spreadBps, block.timestamp);

        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, feeOverride);
    }
}
