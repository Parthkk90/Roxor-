// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { SolverFixture } from "../utils/SolverFixture.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { ISolver } from "../../contracts/solver/interfaces/ISolver.sol";

/// @notice Fuzzes volatility (which drives each venue's live effective liquidity via the existing
///         rule engine) and request size, and checks the solver's core invariant: it never
///         allocates more than a venue's live effective liquidity, and it never fills a request
///         beyond the sum of both venues' live effective liquidity (reverting {ISolver.NoRoute}
///         instead of inventing liquidity that doesn't exist).
contract SolverRoutingFuzzTest is SolverFixture {
    function setUp() public {
        _setUpSolver();
    }

    function testFuzz_NeverAllocatesMoreThanLiveEffectiveLiquidity(uint16 volatilityBps, uint256 requestAmount) public {
        volatilityBps = uint16(bound(volatilityBps, 0, 10_000));
        requestAmount = bound(requestAmount, 1, 400 ether);

        _setSharedVolatility(volatilityBps, 4000e18);

        ILiquidityVenue.VenueSnapshot memory aquaSnap = aquaVenue.snapshot(address(tokenA), address(tokenB));
        ILiquidityVenue.VenueSnapshot memory uniSnap = uniVenue.snapshot(address(tokenA), address(tokenB));
        uint256 totalExecutable = aquaSnap.effectiveLiquidity + uniSnap.effectiveLiquidity;

        ISolver.TraderRequest memory request =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: requestAmount, maxSlippageBps: 10_000 });

        if (requestAmount > totalExecutable) {
            vm.expectRevert(
                abi.encodeWithSelector(ISolver.NoRoute.selector, address(tokenA), address(tokenB), requestAmount, totalExecutable)
            );
            solver.route(request);
            return;
        }

        ISolver.ExecutionPlan memory plan = solver.route(request);

        uint256 sumIn = 0;
        for (uint256 i = 0; i < plan.legs.length; ++i) {
            ISolver.RouteLeg memory leg = plan.legs[i];
            uint256 venueCap = leg.venue == address(aquaVenue) ? aquaSnap.effectiveLiquidity : uniSnap.effectiveLiquidity;
            assertLe(leg.amountIn, venueCap);
            sumIn += leg.amountIn;
        }
        assertEq(sumIn, requestAmount);
        assertLe(sumIn, totalExecutable);
    }
}
