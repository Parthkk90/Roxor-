// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { SolverFixture } from "../utils/SolverFixture.sol";
import { ExecutableLiquidityLib } from "../../contracts/libraries/ExecutableLiquidityLib.sol";
import { IExecutableLiquidity } from "../../contracts/venues/interfaces/IExecutableLiquidity.sol";

/// @notice Feature 3 - liquidity coverage: `deliverable / virtual`, clamped, in bps.
///
/// @dev Coverage is a *reliability* signal, never a settlement input. These tests pin both halves
///      of that: the arithmetic is exact and total (including the degenerate cases), and the
///      number that reaches a venue snapshot agrees with the library that produced it.
contract LiquidityCoverageTest is SolverFixture {
    // ---- pure arithmetic ----

    function test_FullCoverageWhenFullyDeliverable() public pure {
        assertEq(ExecutableLiquidityLib.coverageBps(100 ether, 100 ether), 10_000);
    }

    function test_PartialCoverage() public pure {
        assertEq(ExecutableLiquidityLib.coverageBps(82 ether, 100 ether), 8200);
        assertEq(ExecutableLiquidityLib.coverageBps(25 ether, 100 ether), 2500);
    }

    function test_ZeroDeliverableIsZeroCoverage() public pure {
        assertEq(ExecutableLiquidityLib.coverageBps(0, 100 ether), 0);
    }

    /// @dev Zero advertised depth reports 0, not 10_000. "Nothing to deliver" and "everything
    ///      advertised is deliverable" must not collapse into the same number, or the UI would
    ///      badge an empty maker as HEALTHY.
    function test_ZeroVirtualIsZeroCoverageNotFullCoverage() public pure {
        assertEq(ExecutableLiquidityLib.coverageBps(0, 0), 0);
    }

    /// @dev A maker holding more than they advertised is still only 100% covered; letting this
    ///      exceed 10_000 would make coverage useless as a bounded ranking signal.
    function test_CoverageIsClampedAboveOneHundredPercent() public pure {
        assertEq(ExecutableLiquidityLib.coverageBps(500 ether, 100 ether), 10_000);
    }

    function test_CoverageRoundsDown() public pure {
        // 1/3 -> 3333.33.. bps must never round up into a rosier reliability badge.
        assertEq(ExecutableLiquidityLib.coverageBps(1 ether, 3 ether), 3333);
    }

    function testFuzz_CoverageIsAlwaysWithinBounds(uint256 deliverable, uint256 virtualLiquidity) public pure {
        deliverable = bound(deliverable, 0, type(uint128).max);
        virtualLiquidity = bound(virtualLiquidity, 0, type(uint128).max);

        assertLe(ExecutableLiquidityLib.coverageBps(deliverable, virtualLiquidity), 10_000);
    }

    function testFuzz_CoverageIsMonotonicInDeliverable(uint128 virtualLiquidity, uint128 lo, uint128 hi) public pure {
        vm.assume(virtualLiquidity > 0);
        vm.assume(lo <= hi);

        assertLe(ExecutableLiquidityLib.coverageBps(lo, virtualLiquidity), ExecutableLiquidityLib.coverageBps(hi, virtualLiquidity));
    }

    // ---- coverage as reported by real venues ----

    function test_SolventVenuesReportFullCoverage() public {
        _setUpSolver();

        assertEq(aquaVenue.snapshot(address(tokenA), address(tokenB)).coverageBps, 10_000);
        // A v4 pool holds its own reserves, so it is structurally fully covered.
        assertEq(uniVenue.snapshot(address(tokenA), address(tokenB)).coverageBps, 10_000);
    }

    function test_DrainedMakerReportsDegradedCoverage() public {
        _setUpSolver();
        _setAquaMakerWalletBalance(tokenA, 82 ether);

        IExecutableLiquidity.ExecutableLiquidity memory exec = aquaVenue.executableLiquidity(address(tokenA), address(tokenB));

        assertEq(exec.coverageBps, 8200); // the spec's worked example
        assertEq(aquaVenue.snapshot(address(tokenA), address(tokenB)).coverageBps, 8200);
    }

    /// @dev Coverage tracks *solvency*, not regime. A DEFENSIVE maker who is good for every token
    ///      they still advertise is fully covered - they are cautious, not unreliable. Conflating
    ///      the two would double-penalise a well-behaved maker during a shock.
    function test_CoverageIsIndependentOfStrategyMode() public {
        _setUpSolver();
        _setSharedVolatility(6500, 4000e18);

        assertEq(aquaVenue.snapshot(address(tokenA), address(tokenB)).coverageBps, 10_000);
    }
}
