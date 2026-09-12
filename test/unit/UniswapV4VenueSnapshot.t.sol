// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { SolverFixture } from "../utils/SolverFixture.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";

/// @notice Isolated correctness check for {UniswapV4Venue.snapshot}, independent of the Solver:
///         every number must match the hook's own `quoteSnapshot`/live pool spot price.
contract UniswapV4VenueSnapshotTest is SolverFixture {
    function setUp() public {
        _setUpSolver();
    }

    function test_SnapshotMatchesHookQuoteAndPoolPrice() public view {
        ILiquidityVenue.VenueSnapshot memory snap = uniVenue.snapshot(address(tokenA), address(tokenB));

        (IStrategyTypes.StrategyMode mode, uint16 spreadBps, uint256 amount0,) = hook.quoteSnapshot(poolId);

        assertEq(snap.venue, address(uniVenue));
        assertEq(snap.strategyId, uniStrategyId);
        assertEq(uint8(snap.mode), uint8(mode));
        assertEq(snap.spreadBps, spreadBps);
        assertEq(snap.effectiveLiquidity, amount0);
        // Pool initialized 1:1.
        assertEq(snap.referencePrice, 1e18);
    }

    function test_RevertWhen_QueryingWrongPair() public {
        address unrelated = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityVenue.UnknownPair.selector, address(tokenA), unrelated));
        uniVenue.snapshot(address(tokenA), unrelated);
    }
}
