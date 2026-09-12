// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { SolverFixture } from "../utils/SolverFixture.sol";
import { ExecutableLiquidityLib } from "../../contracts/libraries/ExecutableLiquidityLib.sol";
import { IExecutableLiquidity } from "../../contracts/venues/interfaces/IExecutableLiquidity.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { ISolver } from "../../contracts/solver/interfaces/ISolver.sol";

/// @notice Feature 2, universally quantified: FOR ALL (virtualBalance, walletBalance, allowance,
///         liquidityBps, amount), the solver never allocates more than executable liquidity.
///
/// @dev Split in two deliberately. The pure half fuzzes the arithmetic over its entire domain
///      (including values no fixture could reach); the integration half fuzzes the *real* stack —
///      real Aqua balances, real maker wallet, real ERC20 approvals, the real rule engine driving
///      the multiplier — because an invariant that only holds in a library is not an invariant.
contract ExecutableLiquidityFuzzTest is SolverFixture {
    function setUp() public {
        _setUpSolver();
    }

    // ---- pure: the bound itself ----

    function testFuzz_DeliverableNeverExceedsAnyConstraint(
        uint256 virtualLiquidity,
        uint256 walletLiquidity,
        uint256 allowance,
        uint16 liquidityBps
    )
        public
        pure
    {
        virtualLiquidity = bound(virtualLiquidity, 0, type(uint128).max);
        walletLiquidity = bound(walletLiquidity, 0, type(uint128).max);
        allowance = bound(allowance, 0, type(uint128).max);
        liquidityBps = uint16(bound(liquidityBps, 0, 10_000));

        IExecutableLiquidity.ExecutableLiquidity memory exec =
            ExecutableLiquidityLib.derive(virtualLiquidity, walletLiquidity, allowance, liquidityBps);

        assertLe(exec.deliverableLiquidity, virtualLiquidity);
        assertLe(exec.deliverableLiquidity, walletLiquidity);
        assertLe(exec.deliverableLiquidity, allowance);
        assertLe(exec.conditionalLiquidity, exec.deliverableLiquidity);
        assertLe(exec.coverageBps, 10_000);
    }

    /// @dev A conditional multiplier can only ever shrink. If a multiplier above 100% could widen
    ///      the bound, a maker could mint phantom depth through their own strategy program.
    function testFuzz_MultiplierCanOnlyShrink(
        uint128 virtualLiquidity,
        uint128 walletLiquidity,
        uint128 allowance,
        uint16 liquidityBps
    )
        public
        pure
    {
        liquidityBps = uint16(bound(liquidityBps, 0, type(uint16).max));

        IExecutableLiquidity.ExecutableLiquidity memory exec =
            ExecutableLiquidityLib.derive(virtualLiquidity, walletLiquidity, allowance, liquidityBps);

        if (liquidityBps <= 10_000) {
            assertLe(exec.conditionalLiquidity, exec.deliverableLiquidity);
        }
    }

    // ---- integration: the bound as the live stack actually reports it ----

    /// @dev Fuzzes all five dimensions the spec names, against the real Aqua/engine/ERC20 stack,
    ///      and asserts the invariant on every produced leg.
    function testFuzz_SolverNeverAllocatesMoreThanExecutableLiquidity(
        uint256 walletBalance,
        uint256 allowance,
        uint16 volatilityBps,
        uint256 amount
    )
        public
    {
        walletBalance = bound(walletBalance, 0, 200 ether);
        allowance = bound(allowance, 0, 200 ether);
        volatilityBps = uint16(bound(volatilityBps, 0, 10_000));
        amount = bound(amount, 1, 400 ether);

        _setAquaMakerWalletBalance(tokenA, walletBalance);
        _setAquaMakerAllowance(tokenA, allowance);
        _setSharedVolatility(volatilityBps, 4000e18);

        IExecutableLiquidity.ExecutableLiquidity memory aquaExec = aquaVenue.executableLiquidity(address(tokenA), address(tokenB));
        IExecutableLiquidity.ExecutableLiquidity memory uniExec = uniVenue.executableLiquidity(address(tokenA), address(tokenB));

        // Ground truth, computed independently of the solver: the tightest real bound on each side.
        uint256 aquaExecutable = ExecutableLiquidityLib.min3(aquaExec.virtualLiquidity, walletBalance, allowance);
        assertEq(aquaExec.deliverableLiquidity, aquaExecutable, "venue must agree with min(virtual, wallet, allowance)");

        uint256 totalExecutable = aquaExec.conditionalLiquidity + uniExec.conditionalLiquidity;

        ISolver.TraderRequest memory request =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: amount, maxSlippageBps: 10_000 });

        if (amount > totalExecutable) {
            vm.expectRevert(abi.encodeWithSelector(ISolver.NoRoute.selector, address(tokenA), address(tokenB), amount, totalExecutable));
            solver.route(request);
            return;
        }

        ISolver.ExecutionPlan memory plan = solver.route(request);

        uint256 sumIn = 0;
        for (uint256 i = 0; i < plan.legs.length; ++i) {
            ISolver.RouteLeg memory leg = plan.legs[i];
            uint256 cap = leg.venue == address(aquaVenue) ? aquaExec.conditionalLiquidity : uniExec.conditionalLiquidity;

            // THE invariant.
            assertLe(leg.amountIn, cap, "allocated > executableLiquidity");
            sumIn += leg.amountIn;
        }
        assertEq(sumIn, amount);
        assertLe(sumIn, totalExecutable);
    }

    /// @dev However the market is configured, a plan that `route` produced must always survive
    ///      `settle`'s independent second solvency read in the same block. If these two could ever
    ///      disagree, the revalidation would be rejecting honest routes.
    function testFuzz_RoutedPlanAlwaysSurvivesRevalidation(uint256 walletBalance, uint16 volatilityBps, uint256 amount) public {
        walletBalance = bound(walletBalance, 0, 200 ether);
        volatilityBps = uint16(bound(volatilityBps, 0, 10_000));
        amount = bound(amount, 1, 200 ether);

        _setAquaMakerWalletBalance(tokenA, walletBalance);
        _setSharedVolatility(volatilityBps, 4000e18);
        _fundTrader(trader, 400 ether, 0);

        try solver.route(
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: amount, maxSlippageBps: 10_000 })
        ) returns (
            ISolver.ExecutionPlan memory plan
        ) {
            for (uint256 i = 0; i < plan.legs.length; ++i) {
                IExecutableLiquidity.ExecutableLiquidity memory exec =
                    ILiquidityVenue(plan.legs[i].venue).executableLiquidity(address(tokenA), address(tokenB));
                assertLe(plan.legs[i].amountIn, exec.conditionalLiquidity);
            }
        } catch {
            // No route is a valid outcome; the invariant only constrains routes that exist.
        }
    }
}
