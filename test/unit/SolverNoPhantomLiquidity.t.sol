// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { SolverFixture } from "../utils/SolverFixture.sol";
import { ISolver } from "../../contracts/solver/interfaces/ISolver.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { IExecutableLiquidity } from "../../contracts/venues/interfaces/IExecutableLiquidity.sol";

/// @notice Feature 2 — NO PHANTOM LIQUIDITY.
///
/// @dev The product thesis, stated as executable assertions: the solver must never allocate more
///      than `min(virtual, wallet, allowance, conditional)`, and must never be able to settle
///      against a number that was true at discovery time but is false at settlement time.
contract SolverNoPhantomLiquidityTest is SolverFixture {
    function setUp() public {
        _setUpSolver();
        _fundTrader(trader, 500 ether, 500 ether);
    }

    /// @dev Every leg of every route, at every regime, obeys `allocated <= executableLiquidity`.
    function _assertNoLegExceedsExecutable(ISolver.ExecutionPlan memory plan) internal view {
        for (uint256 i = 0; i < plan.legs.length; ++i) {
            ISolver.RouteLeg memory leg = plan.legs[i];
            IExecutableLiquidity.ExecutableLiquidity memory exec =
                ILiquidityVenue(leg.venue).executableLiquidity(plan.tokenIn, plan.tokenOut);
            assertLe(leg.amountIn, exec.conditionalLiquidity, "leg allocated more than the venue can settle");
        }
    }

    function _request(uint256 amount) internal view returns (ISolver.TraderRequest memory) {
        return ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: amount, maxSlippageBps: 10_000 });
    }

    // ---- routing never allocates phantom depth ----

    function test_RouteNeverAllocatesBeyondExecutableLiquidity() public {
        _setAquaMakerWalletBalance(tokenA, 12 ether); // Aqua advertises 100, can deliver 12

        ISolver.ExecutionPlan memory plan = solver.route(_request(50 ether));
        _assertNoLegExceedsExecutable(plan);

        // Aqua is the better-priced venue, so a naive router fills it first to its *advertised*
        // 100 and never touches Uniswap. The solvency bound is what forces the split.
        assertEq(plan.legs.length, 2);
        assertEq(plan.legs[0].venue, address(aquaVenue));
        assertEq(plan.legs[0].amountIn, 12 ether);
        assertEq(plan.legs[1].amountIn, 38 ether);
    }

    function test_InsolventMakerIsExcludedFromRouteEntirely() public {
        _setAquaMakerWalletBalance(tokenA, 0);

        ISolver.ExecutionPlan memory plan = solver.route(_request(50 ether));

        assertEq(plan.legs.length, 1, "a maker that cannot pay is not a liquidity source");
        assertEq(plan.legs[0].venue, address(uniVenue));
    }

    function test_RevokedApprovalRemovesMakerFromRoute() public {
        _setAquaMakerAllowance(tokenA, 0);

        ISolver.ExecutionPlan memory plan = solver.route(_request(50 ether));
        assertEq(plan.legs.length, 1);
        assertEq(plan.legs[0].venue, address(uniVenue));
    }

    /// @dev The advertised total (100 + 100) would cover this; the deliverable total (5 + 100)
    ///      does not. The solver must report the *real* shortfall, not the advertised one.
    function test_RevertWhen_OnlyPhantomLiquidityWouldCoverTheRequest() public {
        _setAquaMakerWalletBalance(tokenA, 5 ether);

        vm.expectRevert(abi.encodeWithSelector(ISolver.NoRoute.selector, address(tokenA), address(tokenB), 150 ether, 105 ether));
        solver.route(_request(150 ether));
    }

    // ---- settlement revalidates, and discovery-time numbers are never sufficient ----

    /// @dev The headline scenario from the spec: a route is built while the maker is solvent, the
    ///      maker's wallet drains before settlement, and settlement must refuse rather than
    ///      half-fill. This is the case an indexer-driven solver gets wrong.
    function test_MakerWalletDrainBetweenRouteAndSettleForcesReroute() public {
        ISolver.TraderRequest memory request = _request(60 ether);

        ISolver.ExecutionPlan memory plan = solver.route(request);
        assertEq(plan.legs[0].venue, address(aquaVenue));
        assertEq(plan.legs[0].amountIn, 60 ether, "route was valid when it was built");

        _setAquaMakerWalletBalance(tokenA, 1 ether); // maker withdraws underneath the plan

        // `settle` re-derives the route from live state, so it now sees only 1 ether of Aqua depth
        // and 100 of Uniswap: still enough in total, so it reroutes rather than reverting.
        vm.prank(trader);
        solver.settle(request, 0);

        ISolver.ExecutionPlan memory after_ = solver.route(request);
        _assertNoLegExceedsExecutable(after_);
    }

    /// @dev Same shape, but now the drain makes the request genuinely unfillable. Settlement must
    ///      revert atomically — no partial fill, no tokens taken from the trader.
    function test_RevertWhen_DrainMakesRequestUnfillableAtSettlement() public {
        ISolver.TraderRequest memory request = _request(150 ether);
        solver.route(request); // valid right now: 100 Aqua + 100 Uniswap

        _setAquaMakerWalletBalance(tokenA, 5 ether);

        uint256 traderBalanceBefore = tokenA.balanceOf(trader);

        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ISolver.NoRoute.selector, address(tokenA), address(tokenB), 150 ether, 105 ether));
        solver.settle(request, 0);

        assertEq(tokenA.balanceOf(trader), traderBalanceBefore, "a refused settlement must not move trader funds");
    }

    /// @dev Proves the second read in `settle` is load-bearing rather than decorative. A plan is
    ///      built, then the maker revokes; a solver that trusted its own earlier plan would push
    ///      tokens into a venue that cannot pay.
    function test_SettlementRevalidationCatchesRevocationAfterPlanning() public {
        ISolver.TraderRequest memory request = _request(60 ether);
        solver.route(request);

        _setAquaMakerAllowance(tokenA, 0);

        vm.prank(trader);
        uint256 out = solver.settle(request, 0);

        // Rerouted entirely onto Uniswap, and actually delivered.
        assertGt(out, 0);
        assertEq(tokenB.balanceOf(address(solver)), 0, "solver must not retain output");
    }

    // ---- the invariant holds across every regime ----

    function test_InvariantHoldsInDefensiveAndRecovery() public {
        _setSharedVolatility(6500, 4000e18);
        _assertNoLegExceedsExecutable(solver.route(_request(40 ether)));

        aquaEngine.poke(aquaStrategyId);
        uniEngine.poke(uniStrategyId);
        _setSharedVolatility(2000, 4000e18);
        aquaEngine.poke(aquaStrategyId);
        uniEngine.poke(uniStrategyId);
        vm.warp(block.timestamp + 10 minutes);
        aquaEngine.poke(aquaStrategyId);
        uniEngine.poke(uniStrategyId);

        _assertNoLegExceedsExecutable(solver.route(_request(80 ether)));
    }
}
