// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { LPFeeLibrary } from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { HookMiner } from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import { ConditionalLiquidityRegistry } from "../../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../../contracts/core/StrategyValidator.sol";
import { ConditionalLiquidityEngine } from "../../contracts/engine/ConditionalLiquidityEngine.sol";
import { ConditionalLiquidityExtruction } from "../../contracts/swapvm/ConditionalLiquidityExtruction.sol";
import { ConditionalLiquidityProgramLib } from "../../contracts/swapvm/ConditionalLiquidityProgramLib.sol";
import { ConditionalLiquidityHook } from "../../contracts/uniswap/ConditionalLiquidityHook.sol";
import { MockERC20 } from "../../contracts/mocks/MockERC20.sol";
import { MockWETH } from "../../contracts/mocks/MockWETH.sol";
import { MockMarketStateProvider } from "../../contracts/mocks/MockMarketStateProvider.sol";
import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @title StrategyEquivalenceTest
/// @notice Proves the central Part 5 invariant empirically: the SAME strategy, driven by the SAME
///         volatility sequence, through two INDEPENDENTLY deployed and DIFFERENTLY mechanized
///         backends (Aqua/SwapVM's `ConditionalLiquidityExtruction` vs Uniswap v4's
///         `ConditionalLiquidityHook`), lands on identical mode/liquidity/spread at every step.
///
/// @dev Deliberately does NOT share a registry, engine, or oracle between the two stacks - that
///      would make agreement trivial (same storage slot). Two fully separate deployments are
///      driven by two separate `MockMarketStateProvider`s kept in lockstep, and every step is
///      forced through a REAL swap on each backend's own router (not a bare `engine.poke()` call),
///      so a bug in either integration's plumbing - a wrong timestamp read, a stale strategyId, a
///      miscomputed cap - would show up as a divergence here, not just "the math agrees with
///      itself." Neither backend implements its own copy of `RuleEngineLib`; both call
///      `ConditionalLiquidityEngine.poke`, which is the only place `RuleEngineLib.evaluate` is
///      ever invoked in the whole protocol.
contract StrategyEquivalenceTest is Test {
    // Aqua/SwapVM stack.
    ConditionalLiquidityRegistry internal registryA;
    ConditionalLiquidityEngine internal engineA;
    MockMarketStateProvider internal oracleA;
    AquaSwapVMRouter internal router;
    Aqua internal aqua;
    bytes32 internal strategyIdA;
    ISwapVM.Order internal orderA;
    MockERC20 internal tokenA0;
    MockERC20 internal tokenA1;

    // Uniswap v4 stack.
    ConditionalLiquidityRegistry internal registryU;
    ConditionalLiquidityEngine internal engineU;
    MockMarketStateProvider internal oracleU;
    ConditionalLiquidityHook internal hook;
    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    PoolKey internal poolKey;
    bytes32 internal strategyIdU;
    MockERC20 internal tokenU0;
    MockERC20 internal tokenU1;

    address internal maker = makeAddr("eqMaker");
    address internal trader = makeAddr("eqTrader");
    address internal owner = makeAddr("eqOwner");

    uint256 internal constant BASE = 100 ether;
    uint256 internal clock;

    function setUp() public {
        clock = 1_800_000_000;
        vm.warp(clock);

        _setUpAquaStack();
        _setUpUniswapStack();

        oracleA.setVolatility(strategyIdA, 2000, 4000e18);
        oracleU.setVolatility(strategyIdU, 2000, 4000e18);
    }

    /* ------------------------------------------------------------------ setup: Aqua/SwapVM */

    function _setUpAquaStack() private {
        MockERC20 a = new MockERC20("EQ Token A", "EQA", 18);
        MockERC20 b = new MockERC20("EQ Token B", "EQB", 18);
        (address lo, address hi) = StrategyLib.sortTokens(address(a), address(b));
        tokenA0 = MockERC20(lo);
        tokenA1 = MockERC20(hi);

        aqua = new Aqua();
        MockWETH weth = new MockWETH();
        router = new AquaSwapVMRouter(address(aqua), address(weth), owner, "EquivalenceRouter", "1");

        registryA = new ConditionalLiquidityRegistry(new StrategyValidator(), owner);
        oracleA = new MockMarketStateProvider();
        engineA = new ConditionalLiquidityEngine(registryA, oracleA);
        vm.prank(owner);
        registryA.setStateAuthority(address(engineA));

        ConditionalLiquidityExtruction extruction = new ConditionalLiquidityExtruction(engineA, registryA);

        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = address(tokenA0);
        args.tokenB = address(tokenA1);
        args.useAquaInsteadOfSignature = true;
        args.program = ConditionalLiquidityProgramLib.build(address(extruction));
        orderA = MakerTraitsLib.build(args);

        vm.prank(maker);
        strategyIdA = registryA.registerStrategy(
            orderA, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );

        tokenA0.mint(maker, BASE * 10);
        tokenA1.mint(maker, BASE * 10);
        vm.startPrank(maker);
        tokenA0.approve(address(aqua), type(uint256).max);
        tokenA1.approve(address(aqua), type(uint256).max);
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA0);
        tokens[1] = address(tokenA1);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = BASE;
        amounts[1] = BASE;
        aqua.ship(address(router), abi.encode(orderA), tokens, amounts);
        vm.stopPrank();

        tokenA0.mint(trader, BASE * 10);
        tokenA1.mint(trader, BASE * 10);
        vm.startPrank(trader);
        tokenA0.approve(address(router), type(uint256).max);
        tokenA1.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _pokeAqua(uint256 amountIn) private {
        TakerTraitsLib.Args memory targs;
        targs.taker = trader;
        targs.isExactIn = true;
        targs.isFirstTransferFromTaker = true;
        targs.useTransferFromAndAquaPush = true;
        targs.isAToB = true;
        targs.threshold = abi.encodePacked(uint256(0));
        bytes memory takerData = TakerTraitsLib.build(targs);

        vm.prank(trader);
        router.swap(orderA, amountIn, takerData);
    }

    /* ------------------------------------------------------------------ setup: Uniswap v4 */

    function _setUpUniswapStack() private {
        MockERC20 a = new MockERC20("EQ Token X", "EQX", 18);
        MockERC20 b = new MockERC20("EQ Token Y", "EQY", 18);
        (address lo, address hi) = StrategyLib.sortTokens(address(a), address(b));
        tokenU0 = MockERC20(lo);
        tokenU1 = MockERC20(hi);

        registryU = new ConditionalLiquidityRegistry(new StrategyValidator(), owner);
        oracleU = new MockMarketStateProvider();
        engineU = new ConditionalLiquidityEngine(registryU, oracleU);
        vm.prank(owner);
        registryU.setStateAuthority(address(engineU));

        manager = IPoolManager(vm.deployCode("PoolManager.sol:PoolManager", abi.encode(owner)));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(manager, engineU, registryU);
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), flags, type(ConditionalLiquidityHook).creationCode, constructorArgs);
        hook = new ConditionalLiquidityHook{ salt: salt }(manager, engineU, registryU);
        require(address(hook) == predicted, "hook address mismatch");

        poolKey = PoolKey({
            currency0: Currency.wrap(address(tokenU0)),
            currency1: Currency.wrap(address(tokenU1)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(poolKey, uint160(1) << 96);

        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = address(tokenU0);
        args.tokenB = address(tokenU1);
        args.useAquaInsteadOfSignature = true;
        args.program = hex"5000";
        ISwapVM.Order memory orderU = MakerTraitsLib.build(args);

        vm.prank(maker);
        strategyIdU = registryU.registerStrategy(
            orderU, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );
        vm.prank(maker);
        hook.registerPoolStrategy(poolKey, strategyIdU, BASE, BASE);

        tokenU0.mint(maker, type(uint128).max);
        tokenU1.mint(maker, type(uint128).max);
        vm.startPrank(maker);
        tokenU0.approve(address(lpRouter), type(uint256).max);
        tokenU1.approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: int256(1_000_000 ether),
                salt: bytes32(0)
            }),
            ""
        );
        vm.stopPrank();

        tokenU0.mint(trader, BASE * 10);
        tokenU1.mint(trader, BASE * 10);
        vm.startPrank(trader);
        tokenU0.approve(address(swapRouter), type(uint256).max);
        tokenU1.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    function _pokeUniswap(uint256 amountIn) private {
        vm.prank(trader);
        swapRouter.swap(
            poolKey,
            SwapParams({ zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
    }

    /* ------------------------------------------------------------------ equivalence */

    function _assertStatesMatch(string memory label) private view {
        IStrategyTypes.RuntimeState memory a = registryA.getStrategyState(strategyIdA);
        IStrategyTypes.RuntimeState memory u = registryU.getStrategyState(strategyIdU);

        assertEq(uint8(a.mode), uint8(u.mode), string.concat(label, ": mode"));
        assertEq(a.liquidityBps, u.liquidityBps, string.concat(label, ": liquidityBps"));
        assertEq(a.spreadBps, u.spreadBps, string.concat(label, ": spreadBps"));
    }

    /// @notice Drives both backends through the exact volatility sequence from the spec and
    ///         asserts mode/liquidity/spread agree after every single sample.
    function test_SameVolatilitySequenceProducesSameStrategyState() public {
        uint256[8] memory series = [uint256(2000), 3500, 4900, 5000, 5100, 6500, 3000, 2900];

        for (uint256 i = 0; i < series.length; i++) {
            oracleA.setVolatility(strategyIdA, series[i], 4000e18);
            oracleU.setVolatility(strategyIdU, series[i], 4000e18);

            _pokeAqua(1 ether);
            _pokeUniswap(1 ether);

            _assertStatesMatch(string.concat("sample ", vm.toString(i)));
        }
    }

    /// @notice Extends the sequence with the sustained-duration recovery path, so timestamp
    ///         handling (not just instantaneous comparisons) is verified across both backends too.
    function test_SustainedRecoveryStaysInLockstepAcrossBackends() public {
        oracleA.setVolatility(strategyIdA, 6300, 4000e18);
        oracleU.setVolatility(strategyIdU, 6300, 4000e18);
        _pokeAqua(1 ether);
        _pokeUniswap(1 ether);
        _assertStatesMatch("shock");

        oracleA.setVolatility(strategyIdA, 2400, 4000e18);
        oracleU.setVolatility(strategyIdU, 2400, 4000e18);
        _pokeAqua(1 ether);
        _pokeUniswap(1 ether);
        _assertStatesMatch("calm sample 1 (armed, not yet sustained)");

        clock += StrategyFixtures.CALM_PERIOD;
        vm.warp(clock);
        _pokeAqua(1 ether);
        _pokeUniswap(1 ether);
        _assertStatesMatch("recovery reached");

        clock += StrategyFixtures.RECOVERY_PERIOD;
        vm.warp(clock);
        _pokeAqua(1 ether);
        _pokeUniswap(1 ether);
        _assertStatesMatch("normal restored");
    }
}
