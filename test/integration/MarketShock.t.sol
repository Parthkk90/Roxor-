// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { IConditionalLiquidityExtruction } from "../../contracts/swapvm/interfaces/IConditionalLiquidityExtruction.sol";
import { ExecutionFixture } from "../utils/ExecutionFixture.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @title MarketShockTest
/// @notice End-to-end demonstration of the protocol's thesis, executed against the real 1inch
///         Aqua + SwapVM contracts with actual ERC-20 balance movement — no mocked settlement.
///
///   Maker ships 100 ETH-equivalent of liquidity to Aqua
///          |
///          v
///   ETH/USDC strategy, volatility 20% -> NORMAL, 100% liquidity available
///          |
///          v
///   10 ETH trade settles: real tokens move taker <-> maker wallets
///          |
///          v
///   MARKET SHOCK: volatility jumps to 65%
///          |
///          v
///   Strategy transitions to DEFENSIVE inside the same swap tx; liquidity 100% -> 25%
///          |
///          v
///   A 50 ETH trade is rejected: it exceeds the 25 ETH effective cap
///          |
///          v
///   Volatility falls and holds below 30% for the calm period -> RECOVERY (50% liquidity)
///          |
///          v
///   Recovery period elapses -> NORMAL (100% liquidity restored)
contract MarketShockTest is ExecutionFixture {
    function setUp() public {
        _setUpExecution();
        _fundTaker(taker, 1000 ether, 1_000_000e6);
    }

    /* ------------------------------------------------------------------ real settlement */

    function test_RealSwapMovesActualErc20Balances() public {
        uint256 takerABefore = tokenA.balanceOf(taker);
        uint256 takerBBefore = tokenB.balanceOf(taker);
        uint256 makerABefore = tokenA.balanceOf(maker);
        uint256 makerBBefore = tokenB.balanceOf(maker);

        (uint256 amountIn, uint256 amountOut) = _swapAToB(taker, 10 ether, 0);

        assertGt(amountOut, 0, "must actually receive output");
        assertEq(tokenA.balanceOf(taker), takerABefore - amountIn, "taker tokenA debited");
        assertEq(tokenB.balanceOf(taker), takerBBefore + amountOut, "taker tokenB credited");
        assertEq(tokenA.balanceOf(maker), makerABefore + amountIn, "maker tokenA credited from taker");
        assertEq(tokenB.balanceOf(maker), makerBBefore - amountOut, "maker tokenB debited to taker");
    }

    function test_QuoteMatchesSwapOutcome() public {
        (uint256 quotedIn, uint256 quotedOut,) = router.asView().quote(order, 10 ether, _takerDataAToB(10 ether, 0));
        (uint256 actualIn, uint256 actualOut) = _swapAToB(taker, 10 ether, 0);

        assertEq(quotedIn, actualIn);
        assertEq(quotedOut, actualOut);
    }

    /* ------------------------------------------------------------------ liquidity enforcement */

    function test_SmallTradeSucceedsInNormalMode() public {
        (, uint256 amountOut) = _swapAToB(taker, 10 ether, 0);
        assertGt(amountOut, 0);
    }

    /// @notice The headline invariant: a strategy's stated liquidity cap cannot be bypassed by
    ///         simply submitting a larger trade. The taker cannot "just ignore" DEFENSIVE mode.
    function test_ShockThenOversizedTradeIsRejected() public {
        oracle.setVolatility(strategyId, 6300, 4000e18); // 63%

        // A small trade both fits under the new 25 ETH cap and commits the DEFENSIVE transition.
        _swapAToB(taker, 5 ether, 0);
        IStrategyTypes.RuntimeState memory s = registry.getStrategyState(strategyId);
        assertEq(uint8(s.mode), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
        assertEq(s.liquidityBps, StrategyFixtures.DEFENSIVE_LIQ);

        // 50 ETH exceeds the effective cap (maker's live tokenA balance * 25%) and must revert.
        // The cap is read fresh rather than hardcoded: the prior 5 ETH trade already grew the
        // maker's Aqua balance for tokenA, so the cap is not simply 100 ETH * 25%.
        uint256 cap = _currentCapA();
        vm.expectRevert(
            abi.encodeWithSelector(IConditionalLiquidityExtruction.ExceedsEffectiveLiquidity.selector, strategyId, 50 ether, cap)
        );
        _swapAToB(taker, 50 ether, 0);
    }

    /// @notice A trade sized to fit the reduced cap still succeeds during DEFENSIVE mode, at the
    ///         wider spread.
    function test_TradeWithinCapSucceedsDuringDefensive() public {
        oracle.setVolatility(strategyId, 6300, 4000e18);
        _swapAToB(taker, 5 ether, 0); // commit the transition

        (, uint256 amountOut) = _swapAToB(taker, 20 ether, 0); // within the 25 ETH cap
        assertGt(amountOut, 0);
    }

    /* ------------------------------------------------------------------ full cycle */

    function test_FullMarketShockAndRecoveryCycle() public {
        // NORMAL: a 10 ETH trade settles normally.
        (, uint256 normalOut) = _swapAToB(taker, 10 ether, 0);
        assertGt(normalOut, 0);

        // SHOCK: volatility spikes to 63%.
        oracle.setVolatility(strategyId, 6300, 4000e18);
        engine.poke(strategyId); // permissionless: anyone may advance the state machine
        assertEq(uint8(registry.getStrategyState(strategyId).mode), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
        assertEq(registry.getStrategyState(strategyId).liquidityBps, StrategyFixtures.DEFENSIVE_LIQ);

        // A 50 ETH trade is limited/rejected while DEFENSIVE.
        uint256 defensiveCap = _currentCapA();
        vm.expectRevert(
            abi.encodeWithSelector(IConditionalLiquidityExtruction.ExceedsEffectiveLiquidity.selector, strategyId, 50 ether, defensiveCap)
        );
        _swapAToB(taker, 50 ether, 0);

        // MARKET RECOVERS: volatility falls and stays below 30% for the full calm period.
        // Clock is tracked explicitly rather than chaining `vm.warp(block.timestamp + x)`: under
        // via_ir, Solidity can common-subexpression-eliminate `block.timestamp` across cheatcode
        // calls within one call frame, silently replaying an earlier timestamp on the second warp.
        uint256 clock = block.timestamp;
        oracle.setVolatility(strategyId, 2400, 4000e18);
        engine.poke(strategyId); // arms the sustained-calm rule
        clock += StrategyFixtures.CALM_PERIOD;
        vm.warp(clock);
        engine.poke(strategyId);
        assertEq(uint8(registry.getStrategyState(strategyId).mode), uint8(IStrategyTypes.StrategyMode.RECOVERY));
        assertEq(registry.getStrategyState(strategyId).liquidityBps, StrategyFixtures.RECOVERY_LIQ);

        // Liquidity increases: 40 ETH now fits under the 50 ETH recovery cap.
        (, uint256 recoveryOut) = _swapAToB(taker, 40 ether, 0);
        assertGt(recoveryOut, 0);

        // Recovery period elapses: liquidity is fully restored.
        clock += StrategyFixtures.RECOVERY_PERIOD;
        vm.warp(clock);
        engine.poke(strategyId);
        assertEq(uint8(registry.getStrategyState(strategyId).mode), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(registry.getStrategyState(strategyId).liquidityBps, StrategyFixtures.NORMAL_LIQ);

        (, uint256 restoredOut) = _swapAToB(taker, 80 ether, 0);
        assertGt(restoredOut, 0);
    }

    /// @dev Mirrors `_swapAToB`'s taker traits exactly, via the same protocol builder, so the
    ///      quote path and swap path are guaranteed to describe the same taker intent.
    function _takerDataAToB(
        uint256,
        /* amountIn */
        uint256 minOut
    )
        private
        pure
        returns (bytes memory)
    {
        TakerTraitsLib.Args memory targs;
        targs.taker = address(0);
        targs.isExactIn = true;
        targs.isFirstTransferFromTaker = true;
        targs.useTransferFromAndAquaPush = true;
        targs.isAToB = true;
        targs.threshold = abi.encodePacked(minOut);
        return TakerTraitsLib.build(targs);
    }
}
