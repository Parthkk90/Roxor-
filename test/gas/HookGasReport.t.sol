// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { console } from "forge-std/console.sol";

import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";

import { UniswapExecutionFixture } from "../utils/UniswapExecutionFixture.sol";

/// @title HookGasReportTest
/// @notice Isolated gas measurements for the operations Part 5 Step 20 asks for. Each measurement
///         brackets ONLY the call being measured with `vm.startSnapshotGas`/`stopSnapshotGas`, so
///         `setUp()`'s one-time deployment/seeding cost (which dwarfs a single swap) is excluded.
///         Results also land in `.gas-snapshot` under the `HookGas` group via `forge snapshot`.
contract HookGasReportTest is UniswapExecutionFixture {
    function setUp() public {
        _setUpUniswap();
        _fundTrader(trader, 1000 ether, 1000 ether);
    }

    /// @dev This is the FIRST swap ever run against the freshly-seeded pool, so it pays EIP-2929
    ///      cold-storage costs (pool slot0/liquidity, tick crossings) on top of the hook's own
    ///      logic. See {test_Gas_NormalSwapWarm} for the steady-state figure.
    function test_Gas_NormalSwapCold() public {
        vm.startSnapshotGas("HookGas", "normal_swap_cold_first_ever");
        _swapXToY(trader, 10 ether);
        uint256 gasUsed = vm.stopSnapshotGas();
        console.log("normal swap, cold storage (first swap ever against this pool):", gasUsed);
    }

    /// @notice Steady-state cost once the pool's own storage is already warm.
    function test_Gas_NormalSwapWarm() public {
        _swapXToY(trader, 1 ether); // warm-up: pays the cold-storage cost so it isn't in the measurement

        vm.startSnapshotGas("HookGas", "normal_swap_warm_steady_state");
        _swapXToY(trader, 10 ether);
        uint256 gasUsed = vm.stopSnapshotGas();
        console.log("normal swap, warm storage (steady state):", gasUsed);
    }

    function test_Gas_StateTransitionSwap() public {
        oracle.setVolatility(strategyId, 6300, 4000e18);
        vm.startSnapshotGas("HookGas", "state_transition_swap");
        _swapXToY(trader, 1 ether); // this swap is what commits NORMAL -> DEFENSIVE
        uint256 gasUsed = vm.stopSnapshotGas();
        console.log("swap that also triggers a state transition:", gasUsed);
    }

    function test_Gas_DefensiveSwap() public {
        oracle.setVolatility(strategyId, 6300, 4000e18);
        _swapXToY(trader, 1 ether); // commit the transition first, excluded from the measurement

        vm.startSnapshotGas("HookGas", "defensive_swap_no_transition");
        _swapXToY(trader, 5 ether); // already in DEFENSIVE; no further transition this call
        uint256 gasUsed = vm.stopSnapshotGas();
        console.log("swap while already DEFENSIVE (no transition):", gasUsed);
    }

    function test_Gas_RejectedSwap() public {
        oracle.setVolatility(strategyId, 6300, 4000e18);
        _swapXToY(trader, 1 ether); // commit DEFENSIVE

        vm.startSnapshotGas("HookGas", "rejected_swap");
        bool reverted = false;
        vm.prank(trader);
        try swapRouter.swap(
            poolKey,
            SwapParams({ zeroForOne: true, amountSpecified: -50 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        ) returns (
            BalanceDelta
        ) {
        // no-op: falling through leaves `reverted` false, which fails the assertion below
        }
        catch {
            reverted = true;
        }
        uint256 gasUsed = vm.stopSnapshotGas();
        console.log("rejected swap (exceeds effective liquidity, reverts):", gasUsed);
        require(reverted, "expected the oversized swap to revert");
    }

    function test_Gas_BareEnginePoke() public {
        oracle.setVolatility(strategyId, 6300, 4000e18);
        vm.startSnapshotGas("HookGas", "bare_engine_poke_transition");
        engine.poke(strategyId);
        uint256 gasUsed = vm.stopSnapshotGas();
        console.log("bare engine.poke() causing a transition (no swap, no PoolManager):", gasUsed);
    }
}
