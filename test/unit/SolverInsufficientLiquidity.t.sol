// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { SolverFixture } from "../utils/SolverFixture.sol";
import { ISolver } from "../../contracts/solver/interfaces/ISolver.sol";

/// @notice Test 5 - Insufficient Liquidity: a request larger than every venue's live effective
///         liquidity combined must revert {ISolver.NoRoute}, never invent liquidity that isn't there.
contract SolverInsufficientLiquidityTest is SolverFixture {
    function setUp() public {
        _setUpSolver();
    }

    function test_RevertWhen_RequestExceedsTotalEffectiveLiquidity() public {
        // Aqua caps at 100 (tokenA side), Uniswap caps at 100: 250 tokenA exceeds both combined.
        ISolver.TraderRequest memory request =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: 250 ether, maxSlippageBps: 10_000 });

        vm.expectRevert(abi.encodeWithSelector(ISolver.NoRoute.selector, address(tokenA), address(tokenB), 250 ether, 200 ether));
        solver.route(request);
    }

    function test_RevertWhen_ShockShrinksLiquidityBelowRequest() public {
        // 150 tokenA fits at NORMAL (100 + 100) but not once both venues shock to DEFENSIVE (25 + 25).
        ISolver.TraderRequest memory request =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: 150 ether, maxSlippageBps: 10_000 });
        solver.route(request); // succeeds pre-shock

        _setSharedVolatility(6500, 4000e18);

        vm.expectRevert(abi.encodeWithSelector(ISolver.NoRoute.selector, address(tokenA), address(tokenB), 150 ether, 50 ether));
        solver.route(request);
    }

    function test_RevertWhen_SettlingAnUnroutableRequest() public {
        ISolver.TraderRequest memory request =
            ISolver.TraderRequest({ tokenIn: address(tokenA), tokenOut: address(tokenB), amount: 250 ether, maxSlippageBps: 10_000 });

        _fundTrader(trader, 300 ether, 0);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ISolver.NoRoute.selector, address(tokenA), address(tokenB), 250 ether, 200 ether));
        solver.settle(request, 0);
    }
}
