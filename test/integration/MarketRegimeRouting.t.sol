// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { SolverFixture } from "../utils/SolverFixture.sol";
import { ISolver } from "../../contracts/solver/interfaces/ISolver.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { IExecutableLiquidity } from "../../contracts/venues/interfaces/IExecutableLiquidity.sol";
import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { LiquidityHealthLens } from "../../contracts/solver/LiquidityHealth.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @notice Features 6 & 7 — market-regime routing, end to end, with real settlement.
///
/// @dev Walks the full demo narrative in one test: all venues NORMAL, a large trade routed and
///      actually executed; volatility spikes, the strategy shifts to DEFENSIVE, depth collapses
///      and the route changes; calm returns, RECOVERY restores partial depth; and finally a maker
///      quietly drains their wallet while advertising the same virtual balance, and the solver
///      refuses the phantom depth. Every step settles real ERC20 through real Aqua/SwapVM and a
///      real Uniswap v4 pool — no mocked venues, no simulated fills.
contract MarketRegimeRoutingTest is SolverFixture {
    LiquidityHealthLens internal lens;

    function setUp() public {
        _setUpSolver();
        lens = new LiquidityHealthLens();
        _fundTrader(trader, 1000 ether, 1000 ether);
    }

    function _request(uint256 amount) internal view returns (ISolver.TraderRequest memory) {
        return ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: amount, maxSlippageBps: 10_000 });
    }

    function _aquaDepth() internal view returns (uint256) {
        return aquaVenue.snapshot(address(tokenA), address(tokenB)).effectiveLiquidity;
    }

    function _mode() internal view returns (IStrategyTypes.StrategyMode) {
        return aquaVenue.snapshot(address(tokenA), address(tokenB)).mode;
    }

    /// @dev The whole story, in order, as one continuous timeline.
    function test_FullMarketRegimeNarrative() public {
        // ---- 1-3. All NORMAL: a large trade routes and really settles. ----
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(_aquaDepth(), BASE_LIQUIDITY);

        ISolver.ExecutionPlan memory normalPlan = solver.route(_request(7 ether));
        assertEq(normalPlan.legs.length, 1, "7 fits inside the Aqua cap of 100 at NORMAL");
        assertEq(normalPlan.legs[0].venue, address(aquaVenue));

        uint256 traderOutBefore = tokenB.balanceOf(trader);
        vm.prank(trader);
        uint256 settled = solver.settle(_request(7 ether), 0);

        assertGt(settled, 0, "real settlement must deliver real tokens");
        assertEq(tokenB.balanceOf(trader) - traderOutBefore, settled, "trader actually received the output");

        // ---- 4-6. Volatility spikes: DEFENSIVE, depth collapses. ----
        _setSharedVolatility(6500, 4000e18);

        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
        uint256 defensiveDepth = _aquaDepth();
        assertLt(defensiveDepth, BASE_LIQUIDITY, "DEFENSIVE must shrink depth");

        // Spread widens with the regime: the maker prices risk, it does not merely withdraw.
        assertEq(aquaVenue.snapshot(address(tokenA), address(tokenB)).spreadBps, StrategyFixtures.DEFENSIVE_SPREAD);

        // ---- 7-8. The solver recalculates; the route changes shape. ----
        ISolver.ExecutionPlan memory defensivePlan = solver.route(_request(40 ether));
        assertEq(defensivePlan.legs.length, 2, "what fitted in one venue now needs a split");
        assertEq(defensivePlan.legs[0].venue, address(aquaVenue));
        assertEq(defensivePlan.legs[0].amountIn, defensiveDepth, "Aqua fills only to its shrunken cap");
        assertEq(defensivePlan.legs[1].venue, address(uniVenue));

        // And a large enough request becomes impossible outright rather than being over-filled.
        vm.expectRevert();
        solver.route(_request(300 ether));

        // The split still settles for real, across both backends at once.
        vm.prank(trader);
        uint256 splitOut = solver.settle(_request(40 ether), 0);
        assertGt(splitOut, 0, "combined Aqua + Uniswap v4 settlement delivered");

        // ---- 9-12. Calm returns: RECOVERY, then NORMAL. ----
        aquaEngine.poke(aquaStrategyId);
        uniEngine.poke(uniStrategyId);

        _setSharedVolatility(2000, 4000e18); // arms the sustained-calm rule
        aquaEngine.poke(aquaStrategyId);
        uniEngine.poke(uniStrategyId);

        vm.warp(block.timestamp + StrategyFixtures.CALM_PERIOD);
        aquaEngine.poke(aquaStrategyId); // sustained calm: DEFENSIVE -> RECOVERY
        uniEngine.poke(uniStrategyId);

        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.RECOVERY));
        uint256 recoveryDepth = _aquaDepth();
        assertGt(recoveryDepth, defensiveDepth, "RECOVERY restores depth above DEFENSIVE");
        assertLt(recoveryDepth, BASE_LIQUIDITY, "but not yet all the way back to NORMAL");

        // ---- 13. The solver routes again at the restored depth. ----
        // 30 no longer needs a split: restored depth means a single venue can absorb it. Which
        // venue that is has genuinely changed, and not because of regime — the earlier fills were
        // real, so Aqua's constant-product reserve ratio has walked down from 1.5 to well under
        // Uniswap's deep ~1.0 pool. The solver follows the live price, so it now prefers Uniswap.
        // Asserting "Aqua wins" here would be asserting that trades leave no market impact.
        ISolver.ExecutionPlan memory recoveryPlan = solver.route(_request(30 ether));
        assertEq(recoveryPlan.legs.length, 1, "restored depth absorbs 30 without splitting");
        assertEq(recoveryPlan.legs[0].amountIn, 30 ether);

        ILiquidityVenue.VenueSnapshot memory aquaNow = aquaVenue.snapshot(address(tokenA), address(tokenB));
        ILiquidityVenue.VenueSnapshot memory uniNow = uniVenue.snapshot(address(tokenA), address(tokenB));
        assertLt(aquaNow.referencePrice, uniNow.referencePrice, "Aqua repriced below Uniswap after real fills");
        assertEq(recoveryPlan.legs[0].venue, address(uniVenue), "solver follows the better live price");
        assertGe(aquaNow.effectiveLiquidity, 30 ether, "Aqua could have filled it on depth alone");

        vm.prank(trader);
        assertGt(solver.settle(_request(30 ether), 0), 0);

        // ---- The twist: regime says healthy, solvency says otherwise. ----
        // The maker is in RECOVERY with restored depth and still advertising it, but has moved
        // their tokens out. Regime-aware routing alone would happily route here.
        _setAquaMakerWalletBalance(tokenA, 2 ether);

        IExecutableLiquidity.ExecutableLiquidity memory exec = aquaVenue.executableLiquidity(address(tokenA), address(tokenB));
        assertGt(exec.virtualLiquidity, 2 ether, "Aqua still advertises the old balance");
        assertEq(exec.deliverableLiquidity, 2 ether, "but only 2 can actually be delivered");
        assertLt(exec.coverageBps, 3000, "coverage collapses into UNRELIABLE territory");

        // Aqua is not even the preferred venue at this point, so the load-bearing assertion is
        // not "Aqua is excluded" but the invariant itself: whatever the solver gives Aqua, it
        // never exceeds what the maker can actually pay.
        ISolver.ExecutionPlan memory phantomPlan = solver.route(_request(30 ether));
        for (uint256 i = 0; i < phantomPlan.legs.length; ++i) {
            if (phantomPlan.legs[i].venue == address(aquaVenue)) {
                assertLe(phantomPlan.legs[i].amountIn, 2 ether, "never more than the maker can deliver");
            }
        }
        // 2 deliverable, then RECOVERY's 50% multiplier on top: the solvency bound and the
        // conditional haircut compose, they do not override one another.
        assertEq(
            aquaVenue.snapshot(address(tokenA), address(tokenB)).effectiveLiquidity,
            (2 ether * uint256(StrategyFixtures.RECOVERY_LIQ)) / 10_000
        );
    }

    /// @dev Regime changes must move depth *and* price together, since a solver that saw only one
    ///      of the two would mis-rank venues during a shock.
    function test_RegimeChangesDepthAndSpreadTogether() public {
        ILiquidityVenue.VenueSnapshot memory normal = aquaVenue.snapshot(address(tokenA), address(tokenB));
        assertEq(normal.spreadBps, StrategyFixtures.NORMAL_SPREAD);

        _setSharedVolatility(6500, 4000e18);
        ILiquidityVenue.VenueSnapshot memory defensive = aquaVenue.snapshot(address(tokenA), address(tokenB));

        assertLt(defensive.effectiveLiquidity, normal.effectiveLiquidity);
        assertGt(defensive.spreadBps, normal.spreadBps);
    }

    /// @dev The batched lens must agree with the individual venue reads it replaces, in the same
    ///      block — that equality is the only reason a UI may trust it.
    function test_LensAgreesWithIndividualVenueReads() public {
        _setSharedVolatility(6500, 4000e18);
        _setAquaMakerWalletBalance(tokenA, 18 ether);

        ILiquidityVenue[] memory venueList = solver.venues();
        LiquidityHealthLens.VenueHealth[] memory records = lens.health(venueList, address(tokenA), address(tokenB));

        assertEq(records.length, 2);
        for (uint256 i = 0; i < records.length; ++i) {
            ILiquidityVenue.VenueSnapshot memory direct = venueList[i].snapshot(address(tokenA), address(tokenB));
            assertEq(records[i].snapshot.effectiveLiquidity, direct.effectiveLiquidity);
            assertEq(records[i].snapshot.coverageBps, direct.coverageBps);
            assertEq(uint8(records[i].snapshot.mode), uint8(direct.mode));
            assertEq(
                records[i].executable.conditionalLiquidity,
                venueList[i].executableLiquidity(address(tokenA), address(tokenB)).conditionalLiquidity
            );
        }

        assertEq(
            lens.totalExecutableLiquidity(venueList, address(tokenA), address(tokenB)),
            records[0].executable.conditionalLiquidity + records[1].executable.conditionalLiquidity
        );
    }

    function test_LensTryRouteReportsUnroutableWithoutReverting() public view {
        (bool routable,) = lens.tryRoute(solver, _request(10 ether));
        assertTrue(routable);

        (bool impossible, ISolver.ExecutionPlan memory empty) = lens.tryRoute(solver, _request(100_000 ether));
        assertFalse(impossible);
        assertEq(empty.legs.length, 0);
    }
}
