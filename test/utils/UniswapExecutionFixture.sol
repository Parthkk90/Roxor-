// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { LPFeeLibrary } from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import { CustomRevert } from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import { HookMiner } from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import { ConditionalLiquidityRegistry } from "../../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../../contracts/core/StrategyValidator.sol";
import { ConditionalLiquidityEngine } from "../../contracts/engine/ConditionalLiquidityEngine.sol";
import { ConditionalLiquidityHook } from "../../contracts/uniswap/ConditionalLiquidityHook.sol";
import { IConditionalLiquidityHook } from "../../contracts/uniswap/interfaces/IConditionalLiquidityHook.sol";
import { MockERC20 } from "../../contracts/mocks/MockERC20.sol";
import { MockMarketStateProvider } from "../../contracts/mocks/MockMarketStateProvider.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";
import { StrategyFixtures } from "./StrategyFixtures.sol";

/// @notice Deploys the real Uniswap v4 stack (PoolManager, the official PoolSwapTest /
///         PoolModifyLiquidityTest routers, a CREATE2-mined hook) and binds the SAME
///         conditional-liquidity strategy identity mechanism the Aqua/SwapVM backend uses.
///
/// @dev Nothing here is a stand-in for the real thing: PoolManager is the actual v4-core
///      PoolManager contract deployed directly, the swap/liquidity routers are Uniswap's own
///      official test infrastructure (used by Uniswap's own test suite), and the hook address is
///      mined with the real HookMiner from v4-periphery.
///
/// @dev The strategy is registered via a SwapVM `Order`, exactly like `ExecutionFixture` does for
///      the Aqua path - this is deliberate, not a leftover: `ConditionalLiquidityRegistry` derives
///      a strategy's identity, token pair and rule program from a SwapVM order today, and reusing
///      that same mechanism (rather than inventing a second identity scheme) is what lets the exact
///      same `strategyId` be bound to a Uniswap pool via `registerPoolStrategy`. The SwapVM order
///      itself is never shipped to Aqua or executed here; it only supplies identity.
abstract contract UniswapExecutionFixture is Test {
    using PoolIdLibrary for PoolKey;

    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    ConditionalLiquidityHook internal hook;

    ConditionalLiquidityRegistry internal registry;
    ConditionalLiquidityEngine internal engine;
    MockMarketStateProvider internal oracle;

    MockERC20 internal tokenX;
    MockERC20 internal tokenY;

    PoolKey internal poolKey;
    PoolId internal poolId;
    bytes32 internal strategyId;

    address internal protocolOwner = makeAddr("uniProtocolOwner");
    address internal maker = makeAddr("uniMaker");
    address internal trader = makeAddr("uniTrader");

    int24 internal constant TICK_SPACING = 60;
    uint256 internal constant SEEDED_LIQUIDITY = 1_000_000 ether;

    /// @dev 100 token-equivalent, matching the Aqua MarketShock test's narrative numbers exactly.
    uint256 internal constant BASE_LIQUIDITY = 100 ether;

    function _setUpUniswap() internal {
        _deployTokens();
        _deployProtocolStack();
        _deployUniswapStack();
        _initializePool();
        _registerStrategy();
        _seedLiquidity();

        oracle.setVolatility(strategyId, 2000, 4000e18); // calm start: 20% volatility
    }

    function _deployTokens() private {
        MockERC20 first = new MockERC20("Token X", "TKX", 18);
        MockERC20 second = new MockERC20("Token Y", "TKY", 18);
        (address a, address b) = StrategyLib.sortTokens(address(first), address(second));
        tokenX = MockERC20(a);
        tokenY = MockERC20(b);
    }

    function _deployProtocolStack() private {
        registry = new ConditionalLiquidityRegistry(new StrategyValidator(), protocolOwner);
        oracle = new MockMarketStateProvider();
        engine = new ConditionalLiquidityEngine(registry, oracle);

        vm.prank(protocolOwner);
        registry.setStateAuthority(address(engine));
    }

    function _deployUniswapStack() private {
        // `PoolManager.sol` exact-pins solc 0.8.26, incompatible with this project's 0.8.30 files
        // in one compiler invocation; see test/utils/deployers/PoolManagerImport.sol.
        manager = IPoolManager(vm.deployCode("PoolManager.sol:PoolManager", abi.encode(protocolOwner)));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(manager, engine, registry);
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), flags, type(ConditionalLiquidityHook).creationCode, constructorArgs);

        hook = new ConditionalLiquidityHook{ salt: salt }(manager, engine, registry);
        require(address(hook) == predicted, "hook address mismatch");
    }

    function _initializePool() private {
        poolKey = PoolKey({
            currency0: Currency.wrap(address(tokenX)),
            currency1: Currency.wrap(address(tokenY)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = poolKey.toId();

        // 1:1 initial price: sqrtPriceX96 = sqrt(1) * 2^96.
        manager.initialize(poolKey, uint160(1) << 96);
    }

    function _registerStrategy() private {
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = address(tokenX);
        args.tokenB = address(tokenY);
        args.useAquaInsteadOfSignature = true;
        args.program = hex"5000"; // XYCSwap, 0 args: identity vehicle only, never executed via SwapVM here.
        ISwapVM.Order memory order = MakerTraitsLib.build(args);

        vm.prank(maker);
        strategyId = registry.registerStrategy(
            order, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );

        vm.prank(maker);
        hook.registerPoolStrategy(poolKey, strategyId, BASE_LIQUIDITY, BASE_LIQUIDITY);
    }

    function _seedLiquidity() private {
        tokenX.mint(maker, type(uint128).max);
        tokenY.mint(maker, type(uint128).max);
        vm.startPrank(maker);
        tokenX.approve(address(lpRouter), type(uint256).max);
        tokenY.approve(address(lpRouter), type(uint256).max);

        lpRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(TICK_SPACING),
                tickUpper: TickMath.maxUsableTick(TICK_SPACING),
                liquidityDelta: int256(SEEDED_LIQUIDITY),
                salt: bytes32(0)
            }),
            ""
        );
        vm.stopPrank();
    }

    /// @notice Fund `who` with both tokens and approve the swap router to pull from them.
    function _fundTrader(address who, uint256 amountX, uint256 amountY) internal {
        tokenX.mint(who, amountX);
        tokenY.mint(who, amountY);
        vm.startPrank(who);
        tokenX.approve(address(swapRouter), type(uint256).max);
        tokenY.approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice PoolManager wraps every hook revert in `CustomRevert.WrappedError` (ERC-7751 style)
    ///         before it reaches the caller - this constructs the exact wrapped shape so tests can
    ///         assert on OUR revert reason precisely, rather than loosely accepting any revert.
    function _expectExceedsEffectiveLiquidity(uint256 requestedAmount, uint256 effectiveLiquidity) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(
                    IConditionalLiquidityHook.ExceedsEffectiveLiquidity.selector, poolId, strategyId, requestedAmount, effectiveLiquidity
                ),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
    }

    /// @notice Execute an exact-in swap from tokenX (currency0) to tokenY (currency1).
    function _swapXToY(address who, uint256 amountIn) internal returns (BalanceDelta delta) {
        vm.prank(who);
        delta = swapRouter.swap(
            poolKey,
            SwapParams({ zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
    }
}
