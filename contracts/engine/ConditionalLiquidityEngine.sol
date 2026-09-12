// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IConditionalLiquidityEngine } from "./interfaces/IConditionalLiquidityEngine.sol";
import { IConditionalLiquidityRegistry } from "../core/interfaces/IConditionalLiquidityRegistry.sol";
import { IMarketStateProvider } from "../core/interfaces/IMarketStateProvider.sol";
import { FixedPointMath } from "../libraries/FixedPointMath.sol";
import { RuleEngineLib } from "../libraries/RuleEngineLib.sol";

/// @title ConditionalLiquidityEngine
/// @notice The stateful shell around the pure evaluation core.
///
/// @dev Responsibilities are split deliberately:
///        - {RuleEngineLib} decides *what* the new state is. It is pure and has no I/O.
///        - This contract performs the I/O: read the registry, read the oracle, write the registry.
///      Keeping the decision pure is what guarantees SwapVM's `quote()` (static context) and
///      `swap()` (mutating context) resolve to the same configuration.
contract ConditionalLiquidityEngine is IConditionalLiquidityEngine {
    using FixedPointMath for uint256;

    IConditionalLiquidityRegistry public immutable REGISTRY;
    IMarketStateProvider public immutable ORACLE;

    constructor(IConditionalLiquidityRegistry registry, IMarketStateProvider oracle) {
        REGISTRY = registry;
        ORACLE = oracle;
    }

    /// @inheritdoc IConditionalLiquidityEngine
    function preview(bytes32 strategyId) public view returns (RuntimeState memory next, LiquidityConfig memory config) {
        RuntimeState memory current = REGISTRY.getStrategyState(strategyId);
        MarketState memory market = ORACLE.getMarketState(strategyId);
        bytes memory program = REGISTRY.getRuleProgram(strategyId);
        return RuleEngineLib.evaluate(current, market, program, block.timestamp);
    }

    /// @inheritdoc IConditionalLiquidityEngine
    function poke(bytes32 strategyId) external returns (LiquidityConfig memory config) {
        require(REGISTRY.isActive(strategyId), StrategyNotActive(strategyId));

        RuntimeState memory current = REGISTRY.getStrategyState(strategyId);
        MarketState memory market = ORACLE.getMarketState(strategyId);
        bytes memory program = REGISTRY.getRuleProgram(strategyId);

        RuntimeState memory next;
        (next, config) = RuleEngineLib.evaluate(current, market, program, block.timestamp);
        next.lastExecution = uint64(block.timestamp);

        // Announce the decision before recording it, so a log reader sees the engine's reasoning
        // (which rule fired, on what trigger value) ahead of the registry's bare state write.
        if (next.mode != current.mode) {
            emit StateTransition(strategyId, current.mode, next.mode, block.timestamp, market.volatility);
        }
        if (next.liquidityBps != current.liquidityBps || next.spreadBps != current.spreadBps) {
            emit LiquidityConfigurationChanged(strategyId, next.liquidityBps, next.spreadBps);
        }

        REGISTRY.commitState(strategyId, next);
    }

    /// @inheritdoc IConditionalLiquidityEngine
    function effectiveLiquidity(bytes32 strategyId, uint256 makerBalance) external view returns (uint256) {
        if (!REGISTRY.isActive(strategyId)) {
            return 0;
        }
        (, LiquidityConfig memory config) = preview(strategyId);
        return makerBalance.mulBps(config.liquidityBps);
    }
}
