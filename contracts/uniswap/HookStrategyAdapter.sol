// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";

import { IHookStrategyAdapter } from "./interfaces/IHookStrategyAdapter.sol";
import { IConditionalLiquidityEngine } from "../engine/interfaces/IConditionalLiquidityEngine.sol";
import { IConditionalLiquidityRegistry } from "../core/interfaces/IConditionalLiquidityRegistry.sol";

/// @title HookStrategyAdapter
/// @notice The PoolId <-> Strategy association layer. Deliberately holds no swap-execution logic
///         and no copy of the rule engine: every read here either returns locally-owned pool
///         metadata or delegates straight to the existing {IConditionalLiquidityRegistry} /
///         {IConditionalLiquidityEngine} - the exact same contracts the Aqua/SwapVM backend uses.
///
/// @dev This is the "HookStrategyAdapter" box in:
///        StrategyRegistry -> Strategy State -> HookStrategyAdapter -> ConditionalLiquidityHook -> PoolManager
///      It knows nothing about `IHooks`, `BeforeSwapDelta`, hook permission bits, or PoolManager's
///      unlock/callback pattern; that is {ConditionalLiquidityHook}'s job. This contract only knows
///      pools, strategies, and how to read the strategy semantics that already exist.
abstract contract HookStrategyAdapter is IHookStrategyAdapter {
    using PoolIdLibrary for PoolKey;

    IConditionalLiquidityEngine public immutable ENGINE;
    IConditionalLiquidityRegistry public immutable REGISTRY;

    mapping(PoolId => PoolStrategy) private _poolStrategies;

    constructor(IConditionalLiquidityEngine engine, IConditionalLiquidityRegistry registry) {
        ENGINE = engine;
        REGISTRY = registry;
    }

    /// @dev Validates everything in the strategy/registry domain and writes the association.
    ///      Does NOT validate that the pool itself exists - that requires PoolManager, which this
    ///      contract deliberately does not depend on. {ConditionalLiquidityHook.registerPoolStrategy}
    ///      performs that check before calling this.
    function _registerPoolStrategy(PoolKey calldata key, bytes32 strategyId, uint256 baseLiquidity0, uint256 baseLiquidity1) internal {
        PoolId poolId = key.toId();
        require(_poolStrategies[poolId].strategyId == bytes32(0), PoolStrategyAlreadyRegistered(poolId));
        require(address(key.hooks) == address(this), HookMismatch(poolId, address(key.hooks)));

        Strategy memory strategy = REGISTRY.getStrategy(strategyId);
        require(strategy.maker == msg.sender, NotStrategyMaker(strategyId, msg.sender));
        require(REGISTRY.isActive(strategyId), StrategyNotActiveForRegistration(strategyId));

        address currency0 = Currency.unwrap(key.currency0);
        address currency1 = Currency.unwrap(key.currency1);
        require(currency0 == strategy.tokenA && currency1 == strategy.tokenB, TokenMismatch(strategyId, currency0, currency1));

        _poolStrategies[poolId] = PoolStrategy({ strategyId: strategyId, baseLiquidity0: baseLiquidity0, baseLiquidity1: baseLiquidity1 });

        emit PoolStrategyRegistered(poolId, strategyId, currency0, currency1, baseLiquidity0, baseLiquidity1);
    }

    function _poolStrategyOf(PoolId poolId) internal view returns (PoolStrategy memory ps) {
        ps = _poolStrategies[poolId];
        require(ps.strategyId != bytes32(0), NoStrategyForPool(poolId));
    }

    /* ------------------------------------------------------------------ frontend-facing reads */

    /// @inheritdoc IHookStrategyAdapter
    function getPoolStrategy(PoolId poolId) external view returns (PoolStrategy memory) {
        return _poolStrategyOf(poolId);
    }

    /// @inheritdoc IHookStrategyAdapter
    function getStrategyId(PoolId poolId) external view returns (bytes32) {
        return _poolStrategyOf(poolId).strategyId;
    }

    /// @inheritdoc IHookStrategyAdapter
    function getRuntimeState(PoolId poolId) external view returns (RuntimeState memory) {
        return REGISTRY.getStrategyState(_poolStrategyOf(poolId).strategyId);
    }

    /// @inheritdoc IHookStrategyAdapter
    function getCurrentMode(PoolId poolId) external view returns (StrategyMode) {
        return REGISTRY.getStrategyState(_poolStrategyOf(poolId).strategyId).mode;
    }

    /// @inheritdoc IHookStrategyAdapter
    function getEffectiveSpread(PoolId poolId) external view returns (uint16) {
        return REGISTRY.getStrategyState(_poolStrategyOf(poolId).strategyId).spreadBps;
    }

    /// @inheritdoc IHookStrategyAdapter
    function getEffectiveLiquidity(PoolId poolId) external view returns (uint256) {
        PoolStrategy memory ps = _poolStrategyOf(poolId);
        return ENGINE.effectiveLiquidity(ps.strategyId, ps.baseLiquidity0);
    }

    /// @inheritdoc IHookStrategyAdapter
    function getEffectiveLiquidityBothSides(PoolId poolId) external view returns (uint256 amount0, uint256 amount1) {
        PoolStrategy memory ps = _poolStrategyOf(poolId);
        amount0 = ENGINE.effectiveLiquidity(ps.strategyId, ps.baseLiquidity0);
        amount1 = ENGINE.effectiveLiquidity(ps.strategyId, ps.baseLiquidity1);
    }

    /// @inheritdoc IHookStrategyAdapter
    function quoteSnapshot(PoolId poolId) external view returns (StrategyMode mode, uint16 spreadBps, uint256 amount0, uint256 amount1) {
        PoolStrategy memory ps = _poolStrategyOf(poolId);
        (, LiquidityConfig memory config) = ENGINE.preview(ps.strategyId);
        mode = config.mode;
        spreadBps = config.spreadBps;
        amount0 = ENGINE.effectiveLiquidity(ps.strategyId, ps.baseLiquidity0);
        amount1 = ENGINE.effectiveLiquidity(ps.strategyId, ps.baseLiquidity1);
    }
}
