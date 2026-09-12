// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { SolverFixture } from "../utils/SolverFixture.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { ISolver } from "../../contracts/solver/interfaces/ISolver.sol";
import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

contract SolverRoutingTest is SolverFixture {
    function setUp() public {
        _setUpSolver();
    }

    // ---- Test 1: Venue Discovery ----

    function test_DiscoversBothVenues() public view {
        ILiquidityVenue[] memory list = solver.venues();
        assertEq(list.length, 2);
        assertEq(address(list[0]), address(aquaVenue));
        assertEq(address(list[1]), address(uniVenue));
    }

    // ---- Test 2: State-Aware Liquidity ----

    function test_StateAwareLiquidity_Normal() public view {
        assertEq(uint8(aquaVenue.snapshot(address(tokenA), address(tokenB)).mode), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(aquaVenue.snapshot(address(tokenA), address(tokenB)).effectiveLiquidity, BASE_LIQUIDITY);
        assertEq(uniVenue.snapshot(address(tokenA), address(tokenB)).effectiveLiquidity, BASE_LIQUIDITY);
    }

    function test_StateAwareLiquidity_Defensive() public {
        _setSharedVolatility(6500, 4000e18); // 65% -> immediate NORMAL->DEFENSIVE, no timer

        ILiquidityVenue.VenueSnapshot memory aquaSnap = aquaVenue.snapshot(address(tokenA), address(tokenB));
        ILiquidityVenue.VenueSnapshot memory uniSnap = uniVenue.snapshot(address(tokenA), address(tokenB));

        assertEq(uint8(aquaSnap.mode), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
        assertEq(uint8(uniSnap.mode), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
        assertEq(aquaSnap.effectiveLiquidity, (BASE_LIQUIDITY * StrategyFixtures.DEFENSIVE_LIQ) / 10_000);
        assertEq(uniSnap.effectiveLiquidity, (BASE_LIQUIDITY * StrategyFixtures.DEFENSIVE_LIQ) / 10_000);
    }

    function test_StateAwareLiquidity_Recovery() public {
        // Drive both engines through NORMAL -> DEFENSIVE -> RECOVERY via real poke() calls,
        // exactly as a permissionless caller (or a swap) would.
        _setSharedVolatility(6500, 4000e18);
        aquaEngine.poke(aquaStrategyId);
        uniEngine.poke(uniStrategyId);

        uint256 clock = block.timestamp;
        _setSharedVolatility(2000, 4000e18); // calm: arms the sustained-calm rule
        aquaEngine.poke(aquaStrategyId);
        uniEngine.poke(uniStrategyId);

        clock += StrategyFixtures.CALM_PERIOD;
        vm.warp(clock);
        aquaEngine.poke(aquaStrategyId); // sustained: fires DEFENSIVE -> RECOVERY
        uniEngine.poke(uniStrategyId);

        ILiquidityVenue.VenueSnapshot memory aquaSnap = aquaVenue.snapshot(address(tokenA), address(tokenB));
        ILiquidityVenue.VenueSnapshot memory uniSnap = uniVenue.snapshot(address(tokenA), address(tokenB));

        assertEq(uint8(aquaSnap.mode), uint8(IStrategyTypes.StrategyMode.RECOVERY));
        assertEq(uint8(uniSnap.mode), uint8(IStrategyTypes.StrategyMode.RECOVERY));
        assertEq(aquaSnap.effectiveLiquidity, (BASE_LIQUIDITY * StrategyFixtures.RECOVERY_LIQ) / 10_000);
        assertEq(uniSnap.effectiveLiquidity, (BASE_LIQUIDITY * StrategyFixtures.RECOVERY_LIQ) / 10_000);
    }

    // ---- Test 3: Best Venue ----

    function test_ChoosesBestPricedVenue() public view {
        // Aqua's oracle price (4000e18) nets far higher than Uniswap's 1:1 pool spot price for a
        // request that fits entirely within one venue's cap: the solver must pick the single
        // better-priced venue rather than splitting needlessly.
        ISolver.TraderRequest memory request =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: 10 ether, maxSlippageBps: 10_000 });

        ISolver.ExecutionPlan memory plan = solver.route(request);

        assertEq(plan.legs.length, 1);
        assertEq(plan.legs[0].venue, address(aquaVenue));
        assertEq(plan.totalAmountIn, 10 ether);
    }

    // ---- Test 4: Conditional Availability ----

    function test_LiquidityDecreasesOnShock() public {
        ISolver.TraderRequest memory request =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: 1 ether, maxSlippageBps: 10_000 });

        ISolver.ExecutionPlan memory before = solver.route(request);
        assertEq(before.legs[0].venue, address(aquaVenue));

        _setSharedVolatility(6500, 4000e18); // shock: aqua cap drops to 25 ether

        // A request that used to fit entirely in Aqua at NORMAL now must split, since Aqua's
        // effective liquidity has shrunk to 25% of base.
        ISolver.TraderRequest memory bigRequest =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: 30 ether, maxSlippageBps: 10_000 });
        ISolver.ExecutionPlan memory afterShock = solver.route(bigRequest);
        assertEq(afterShock.legs.length, 2);
        assertEq(afterShock.legs[0].amountIn, 25 ether); // aqua's shrunk cap, filled first (better price)
    }

    // ---- Test 6: Split Routing ----

    function test_SplitsAcrossBothVenues() public {
        _setSharedVolatility(6500, 4000e18); // both caps shrink to 25 ether

        ISolver.TraderRequest memory request =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: 50 ether, maxSlippageBps: 10_000 });

        ISolver.ExecutionPlan memory plan = solver.route(request);

        assertEq(plan.legs.length, 2);
        uint256 sumIn = plan.legs[0].amountIn + plan.legs[1].amountIn;
        assertEq(sumIn, 50 ether);
        assertEq(plan.totalAmountIn, 50 ether);
    }

    // ---- Route correctness (DoD) ----

    function test_PlanAmountsSumToRequest() public view {
        ISolver.TraderRequest memory request =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: 10 ether, maxSlippageBps: 10_000 });

        ISolver.ExecutionPlan memory plan = solver.route(request);

        uint256 sumIn = 0;
        for (uint256 i = 0; i < plan.legs.length; ++i) {
            sumIn += plan.legs[i].amountIn;
        }
        assertEq(sumIn, request.amount);
        assertEq(plan.totalAmountIn, request.amount);
    }

    function test_ExpectedOutputMatchesActualSettlement() public {
        ISolver.TraderRequest memory request =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: 5 ether, maxSlippageBps: 10_000 });

        ISolver.ExecutionPlan memory plan = solver.route(request);

        _fundTrader(trader, 100 ether, 0);
        vm.prank(trader);
        uint256 actualOut = solver.settle(request, 0);

        // Aqua settles via a real XYCSwap constant-product curve, so the actual output need not
        // equal the linear reference-price estimate exactly (curve slippage on shallow reserves),
        // but it must stay in the right ballpark.
        assertApproxEqRel(actualOut, plan.totalExpectedAmountOut, 0.1e18);
    }
}
