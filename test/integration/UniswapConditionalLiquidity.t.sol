// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";

import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { IConditionalLiquidityHook } from "../../contracts/uniswap/interfaces/IConditionalLiquidityHook.sol";
import { UniswapExecutionFixture } from "../utils/UniswapExecutionFixture.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @title UniswapConditionalLiquidityTest
/// @notice Real Uniswap v4 execution: actual PoolManager, actual pool, actual hook, actual
///         ERC-20 settlement. No mocked PoolManager anywhere in this file.
contract UniswapConditionalLiquidityTest is UniswapExecutionFixture {
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

    /* ------------------------------------------------------------------ Step 11: NORMAL */

    function test_NormalStateAllowsValidSwap() public {
        assertEq(uint8(hook.getCurrentMode(poolId)), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(hook.getEffectiveLiquidity(poolId), BASE_LIQUIDITY, "100% of 100 token base");

        uint256 traderXBefore = tokenX.balanceOf(trader);
        uint256 traderYBefore = tokenY.balanceOf(trader);

        BalanceDelta delta = _swapXToY(trader, 10 ether);

        assertEq(uint256(uint128(-delta.amount0())), 10 ether, "exactly 10 tokenX pulled");
        assertGt(uint128(delta.amount1()), 0, "must receive tokenY");
        assertEq(tokenX.balanceOf(trader), traderXBefore - 10 ether, "trader tokenX debited");
        assertEq(tokenY.balanceOf(trader), traderYBefore + uint128(delta.amount1()), "trader tokenY credited");
    }

    function test_NormalSwapEmitsConditionalLiquidityApplied() public {
        vm.expectEmit(true, true, false, false, address(hook));
        emit IConditionalLiquidityHook.ConditionalLiquidityApplied(
            poolId,
            strategyId,
            IStrategyTypes.StrategyMode.NORMAL,
            IStrategyTypes.StrategyMode.NORMAL,
            10 ether,
            BASE_LIQUIDITY,
            StrategyFixtures.NORMAL_SPREAD,
            block.timestamp
        );
        _swapXToY(trader, 10 ether);
    }

    /* ------------------------------------------------------------------ Step 12: DEFENSIVE */

    function test_DefensiveModeRestrictsEffectiveLiquidity() public {
        oracle.setVolatility(strategyId, 6300, 4000e18); // 63%

        _swapXToY(trader, 5 ether); // commits the transition, well under any cap

        assertEq(uint8(hook.getCurrentMode(poolId)), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
        assertEq(hook.getEffectiveLiquidity(poolId), 25 ether, "25% of 100 token base");
    }

    function test_ExcessiveSwapRevertsDuringDefensive() public {
        oracle.setVolatility(strategyId, 6300, 4000e18);
        _swapXToY(trader, 5 ether); // commit DEFENSIVE

        _expectExceedsEffectiveLiquidity(50 ether, 25 ether);
        _swapXToY(trader, 50 ether);
    }

    function test_SwapWithinCapSucceedsDuringDefensive() public {
        oracle.setVolatility(strategyId, 6300, 4000e18);
        _swapXToY(trader, 5 ether);

        BalanceDelta delta = _swapXToY(trader, 20 ether); // within the 25 ETH cap
        assertGt(uint128(delta.amount1()), 0);
    }

    /* ------------------------------------------------------------------ Step 13: RECOVERY */

    /// @notice The state machine, not the test, decides the transition. This test only moves
    ///         volatility and time; every mode change is asserted against `RuleEngineLib`'s own
    ///         hysteresis and sustained-duration semantics (see StrategyFixtures.volatilityShield).
    function test_FullHysteresisCycleThroughRealSwaps() public {
        // NORMAL -> DEFENSIVE
        oracle.setVolatility(strategyId, 6300, 4000e18);
        _swapXToY(trader, 5 ether);
        assertEq(uint8(hook.getCurrentMode(poolId)), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));

        // Calm must be sustained: one calm sample does not yet transition.
        oracle.setVolatility(strategyId, 2400, 4000e18);
        _swapXToY(trader, 1 ether); // arms the sustained-calm rule
        assertEq(uint8(hook.getCurrentMode(poolId)), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));

        _advance(StrategyFixtures.CALM_PERIOD);
        _swapXToY(trader, 1 ether);
        assertEq(uint8(hook.getCurrentMode(poolId)), uint8(IStrategyTypes.StrategyMode.RECOVERY));
        assertEq(hook.getEffectiveLiquidity(poolId), 50 ether, "50% of 100 token base");

        _advance(StrategyFixtures.RECOVERY_PERIOD);
        _swapXToY(trader, 1 ether);
        assertEq(uint8(hook.getCurrentMode(poolId)), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(hook.getEffectiveLiquidity(poolId), BASE_LIQUIDITY, "liquidity fully restored");
    }
}
