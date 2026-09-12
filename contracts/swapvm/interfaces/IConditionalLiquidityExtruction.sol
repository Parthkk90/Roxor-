// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IConditionalLiquidityExtruction
/// @notice Errors raised by the SwapVM Extruction target that enforces conditional-liquidity state.
interface IConditionalLiquidityExtruction {
    /// @notice The strategy has been deactivated by its maker.
    error StrategyNotActiveForExecution(bytes32 strategyId);

    /// @notice The requested trade would consume more than the strategy's current effective
    ///         liquidity allows. This is the hard stop that makes "DEFENSIVE mode limits the
    ///         maker's exposure to 25 ETH" an enforced invariant rather than a suggestion.
    error ExceedsEffectiveLiquidity(bytes32 strategyId, uint256 requested, uint256 available);
}
