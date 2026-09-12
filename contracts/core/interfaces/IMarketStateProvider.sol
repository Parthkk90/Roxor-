// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IStrategyTypes } from "./IStrategyTypes.sol";

/// @title IMarketStateProvider
/// @notice Abstraction over whatever supplies market conditions to a strategy.
/// @dev Deliberately not bound to any specific oracle. A Pyth, Chainlink, Uniswap TWAP or
///      committee-signed provider can all implement this. The engine only requires that the
///      call is `view`, because SwapVM executes strategies in a static context during `quote()`
///      and the quote and swap paths must agree.
interface IMarketStateProvider is IStrategyTypes {
    /// @notice Return the current market state relevant to `strategyId`.
    /// @param strategyId Identifier of the strategy requesting the snapshot.
    /// @return state Current market conditions.
    function getMarketState(bytes32 strategyId) external view returns (MarketState memory state);
}
