// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { SolverFixture } from "../utils/SolverFixture.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { IExecutableLiquidity } from "../../contracts/venues/interfaces/IExecutableLiquidity.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @notice Feature 1 — real executable liquidity on the Aqua side.
///
/// @dev Every test here attacks the same premise: Aqua's virtual balance is an allowance, not
///      custody, so it is not evidence of solvency. `ship` moves no tokens and `pull` settles with
///      `safeTransferFrom(maker, ...)`. These tests pin down that {AquaVenue} reports what the
///      maker can actually deliver, not what they advertised.
contract AquaExecutableLiquidityTest is SolverFixture {
    function setUp() public {
        _setUpSolver();
    }

    /// @dev The fully-solvent baseline. Establishes that the solvency bounds are inert when the
    ///      maker is good for their quote, so every later assertion isolates one real constraint.
    function test_FullySolventMakerIsUnconstrained() public view {
        IExecutableLiquidity.ExecutableLiquidity memory exec = aquaVenue.executableLiquidity(address(tokenA), address(tokenB));

        assertEq(exec.virtualLiquidity, BASE_LIQUIDITY);
        assertEq(exec.walletLiquidity, BASE_LIQUIDITY);
        assertEq(exec.allowance, type(uint256).max);
        assertEq(exec.deliverableLiquidity, BASE_LIQUIDITY);
        assertEq(exec.conditionalLiquidity, BASE_LIQUIDITY); // NORMAL == 100% multiplier
        assertEq(exec.coverageBps, 10_000);
    }

    // ---- wallet balance is binding ----

    function test_WalletBalanceCapsExecutableLiquidity() public {
        _setAquaMakerWalletBalance(tokenA, 10 ether); // advertised 100, actually holds 10

        IExecutableLiquidity.ExecutableLiquidity memory exec = aquaVenue.executableLiquidity(address(tokenA), address(tokenB));

        assertEq(exec.virtualLiquidity, BASE_LIQUIDITY, "aqua still advertises the full balance");
        assertEq(exec.walletLiquidity, 10 ether);
        assertEq(exec.deliverableLiquidity, 10 ether, "bounded by the wallet, not the advertisement");
        assertEq(exec.conditionalLiquidity, 10 ether);
    }

    function test_WalletBalanceFlowsThroughToSnapshot() public {
        _setAquaMakerWalletBalance(tokenA, 10 ether);

        ILiquidityVenue.VenueSnapshot memory snap = aquaVenue.snapshot(address(tokenA), address(tokenB));

        // The headline number the solver ranks on must already be solvency-bounded, otherwise the
        // bound is merely advisory and the router can still be told a lie.
        assertEq(snap.effectiveLiquidity, 10 ether);
    }

    function test_EmptyWalletMeansZeroExecutableLiquidity() public {
        _setAquaMakerWalletBalance(tokenA, 0);

        IExecutableLiquidity.ExecutableLiquidity memory exec = aquaVenue.executableLiquidity(address(tokenA), address(tokenB));

        assertEq(exec.deliverableLiquidity, 0);
        assertEq(exec.conditionalLiquidity, 0);
        assertEq(exec.coverageBps, 0);
        assertEq(aquaVenue.snapshot(address(tokenA), address(tokenB)).effectiveLiquidity, 0);
    }

    // ---- allowance is binding ----

    function test_AllowanceCapsExecutableLiquidity() public {
        _setAquaMakerAllowance(tokenA, 30 ether); // holds 100, advertises 100, approved only 30

        IExecutableLiquidity.ExecutableLiquidity memory exec = aquaVenue.executableLiquidity(address(tokenA), address(tokenB));

        assertEq(exec.walletLiquidity, BASE_LIQUIDITY);
        assertEq(exec.allowance, 30 ether);
        assertEq(exec.deliverableLiquidity, 30 ether);
        assertEq(exec.conditionalLiquidity, 30 ether);
    }

    function test_RevokedApprovalMeansZeroExecutableLiquidity() public {
        _setAquaMakerAllowance(tokenA, 0);

        assertEq(aquaVenue.executableLiquidity(address(tokenA), address(tokenB)).conditionalLiquidity, 0);
        assertEq(aquaVenue.snapshot(address(tokenA), address(tokenB)).effectiveLiquidity, 0);
    }

    // ---- the conditional multiplier composes with, and never escapes, solvency ----

    function test_ConditionalMultiplierAppliesOnTopOfSolvencyBound() public {
        _setAquaMakerWalletBalance(tokenA, 40 ether);
        _setSharedVolatility(6500, 4000e18); // NORMAL -> DEFENSIVE, 25% multiplier

        IExecutableLiquidity.ExecutableLiquidity memory exec = aquaVenue.executableLiquidity(address(tokenA), address(tokenB));

        // The haircut applies to the *deliverable* 40, not to the advertised 100. Applying it to
        // the advertisement would yield 25 and quote 25 against a wallet that can only pay 10.
        assertEq(exec.deliverableLiquidity, 40 ether);
        assertEq(exec.conditionalLiquidity, (40 ether * uint256(StrategyFixtures.DEFENSIVE_LIQ)) / 10_000);
        assertEq(exec.conditionalLiquidity, 10 ether);
    }

    function test_ConditionalLiquidityNeverExceedsDeliverable() public {
        _setAquaMakerWalletBalance(tokenA, 7 ether);

        IExecutableLiquidity.ExecutableLiquidity memory exec = aquaVenue.executableLiquidity(address(tokenA), address(tokenB));
        assertLe(exec.conditionalLiquidity, exec.deliverableLiquidity);
    }

    // ---- the tightest constraint always wins ----

    function test_TightestOfThreeConstraintsBinds() public {
        _setAquaMakerWalletBalance(tokenA, 60 ether);
        _setAquaMakerAllowance(tokenA, 15 ether); // allowance is now the tightest of the three

        IExecutableLiquidity.ExecutableLiquidity memory exec = aquaVenue.executableLiquidity(address(tokenA), address(tokenB));
        assertEq(exec.deliverableLiquidity, 15 ether);

        _setAquaMakerAllowance(tokenA, type(uint256).max); // wallet becomes the tightest instead
        assertEq(aquaVenue.executableLiquidity(address(tokenA), address(tokenB)).deliverableLiquidity, 60 ether);
    }

    // ---- direction awareness ----

    function test_ExecutableLiquidityIsDirectionAware() public {
        // Drain only the tokenB side: the A->B direction must be untouched.
        _setAquaMakerWalletBalance(tokenB, 5 ether);

        assertEq(aquaVenue.executableLiquidity(address(tokenA), address(tokenB)).deliverableLiquidity, BASE_LIQUIDITY);
        assertEq(aquaVenue.executableLiquidity(address(tokenB), address(tokenA)).deliverableLiquidity, 5 ether);
    }

    function test_RevertWhen_QueryingWrongPair() public {
        address unrelated = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityVenue.UnknownPair.selector, address(tokenA), unrelated));
        aquaVenue.executableLiquidity(address(tokenA), unrelated);
    }

    // ---- deactivation ----

    function test_DeactivatedStrategyHasZeroExecutableLiquidity() public {
        vm.prank(aquaMaker);
        aquaRegistry.deactivateStrategy(aquaStrategyId);

        IExecutableLiquidity.ExecutableLiquidity memory exec = aquaVenue.executableLiquidity(address(tokenA), address(tokenB));

        // The maker is still perfectly solvent; the strategy simply is not open for business, and
        // the two reasons stay distinguishable in the breakdown.
        assertEq(exec.deliverableLiquidity, BASE_LIQUIDITY);
        assertEq(exec.conditionalLiquidity, 0);
    }
}
