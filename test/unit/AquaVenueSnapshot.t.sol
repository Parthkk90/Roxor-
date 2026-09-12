// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { SolverFixture } from "../utils/SolverFixture.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";

/// @notice Isolated correctness check for {AquaVenue.snapshot}, independent of the Solver: every
///         number must match a hand-computed value from {ENGINE.preview}/{effectiveLiquidity} and
///         Aqua's own live reserves.
contract AquaVenueSnapshotTest is SolverFixture {
    function setUp() public {
        _setUpSolver();
    }

    function test_SnapshotMatchesEngineAndAquaReserves() public view {
        ILiquidityVenue.VenueSnapshot memory snap = aquaVenue.snapshot(address(tokenA), address(tokenB));

        assertEq(snap.venue, address(aquaVenue));
        assertEq(snap.strategyId, aquaStrategyId);
        assertEq(uint8(snap.mode), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(snap.spreadBps, 20); // StrategyFixtures.NORMAL_SPREAD
        assertEq(snap.effectiveLiquidity, aquaEngine.effectiveLiquidity(aquaStrategyId, BASE_LIQUIDITY));
        // Reserve ratio: 150 tokenB shipped against 100 tokenA -> 1.5 WAD.
        assertEq(snap.referencePrice, 1.5e18);
    }

    function test_SnapshotIsDirectionAware() public view {
        ILiquidityVenue.VenueSnapshot memory aToB = aquaVenue.snapshot(address(tokenA), address(tokenB));
        ILiquidityVenue.VenueSnapshot memory bToA = aquaVenue.snapshot(address(tokenB), address(tokenA));

        assertEq(aToB.effectiveLiquidity, aquaEngine.effectiveLiquidity(aquaStrategyId, BASE_LIQUIDITY));
        assertEq(bToA.effectiveLiquidity, aquaEngine.effectiveLiquidity(aquaStrategyId, AQUA_BASE_LIQUIDITY_B));
        // Prices are the reserve ratio in each direction: A->B is 150/100, B->A is 100/150.
        assertEq(aToB.referencePrice, 1.5e18);
        assertEq(bToA.referencePrice, (BASE_LIQUIDITY * 1e18) / AQUA_BASE_LIQUIDITY_B);
    }

    function test_RevertWhen_QueryingWrongPair() public {
        address unrelated = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityVenue.UnknownPair.selector, address(tokenA), unrelated));
        aquaVenue.snapshot(address(tokenA), unrelated);
    }
}
