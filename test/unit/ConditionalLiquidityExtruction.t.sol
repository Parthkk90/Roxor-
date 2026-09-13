// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { ConditionalLiquidityEngine } from "../../contracts/engine/ConditionalLiquidityEngine.sol";
import { ConditionalLiquidityRegistry } from "../../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../../contracts/core/StrategyValidator.sol";
import { ConditionalLiquidityExtruction } from "../../contracts/swapvm/ConditionalLiquidityExtruction.sol";
import { ConditionalLiquidityProgramLib } from "../../contracts/swapvm/ConditionalLiquidityProgramLib.sol";
import { IConditionalLiquidityExtruction } from "../../contracts/swapvm/interfaces/IConditionalLiquidityExtruction.sol";
import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { MockMarketStateProvider } from "../../contracts/mocks/MockMarketStateProvider.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";
import { OrderFixture } from "../utils/OrderFixture.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @title ConditionalLiquidityExtructionTest
/// @notice Exercises the Extruction instruction directly, without a router, so boundary and
///         overflow cases can be constructed exactly rather than reverse-engineered through curve
///         pricing.
///
/// @dev CALLER AUTHORIZATION
///      `extruction()` has no access control of its own, deliberately: it only ever calls
///      `ENGINE.poke`/`preview`, both of which are already safe for any caller to invoke directly
///      (poke is explicitly permissionless - see {IConditionalLiquidityEngine.poke}). Calling this
///      function outside a real SwapVM program grants no extra privilege and moves no tokens, so
///      there is no "unauthorized caller" case to defend against; these tests call it directly for
///      that exact reason, to isolate its own arithmetic from the router.
contract ConditionalLiquidityExtructionTest is OrderFixture {
    ConditionalLiquidityRegistry internal registry;
    ConditionalLiquidityEngine internal engine;
    ConditionalLiquidityExtruction internal extruction;
    MockMarketStateProvider internal oracle;

    address internal owner = makeAddr("owner");
    address internal maker = makeAddr("maker");

    bytes32 internal strategyId;

    function setUp() public {
        _deployPair();
        registry = new ConditionalLiquidityRegistry(new StrategyValidator(), owner);
        oracle = new MockMarketStateProvider();
        engine = new ConditionalLiquidityEngine(registry, oracle);
        extruction = new ConditionalLiquidityExtruction(engine, registry);

        vm.prank(owner);
        registry.setStateAuthority(address(engine));

        ISwapVM.Order memory order = _buildOrder(maker, ConditionalLiquidityProgramLib.build(address(extruction)));
        vm.prank(maker);
        strategyId = registry.registerStrategy(
            order, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );

        oracle.setVolatility(strategyId, 2000, 4000e18);
    }

    function _query(bool isExactIn) private view returns (SwapQuery memory) {
        return SwapQuery({
            orderHash: strategyId,
            maker: maker,
            taker: address(this),
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            isExactIn: isExactIn
        });
    }

    /* ------------------------------------------------------------------ exact-in */

    function test_ExactIn_WithinCap_AppliesSpread() public {
        SwapRegisters memory swap = SwapRegisters({ balanceIn: 100 ether, balanceOut: 100 ether, amountIn: 10 ether, amountOut: 10 ether });

        (,, SwapRegisters memory updated) = extruction.extruction(false, 0, _query(true), swap, "", "");

        // NORMAL mode: 20 bps spread. amountOut = 10 ether * (10000 - 20) / 10000.
        assertEq(updated.amountOut, (10 ether * 9980) / 10_000);
        assertEq(updated.amountIn, swap.amountIn, "amountIn is untouched on the exact-in path");
    }

    /// @notice Exactly at the cap must succeed; the check is `<=`, not `<`.
    function test_ExactIn_ExactlyAtCap_Succeeds() public {
        SwapRegisters memory swap = SwapRegisters({ balanceIn: 100 ether, balanceOut: 100 ether, amountIn: 100 ether, amountOut: 50 ether });

        (,, SwapRegisters memory updated) = extruction.extruction(false, 0, _query(true), swap, "", "");
        assertGt(updated.amountOut, 0);
    }

    function test_ExactIn_OneWeiOverCap_Reverts() public {
        SwapRegisters memory swap =
            SwapRegisters({ balanceIn: 100 ether, balanceOut: 100 ether, amountIn: 100 ether + 1, amountOut: 50 ether });

        vm.expectRevert(
            abi.encodeWithSelector(IConditionalLiquidityExtruction.ExceedsEffectiveLiquidity.selector, strategyId, 100 ether + 1, 100 ether)
        );
        extruction.extruction(false, 0, _query(true), swap, "", "");
    }

    /* ------------------------------------------------------------------ exact-out */

    function test_ExactOut_WithinCap_WidensAmountIn() public {
        SwapRegisters memory swap = SwapRegisters({ balanceIn: 100 ether, balanceOut: 100 ether, amountIn: 10 ether, amountOut: 10 ether });

        (,, SwapRegisters memory updated) = extruction.extruction(false, 0, _query(false), swap, "", "");

        // amountIn = ceil(amountIn * BPS / (BPS - spreadBps))
        uint256 numerator = swap.amountIn * 10_000;
        uint256 denominator = 9980;
        uint256 expected = (numerator + denominator - 1) / denominator; // ceilDiv by hand
        assertEq(updated.amountIn, expected);
        assertEq(updated.amountOut, swap.amountOut, "amountOut is untouched on the exact-out path");
    }

    function test_ExactOut_CapAppliesToAmountOut() public {
        SwapRegisters memory swap =
            SwapRegisters({ balanceIn: 100 ether, balanceOut: 100 ether, amountIn: 50 ether, amountOut: 100 ether + 1 });

        vm.expectRevert(
            abi.encodeWithSelector(IConditionalLiquidityExtruction.ExceedsEffectiveLiquidity.selector, strategyId, 100 ether + 1, 100 ether)
        );
        extruction.extruction(false, 0, _query(false), swap, "", "");
    }

    /* ------------------------------------------------------------------ overflow / boundary */

    /// @notice Maximum spread (50%) must not overflow or underflow the exact-out widening math.
    function test_ExactOut_AtMaxSpread_DoesNotOverflow() public {
        // Force DEFENSIVE then keep shocking so spread sits at its ceiling via the fixture's rule.
        oracle.setVolatility(strategyId, 6300, 4000e18);
        engine.poke(strategyId);
        assertEq(registry.getStrategyState(strategyId).spreadBps, StrategyFixtures.DEFENSIVE_SPREAD);

        SwapRegisters memory swap =
            SwapRegisters({ balanceIn: 1_000_000 ether, balanceOut: 1_000_000 ether, amountIn: 1000 ether, amountOut: 1000 ether });
        (,, SwapRegisters memory updated) = extruction.extruction(false, 0, _query(false), swap, "", "");
        assertGt(updated.amountIn, swap.amountIn, "spread must widen amountIn, not shrink it");
    }

    function test_RevertWhen_StrategyInactive() public {
        vm.prank(maker);
        registry.deactivateStrategy(strategyId);

        SwapRegisters memory swap = SwapRegisters({ balanceIn: 100 ether, balanceOut: 100 ether, amountIn: 1 ether, amountOut: 1 ether });

        vm.expectRevert(abi.encodeWithSelector(IConditionalLiquidityExtruction.StrategyNotActiveForExecution.selector, strategyId));
        extruction.extruction(false, 0, _query(true), swap, "", "");
    }

    function test_StaticContext_UsesPreviewNotPoke() public {
        oracle.setVolatility(strategyId, 6300, 4000e18);

        SwapRegisters memory swap = SwapRegisters({ balanceIn: 100 ether, balanceOut: 100 ether, amountIn: 10 ether, amountOut: 10 ether });

        // isStaticContext = true: must not commit the DEFENSIVE transition.
        extruction.extruction(true, 0, _query(true), swap, "", "");
        assertEq(
            uint8(registry.getStrategyState(strategyId).mode),
            uint8(IStrategyTypes.StrategyMode.NORMAL),
            "static context must not commit state"
        );
    }

    /* ------------------------------------------------------------------ fuzz */

    /// @notice For any balances and any requested amount, the extruction either lets the trade
    ///         through at or under the cap, or reverts - it never silently truncates.
    function testFuzz_NeverExceedsCapSilently(uint256 balanceIn, uint256 amountIn, uint256 vol) public {
        balanceIn = bound(balanceIn, 1 ether, 1_000_000 ether);
        amountIn = bound(amountIn, 0, balanceIn * 2);
        vol = bound(vol, 0, 20_000);

        oracle.setVolatility(strategyId, vol, 4000e18);
        engine.poke(strategyId);

        uint16 liquidityBps = registry.getStrategyState(strategyId).liquidityBps;
        uint256 cap = (balanceIn * liquidityBps) / StrategyLib.MAX_LIQUIDITY_BPS;

        SwapRegisters memory swap = SwapRegisters({ balanceIn: balanceIn, balanceOut: balanceIn, amountIn: amountIn, amountOut: amountIn });

        if (amountIn > cap) {
            vm.expectRevert(
                abi.encodeWithSelector(IConditionalLiquidityExtruction.ExceedsEffectiveLiquidity.selector, strategyId, amountIn, cap)
            );
            extruction.extruction(false, 0, _query(true), swap, "", "");
        } else {
            (,, SwapRegisters memory updated) = extruction.extruction(false, 0, _query(true), swap, "", "");
            assertLe(updated.amountOut, swap.amountOut, "spread never increases exact-in output");
        }
    }
}
