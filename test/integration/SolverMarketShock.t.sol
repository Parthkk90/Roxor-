// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { SolverFixture } from "../utils/SolverFixture.sol";
import { ISolver } from "../../contracts/solver/interfaces/ISolver.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @title SolverMarketShockTest
/// @notice Part 6's Test 7 / main demonstration: the solver routing real trades across BOTH the
///         Aqua and Uniswap v4 backends, through the same NORMAL -> DEFENSIVE -> RECOVERY ->
///         NORMAL cycle `test/integration/MarketShock.t.sol` and
///         `test/integration/UniswapMarketShock.t.sol` already prove independently per-backend.
///
///   NORMAL: solver picks the better-priced single venue for a small trade
///          |
///          v
///   MARKET SHOCK (65%): both venues' effective liquidity drops to 25% of base
///          |
///          v
///   A request too big for either venue alone now SPLITS across both
///          |
///          v
///   A request bigger than combined effective liquidity reverts NO_ROUTE (never invents liquidity)
///          |
///          v
///   Sustained calm -> RECOVERY (50%): the previously-impossible request becomes routable again
///          |
///          v
///   Recovery period elapses -> NORMAL (100%): full liquidity restored, single venue suffices again
contract SolverMarketShockTest is SolverFixture {
    uint256 internal clock;

    function setUp() public {
        _setUpSolver();
        _fundTrader(trader, 1000 ether, 0);
        clock = block.timestamp;
    }

    function _advance(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
    }

    function test_FullMarketShockAndRecoveryCycle() public {
        // ---- NORMAL: single best-priced venue handles a small trade for real ----
        uint256 balanceBefore = tokenB.balanceOf(trader);
        ISolver.TraderRequest memory smallRequest =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: 10 ether, maxSlippageBps: 10_000 });
        vm.prank(trader);
        uint256 out = solver.settle(smallRequest, 0);
        assertGt(out, 0);
        assertEq(tokenB.balanceOf(trader) - balanceBefore, out);
        assertEq(tokenA.balanceOf(trader), 1000 ether - 10 ether);

        // ---- SHOCK: volatility spikes to 65%, both venues' caps drop to 25 ether ----
        _setSharedVolatility(6500, 4000e18);
        aquaEngine.poke(aquaStrategyId); // permissionless: anyone may advance the state machine
        uniEngine.poke(uniStrategyId);

        ISolver.TraderRequest memory splitRequest =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: 40 ether, maxSlippageBps: 10_000 });
        ISolver.ExecutionPlan memory shockedPlan = solver.route(splitRequest);
        assertEq(shockedPlan.legs.length, 2); // no single venue's 25 ether cap covers 40 alone
        assertEq(shockedPlan.legs[0].amountIn + shockedPlan.legs[1].amountIn, 40 ether);

        vm.prank(trader);
        uint256 splitOut = solver.settle(splitRequest, 0);
        assertGt(splitOut, 0);

        // A request bigger than BOTH venues' shrunk caps combined must NEVER be invented; it
        // reverts NO_ROUTE rather than partially filling silently. Read live caps rather than
        // hardcoding them: each real trade above already grew the makers' underlying balances.
        uint256 totalExecutableAfterShock = aquaVenue.snapshot(address(tokenA), address(tokenB)).effectiveLiquidity
            + uniVenue.snapshot(address(tokenA), address(tokenB)).effectiveLiquidity;
        ISolver.TraderRequest memory tooBig = ISolver.TraderRequest({
            tokenIn: address(tokenA), tokenOut: address(tokenB), amount: totalExecutableAfterShock + 10 ether, maxSlippageBps: 10_000
        });
        vm.expectRevert(
            abi.encodeWithSelector(ISolver.NoRoute.selector, address(tokenA), address(tokenB), tooBig.amount, totalExecutableAfterShock)
        );
        solver.route(tooBig);

        // ---- MARKET RECOVERS: volatility falls and stays below 30% for the full calm period ----
        _setSharedVolatility(2400, 4000e18);
        aquaEngine.poke(aquaStrategyId); // arms the sustained-calm rule
        uniEngine.poke(uniStrategyId);

        _advance(StrategyFixtures.CALM_PERIOD);
        aquaEngine.poke(aquaStrategyId);
        uniEngine.poke(uniStrategyId);

        // RECOVERY: caps roughly double (50% vs 25% of base) - the previously-impossible request
        // is routable again.
        ISolver.ExecutionPlan memory recoveryPlan = solver.route(tooBig);
        uint256 recoverySumIn = recoveryPlan.legs[0].amountIn + (recoveryPlan.legs.length > 1 ? recoveryPlan.legs[1].amountIn : 0);
        assertEq(recoverySumIn, tooBig.amount);

        // ---- RECOVERY PERIOD ELAPSES: liquidity fully restored to 100% ----
        _advance(StrategyFixtures.RECOVERY_PERIOD);
        aquaEngine.poke(aquaStrategyId);
        uniEngine.poke(uniStrategyId);

        // Fully restored: whichever venue is now best-priced can alone cover most of its own live
        // cap in one leg (read live rather than hardcoded, since prior real trades grew balances).
        ILiquidityVenue.VenueSnapshot memory aquaFinal = aquaVenue.snapshot(address(tokenA), address(tokenB));
        ILiquidityVenue.VenueSnapshot memory uniFinal = uniVenue.snapshot(address(tokenA), address(tokenB));
        uint256 bestSingleVenueCap =
            aquaFinal.effectiveLiquidity > uniFinal.effectiveLiquidity ? aquaFinal.effectiveLiquidity : uniFinal.effectiveLiquidity;

        ISolver.TraderRequest memory restoredRequest = ISolver.TraderRequest({
            tokenIn: address(tokenA), tokenOut: address(tokenB), amount: bestSingleVenueCap / 2, maxSlippageBps: 10_000
        });
        ISolver.ExecutionPlan memory restoredPlan = solver.route(restoredRequest);
        assertEq(restoredPlan.legs.length, 1); // fits in one venue's restored cap alone

        vm.prank(trader);
        uint256 restoredOut = solver.settle(restoredRequest, 0);
        assertGt(restoredOut, 0);
    }
}
