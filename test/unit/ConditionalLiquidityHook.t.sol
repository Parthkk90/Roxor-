// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { LPFeeLibrary } from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { IHookStrategyAdapter } from "../../contracts/uniswap/interfaces/IHookStrategyAdapter.sol";
import { MockERC20 } from "../../contracts/mocks/MockERC20.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";
import { UniswapExecutionFixture } from "../utils/UniswapExecutionFixture.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @title ConditionalLiquidityHookTest
/// @notice Unit, fuzz and security coverage for the hook + adapter layer, on top of the
///         end-to-end behavior already proven in test/integration/UniswapConditionalLiquidity.t.sol
///         and test/integration/UniswapMarketShock.t.sol.
contract ConditionalLiquidityHookTest is UniswapExecutionFixture {
    using PoolIdLibrary for PoolKey;

    address internal intruder = makeAddr("intruder");

    PoolSwapTest.TestSettings internal defaultSettings = PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false });

    function setUp() public {
        _setUpUniswap();
        _fundTrader(trader, 1000 ether, 1000 ether);
    }

    /* ------------------------------------------------------------------ registration: security */

    function test_RevertWhen_UnauthorizedStrategyRegistration() public {
        (PoolKey memory key2, bytes32 strategyId2) = _freshPoolWithStrategy();

        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(IHookStrategyAdapter.NotStrategyMaker.selector, strategyId2, intruder));
        hook.registerPoolStrategy(key2, strategyId2, BASE_LIQUIDITY, BASE_LIQUIDITY);
    }

    function test_RevertWhen_RegisteringUnregisteredStrategy() public {
        (PoolKey memory key2,) = _freshPoolWithStrategy();
        bytes32 ghost = keccak256("nonexistent-strategy");

        vm.expectRevert(); // registry.getStrategy reverts StrategyNotRegistered
        hook.registerPoolStrategy(key2, ghost, BASE_LIQUIDITY, BASE_LIQUIDITY);
    }

    /// @notice A strategy already bound to a pool cannot be silently replaced by anyone,
    ///         including the pool's original maker. The MVP offers no update path at all.
    function test_RevertWhen_ReplacingAlreadyRegisteredStrategy() public {
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(IHookStrategyAdapter.PoolStrategyAlreadyRegistered.selector, poolId));
        hook.registerPoolStrategy(poolKey, strategyId, BASE_LIQUIDITY, BASE_LIQUIDITY);
    }

    function test_RevertWhen_PoolKeyDoesNotReferenceThisHook() public {
        (PoolKey memory key2, bytes32 sid2) = _freshPoolWithStrategy();
        // A zero-hook pool must use a static fee (Hooks.isValidHookAddress rejects address(0)
        // paired with a dynamic fee), so this needs its own fee, distinct from key2's dynamic one.
        PoolKey memory badKey =
            PoolKey({ currency0: key2.currency0, currency1: key2.currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0)) });
        manager.initialize(badKey, uint160(1) << 96); // must exist, so HookMismatch is what actually fires

        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(IHookStrategyAdapter.HookMismatch.selector, badKey.toId(), address(0)));
        hook.registerPoolStrategy(badKey, sid2, BASE_LIQUIDITY, BASE_LIQUIDITY);
    }

    function test_RevertWhen_TokensDoNotMatchStrategy() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        PoolKey memory mismatched = PoolKey({
            currency0: poolKey.currency0,
            currency1: Currency.wrap(address(other)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        vm.prank(maker);
        vm.expectRevert(); // TokenMismatch
        hook.registerPoolStrategy(mismatched, strategyId, BASE_LIQUIDITY, BASE_LIQUIDITY);
    }

    function test_RevertWhen_PoolNotInitialized() public {
        MockERC20 a = new MockERC20("Uninit A", "UNA", 18);
        MockERC20 b = new MockERC20("Uninit B", "UNB", 18);
        (address lo, address hi) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));

        PoolKey memory uninit = PoolKey({
            currency0: Currency.wrap(lo),
            currency1: Currency.wrap(hi),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        // Deliberately never call manager.initialize(uninit, ...).

        bytes32 sid = _registerStrategy(maker, lo, hi);
        vm.prank(maker);
        vm.expectRevert(); // PoolNotInitialized
        hook.registerPoolStrategy(uninit, sid, BASE_LIQUIDITY, BASE_LIQUIDITY);
    }

    /* ------------------------------------------------------------------ execution: security */

    function test_RevertWhen_HookCalledDirectlyNotThroughPoolManager() public {
        vm.expectRevert(); // NotPoolManager, from BaseHook's onlyPoolManager modifier
        hook.beforeSwap(trader, poolKey, SwapParams({ zeroForOne: true, amountSpecified: -1 ether, sqrtPriceLimitX96: 0 }), "");
    }

    function test_RevertWhen_QueryingUnregisteredPool() public {
        PoolId ghostPool = PoolId.wrap(keccak256("no-such-pool"));
        vm.expectRevert(abi.encodeWithSelector(IHookStrategyAdapter.NoStrategyForPool.selector, ghostPool));
        hook.getPoolStrategy(ghostPool);
    }

    function test_RevertWhen_StrategyDeactivatedBeforeSwap() public {
        vm.prank(maker);
        registry.deactivateStrategy(strategyId);

        vm.expectRevert(); // wrapped StrategyNotActiveForExecution
        _swapXToY(trader, 1 ether);
    }

    /* ------------------------------------------------------------------ fuzz: liquidity cap */

    /// @notice Core invariant: a request over the cap never succeeds.
    function testFuzz_OverCapAlwaysReverts(uint256 amountIn) public {
        amountIn = bound(amountIn, BASE_LIQUIDITY + 1, 500 ether);
        _fundTrader(trader, amountIn, 0);

        _expectExceedsEffectiveLiquidity(amountIn, BASE_LIQUIDITY);
        _swapXToY(trader, amountIn);
    }

    /// @notice Core invariant: a request at or under the cap is never rejected by the conditional
    ///         liquidity layer itself (it settles for the exact requested input every time).
    function testFuzz_UnderCapNeverRejectedByConditionalLayer(uint256 amountIn) public {
        amountIn = bound(amountIn, 1, BASE_LIQUIDITY);
        _fundTrader(trader, amountIn, 0);

        BalanceDelta delta = _swapXToY(trader, amountIn);
        assertEq(uint256(uint128(-delta.amount0())), amountIn);
    }

    /// @notice Exactly at the cap must succeed (boundary is inclusive, matching
    ///         ConditionalLiquidityExtruction's `<=` check).
    function testFuzz_ExactlyAtCapSucceeds(uint256 baseSeed) public {
        uint256 base = bound(baseSeed, 1 ether, 500 ether);
        (PoolKey memory key2, bytes32 sid2) = _freshPoolWithStrategy();
        _seedFreshPoolLiquidity(key2);

        vm.prank(maker);
        hook.registerPoolStrategy(key2, sid2, base, base);

        // _fundTrader only funds the fixture's tokenX/tokenY; key2 uses its own fresh pair.
        MockERC20 c0 = MockERC20(Currency.unwrap(key2.currency0));
        c0.mint(trader, base);
        vm.prank(trader);
        c0.approve(address(swapRouter), type(uint256).max);

        vm.prank(trader);
        BalanceDelta delta = swapRouter.swap(
            key2,
            SwapParams({ zeroForOne: true, amountSpecified: -int256(base), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 }),
            defaultSettings,
            ""
        );
        assertEq(uint256(uint128(-delta.amount0())), base);
    }

    function testFuzz_VolatilityNeverBypassesLiquidityBounds(uint256 vol) public {
        vol = bound(vol, 0, 1_000_000);
        oracle.setVolatility(strategyId, vol, 4000e18);
        _swapXToY(trader, 1 ether);

        IStrategyTypes.RuntimeState memory s = registry.getStrategyState(strategyId);
        assertLe(s.liquidityBps, StrategyLib.MAX_LIQUIDITY_BPS);
        assertLe(s.spreadBps, StrategyLib.MAX_SPREAD_BPS);
        assertLe(uint8(s.mode), uint8(IStrategyTypes.StrategyMode.RECOVERY));
    }

    function testFuzz_TimestampNeverUnderflowsTimeSinceTransition(uint32 skip) public {
        vm.warp(block.timestamp + bound(skip, 0, 3650 days));
        oracle.setVolatility(strategyId, 3000, 4000e18);
        // Must not revert with a panic (arithmetic underflow); any revert here would be a bug.
        _swapXToY(trader, 1 ether);
    }

    function test_ZeroAmountSwapReverts() public {
        // PoolManager itself forbids a zero-amount swap before hooks even run.
        vm.prank(trader);
        vm.expectRevert();
        swapRouter.swap(
            poolKey,
            SwapParams({ zeroForOne: true, amountSpecified: 0, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 }),
            defaultSettings,
            ""
        );
    }

    function test_RepeatedSwapsEachRespectTheCurrentCap() public {
        oracle.setVolatility(strategyId, 6300, 4000e18);
        _swapXToY(trader, 1 ether); // commit DEFENSIVE; cap now grows with the maker's live balance

        for (uint256 i = 0; i < 5; i++) {
            uint256 cap = hook.getEffectiveLiquidity(poolId);
            _swapXToY(trader, cap); // exactly at the (growing) cap every time: must always succeed
        }
    }

    /// @notice Very large amounts must revert cleanly (our cap check or the AMM's own price-limit
    ///         protection), never silently bypass the cap.
    function testFuzz_ExtremeAmountsNeverBypassCap(uint128 hugeAmount) public {
        vm.assume(hugeAmount > BASE_LIQUIDITY);
        _fundTrader(trader, hugeAmount, 0);

        vm.prank(trader);
        vm.expectRevert(); // either ExceedsEffectiveLiquidity (wrapped) or a v4 price-limit revert
        swapRouter.swap(
            poolKey,
            SwapParams({ zeroForOne: true, amountSpecified: -int256(uint256(hugeAmount)), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 }),
            defaultSettings,
            ""
        );
    }

    /* ------------------------------------------------------------------ helpers */

    /// @dev `tokA`/`tokB` should be a token pair never registered before, so the derived order
    ///      (and therefore strategyId) is guaranteed fresh. Callers get that for free from
    ///      {_freshPoolWithStrategy}, which always mints new mock tokens.
    function _registerStrategy(address who, address tokA, address tokB) internal returns (bytes32 sid) {
        (address lo, address hi) = tokA < tokB ? (tokA, tokB) : (tokB, tokA);
        MakerTraitsLib.Args memory args;
        args.maker = who;
        args.tokenA = lo;
        args.tokenB = hi;
        args.useAquaInsteadOfSignature = true;
        args.program = hex"5000";
        ISwapVM.Order memory order = MakerTraitsLib.build(args);

        vm.prank(who);
        sid = registry.registerStrategy(
            order, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );
    }

    function _freshPoolWithStrategy() internal returns (PoolKey memory key2, bytes32 sid2) {
        MockERC20 a = new MockERC20("Fresh A", "FRA", 18);
        MockERC20 b = new MockERC20("Fresh B", "FRB", 18);
        (address lo, address hi) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));

        key2 = PoolKey({
            currency0: Currency.wrap(lo),
            currency1: Currency.wrap(hi),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(key2, uint160(1) << 96);

        sid2 = _registerStrategy(maker, lo, hi);
    }

    function _seedFreshPoolLiquidity(PoolKey memory key2) internal {
        MockERC20 c0 = MockERC20(Currency.unwrap(key2.currency0));
        MockERC20 c1 = MockERC20(Currency.unwrap(key2.currency1));
        c0.mint(maker, type(uint128).max);
        c1.mint(maker, type(uint128).max);

        vm.startPrank(maker);
        c0.approve(address(lpRouter), type(uint256).max);
        c1.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            key2,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: int256(1_000_000 ether),
                salt: bytes32(0)
            }),
            ""
        );
        vm.stopPrank();
    }
}
