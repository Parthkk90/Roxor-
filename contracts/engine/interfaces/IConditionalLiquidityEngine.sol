// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IStrategyTypes } from "../../core/interfaces/IStrategyTypes.sol";

/// @title IConditionalLiquidityEngine
/// @notice Turns market state into a liquidity configuration for a registered strategy.
interface IConditionalLiquidityEngine is IStrategyTypes {
    error StrategyNotActive(bytes32 strategyId);

    event StateTransition(
        bytes32 indexed strategyId, StrategyMode previousMode, StrategyMode newMode, uint256 timestamp, uint256 triggerVolatilityBps
    );

    event LiquidityConfigurationChanged(bytes32 indexed strategyId, uint16 liquidityBps, uint16 spreadBps);

    /// @notice Evaluate a strategy against current market conditions without persisting anything.
    /// @dev The read-only twin of {poke}. Because evaluation is pure, this returns exactly the
    ///      state {poke} would commit for the same block and market snapshot.
    function preview(bytes32 strategyId) external view returns (RuntimeState memory next, LiquidityConfig memory config);

    /// @notice Evaluate a strategy and commit the resulting state.
    /// @dev Permissionless. Advancing the state machine is a pure function of oracle data and
    ///      stored state, so a caller cannot steer the outcome by calling at will; they can only
    ///      pay gas to bring the strategy up to date.
    function poke(bytes32 strategyId) external returns (LiquidityConfig memory config);

    /// @notice The liquidity a strategy may currently quote against, given the maker's balance.
    /// @param strategyId Strategy to size.
    /// @param makerBalance Balance the maker has made available (via Aqua) for this strategy.
    /// @return The bounded amount the strategy is permitted to use.
    function effectiveLiquidity(bytes32 strategyId, uint256 makerBalance) external view returns (uint256);
}
