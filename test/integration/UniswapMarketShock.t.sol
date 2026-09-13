// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";

import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { UniswapExecutionFixture } from "../utils/UniswapExecutionFixture.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @title UniswapMarketShockTest
/// @notice The Uniswap v4 counterpart of `test/integration/MarketShock.t.sol`. Same narrative, same
///         numbers (100 token base, 25/50/100 percent liquidity), same strategy semantics - driven
///         through a real PoolManager instead of Aqua/SwapVM.
///
///   Trader swaps 10 tokenX -> real settlement
///          |
///          v
///   MARKET SHOCK: volatility jumps to 63%
///          |
///          v
///   Strategy transitions to DEFENSIVE inside the same swap tx; liquidity 100% -> 25%
///          |
///          v
///   A 50 tokenX swap is rejected: exceeds the 25 token effective cap
///          |
///          v
///   Volatility falls and holds below 30% for the calm period -> RECOVERY (50% liquidity)
///          |
///          v
///   Recovery period elapses -> NORMAL (100% liquidity restored)
contract UniswapMarketShockTest is UniswapExecutionFixture {
    uint256 internal clock;

    function setUp() public {
        _setUpUniswap();
        _fundTrader(trader, 1000 ether, 1000 ether);
        clock = block.timestamp;
    }

    function _advance(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
    }

    function test_FullMarketShockAndRecoveryCycle() public {
        // NORMAL: a 10 token swap settles normally.
        BalanceDelta normalDelta = _swapXToY(trader, 10 ether);
        assertGt(uint128(normalDelta.amount1()), 0);
        assertEq(uint8(hook.getCurrentMode(poolId)), uint8(IStrategyTypes.StrategyMode.NORMAL));

        // SHOCK: volatility spikes to 63%.
        oracle.setVolatility(strategyId, 6300, 4000e18);
        _swapXToY(trader, 1 ether); // commits the transition
        assertEq(uint8(hook.getCurrentMode(poolId)), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
        assertEq(hook.getEffectiveLiquidity(poolId), 25 ether);

        // A 50 token swap is limited/rejected while DEFENSIVE.
        _expectExceedsEffectiveLiquidity(50 ether, 25 ether);
        _swapXToY(trader, 50 ether);

        // MARKET RECOVERS: volatility falls and stays below 30% for the full calm period.
        oracle.setVolatility(strategyId, 2400, 4000e18);
        _swapXToY(trader, 1 ether); // arms the sustained-calm rule
        assertEq(uint8(hook.getCurrentMode(poolId)), uint8(IStrategyTypes.StrategyMode.DEFENSIVE), "not yet sustained");

        _advance(StrategyFixtures.CALM_PERIOD);
        _swapXToY(trader, 1 ether);
        assertEq(uint8(hook.getCurrentMode(poolId)), uint8(IStrategyTypes.StrategyMode.RECOVERY));
        assertEq(hook.getEffectiveLiquidity(poolId), 50 ether);

        // Liquidity increases: 40 tokens now fits under the 50 token recovery cap.
        BalanceDelta recoveryDelta = _swapXToY(trader, 40 ether);
        assertGt(uint128(recoveryDelta.amount1()), 0);

        // Recovery period elapses: liquidity is fully restored.
        _advance(StrategyFixtures.RECOVERY_PERIOD);
        _swapXToY(trader, 1 ether);
        assertEq(uint8(hook.getCurrentMode(poolId)), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(hook.getEffectiveLiquidity(poolId), BASE_LIQUIDITY);

        BalanceDelta restoredDelta = _swapXToY(trader, 80 ether);
        assertGt(uint128(restoredDelta.amount1()), 0);
    }

    /// @notice Real balances move on both the successful legs and are untouched by the rejected one.
    function test_RealTokenBalancesChangeOnSuccessNotOnRejection() public {
        uint256 traderXBefore = tokenX.balanceOf(trader);

        _swapXToY(trader, 10 ether);
        assertEq(tokenX.balanceOf(trader), traderXBefore - 10 ether);

        oracle.setVolatility(strategyId, 6300, 4000e18);
        _swapXToY(trader, 1 ether);
        uint256 traderXBeforeRejected = tokenX.balanceOf(trader);

        _expectExceedsEffectiveLiquidity(50 ether, 25 ether);
        _swapXToY(trader, 50 ether);

        assertEq(tokenX.balanceOf(trader), traderXBeforeRejected, "rejected swap must not move any tokens");
    }
}
