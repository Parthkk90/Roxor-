// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IMarketStateProvider } from "../core/interfaces/IMarketStateProvider.sol";

/// @notice Test double for {IMarketStateProvider} with directly settable market conditions.
/// @dev Lets a test drive a strategy through a market shock deterministically, with no oracle.
contract MockMarketStateProvider is IMarketStateProvider {
    mapping(bytes32 strategyId => MarketState) private _states;
    MarketState private _default;

    /// @notice Set the snapshot returned for every strategy that has no specific override.
    function setDefaultMarketState(MarketState calldata state) external {
        _default = state;
    }

    /// @notice Set the snapshot returned for one specific strategy.
    function setMarketState(bytes32 strategyId, MarketState calldata state) external {
        _states[strategyId] = state;
    }

    /// @notice Convenience setter for the two fields most tests vary.
    function setVolatility(bytes32 strategyId, uint256 volatilityBps, uint256 price) external {
        MarketState storage s = _states[strategyId];
        s.volatility = volatilityBps;
        s.price = price;
        s.oracleConfidence = 10_000;
        s.timestamp = block.timestamp;
    }

    /// @inheritdoc IMarketStateProvider
    function getMarketState(bytes32 strategyId) external view returns (MarketState memory) {
        MarketState memory s = _states[strategyId];
        if (s.timestamp == 0) {
            return _default;
        }
        return s;
    }
}
