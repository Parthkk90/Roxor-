// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { LPFeeLibrary } from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { ModifyLiquidityParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
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
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";
import { StrategyFixtures } from "./StrategyFixtures.sol";

import { Solver } from "../../contracts/solver/Solver.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { AquaVenue } from "../../contracts/venues/AquaVenue.sol";
import { UniswapV4Venue } from "../../contracts/venues/UniswapV4Venue.sol";

/// @notice Wires an Aqua/SwapVM strategy AND a Uniswap v4 strategy on the SAME token pair, each
///         governed by its own independently-registered strategy (Aqua strategies and Uniswap pool
///         strategies are not cross-registered in the existing registry), then wraps both in venue
///         adapters behind a shared {Solver}.
///
/// @dev Deliberately does not multiply-inherit `ExecutionFixture`/`UniswapExecutionFixture` (both
///      declare colliding names like `registry`/`engine`/`oracle`/`maker`); instead each stack is
///      wired directly here, prefixed `aqua*`/`uni*`.
abstract contract SolverFixture is Test {
    using PoolIdLibrary for PoolKey;

    // ---- shared pair ----
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;

    // ---- Aqua/SwapVM stack ----
    Aqua internal aqua;
    MockWETH internal weth;
    AquaSwapVMRouter internal aquaRouter;
    ConditionalLiquidityRegistry internal aquaRegistry;
    ConditionalLiquidityEngine internal aquaEngine;
    ConditionalLiquidityExtruction internal extruction;
    MockMarketStateProvider internal aquaOracle;
    bytes32 internal aquaStrategyId;
    ISwapVM.Order internal aquaOrder;
    address internal aquaMaker;
    uint256 internal aquaMakerKey;

    // ---- Uniswap v4 stack ----
    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    ConditionalLiquidityHook internal hook;
    ConditionalLiquidityRegistry internal uniRegistry;
    ConditionalLiquidityEngine internal uniEngine;
    MockMarketStateProvider internal uniOracle;
    PoolKey internal poolKey;
    PoolId internal poolId;
    bytes32 internal uniStrategyId;
    address internal uniMaker = makeAddr("uniMaker");

    // ---- marketplace ----
    AquaVenue internal aquaVenue;
    UniswapV4Venue internal uniVenue;
    Solver internal solver;

    address internal protocolOwner = makeAddr("solverProtocolOwner");
    address internal trader = makeAddr("solverTrader");

    int24 internal constant TICK_SPACING = 60;
    uint256 internal constant SEEDED_LIQUIDITY = 1_000_000 ether;

    /// @dev Matches the Aqua/Uniswap MarketShock tests' narrative numbers exactly.
    uint256 internal constant BASE_LIQUIDITY = 100 ether;

    /// @dev Aqua's tokenB side is shipped larger than tokenA's (150 vs 100), so Aqua's live reserve
    ///      ratio prices an A->B trade better than Uniswap's 1:1 pool. This gives the two venues a
    ///      real, provable price difference for "best venue" tests, instead of an accidental tie.
    uint256 internal constant AQUA_BASE_LIQUIDITY_B = 150 ether;

    function _setUpSolver() internal {
        (aquaMaker, aquaMakerKey) = makeAddrAndKey("aquaMaker");

        _deployTokens();
        _deployAquaStack();
        _deployUniswapStack();
        _wireVenuesAndSolver();

        aquaOracle.setVolatility(aquaStrategyId, 2000, 4000e18);
        uniOracle.setVolatility(uniStrategyId, 2000, 4000e18);
    }

    function _deployTokens() private {
        MockERC20 first = new MockERC20("Token A", "TKA", 18);
        MockERC20 second = new MockERC20("Token B", "TKB", 18);
        (address a, address b) = StrategyLib.sortTokens(address(first), address(second));
        tokenA = MockERC20(a);
        tokenB = MockERC20(b);
        weth = new MockWETH();
    }

    function _deployAquaStack() private {
        aqua = new Aqua();
        aquaRouter = new AquaSwapVMRouter(address(aqua), address(weth), protocolOwner, "SolverRouter", "1");

        aquaRegistry = new ConditionalLiquidityRegistry(new StrategyValidator(), protocolOwner);
        aquaOracle = new MockMarketStateProvider();
        aquaEngine = new ConditionalLiquidityEngine(aquaRegistry, aquaOracle);
        extruction = new ConditionalLiquidityExtruction(aquaEngine, aquaRegistry);

        vm.prank(protocolOwner);
        aquaRegistry.setStateAuthority(address(aquaEngine));

        MakerTraitsLib.Args memory args;
        args.maker = aquaMaker;
        args.tokenA = address(tokenA);
        args.tokenB = address(tokenB);
        args.useAquaInsteadOfSignature = true;
        args.program = ConditionalLiquidityProgramLib.build(address(extruction));
        aquaOrder = MakerTraitsLib.build(args);

        vm.prank(aquaMaker);
        aquaStrategyId = aquaRegistry.registerStrategy(
            aquaOrder, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );

        tokenA.mint(aquaMaker, BASE_LIQUIDITY);
        tokenB.mint(aquaMaker, AQUA_BASE_LIQUIDITY_B);

        vm.startPrank(aquaMaker);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = BASE_LIQUIDITY;
        amounts[1] = AQUA_BASE_LIQUIDITY_B;

        bytes32 shippedHash = aqua.ship(address(aquaRouter), abi.encode(aquaOrder), tokens, amounts);
        vm.stopPrank();

        require(shippedHash == aquaStrategyId, "aqua strategyHash must equal registry strategyId");
    }

    function _deployUniswapStack() private {
        uniRegistry = new ConditionalLiquidityRegistry(new StrategyValidator(), protocolOwner);
        uniOracle = new MockMarketStateProvider();
        uniEngine = new ConditionalLiquidityEngine(uniRegistry, uniOracle);

        vm.prank(protocolOwner);
        uniRegistry.setStateAuthority(address(uniEngine));

        manager = IPoolManager(vm.deployCode("PoolManager.sol:PoolManager", abi.encode(protocolOwner)));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(manager, uniEngine, uniRegistry);
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), flags, type(ConditionalLiquidityHook).creationCode, constructorArgs);
        hook = new ConditionalLiquidityHook{ salt: salt }(manager, uniEngine, uniRegistry);
        require(address(hook) == predicted, "hook address mismatch");

        poolKey = PoolKey({
            currency0: Currency.wrap(address(tokenA)),
            currency1: Currency.wrap(address(tokenB)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = poolKey.toId();
        manager.initialize(poolKey, uint160(1) << 96);

        MakerTraitsLib.Args memory args;
        args.maker = uniMaker;
        args.tokenA = address(tokenA);
        args.tokenB = address(tokenB);
        args.useAquaInsteadOfSignature = true;
        args.program = hex"5000"; // identity vehicle only; never executed via SwapVM here.
        ISwapVM.Order memory order = MakerTraitsLib.build(args);

        vm.prank(uniMaker);
        uniStrategyId = uniRegistry.registerStrategy(
            order, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );

        vm.prank(uniMaker);
        hook.registerPoolStrategy(poolKey, uniStrategyId, BASE_LIQUIDITY, BASE_LIQUIDITY);

        tokenA.mint(uniMaker, type(uint128).max);
        tokenB.mint(uniMaker, type(uint128).max);
        vm.startPrank(uniMaker);
        tokenA.approve(address(lpRouter), type(uint256).max);
        tokenB.approve(address(lpRouter), type(uint256).max);
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

    function _wireVenuesAndSolver() private {
        aquaVenue = new AquaVenue(aqua, aquaRouter, aquaEngine, aquaRegistry, aquaStrategyId, aquaOrder);
        uniVenue = new UniswapV4Venue(manager, swapRouter, hook, poolKey);

        ILiquidityVenue[] memory venueList = new ILiquidityVenue[](2);
        venueList[0] = ILiquidityVenue(address(aquaVenue));
        venueList[1] = ILiquidityVenue(address(uniVenue));
        solver = new Solver(venueList);
    }

    /// @notice Fund `who` with both tokens and approve the solver to pull from them.
    function _fundTrader(address who, uint256 amountA, uint256 amountB) internal {
        tokenA.mint(who, amountA);
        tokenB.mint(who, amountB);
        vm.startPrank(who);
        tokenA.approve(address(solver), type(uint256).max);
        tokenB.approve(address(solver), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice Force the Aqua maker's *wallet* balance of `token` to exactly `target`.
    /// @dev Models the real failure this protocol is built around: Aqua's virtual balance is an
    ///      allowance against the maker's wallet (`Aqua.pull` does `safeTransferFrom(maker, ...)`),
    ///      so the maker can move funds out from under a shipped strategy at any time and Aqua's
    ///      advertised balance will not change. Excess is transferred to a sink rather than burned
    ///      so the token's total supply stays consistent, exactly as a real withdrawal would.
    function _setAquaMakerWalletBalance(MockERC20 token, uint256 target) internal {
        uint256 current = token.balanceOf(aquaMaker);
        if (current > target) {
            vm.prank(aquaMaker);
            token.transfer(makeAddr("makerWithdrawalSink"), current - target);
        } else if (current < target) {
            token.mint(aquaMaker, target - current);
        }
    }

    /// @notice Force the Aqua maker's ERC20 approval *to the Aqua contract* to exactly `amount`.
    /// @dev Approval to Aqua — not to the router — is the one that binds: Aqua is the contract
    ///      that calls `transferFrom` on the maker. Passing 0 models a maker revoking mid-flight.
    function _setAquaMakerAllowance(MockERC20 token, uint256 amount) internal {
        vm.prank(aquaMaker);
        token.approve(address(aqua), amount);
    }

    /// @dev Sets identical volatility on both independent strategies, so the plan's "Aqua and
    ///      Uniswap shock together" narrative holds even though they are two separate strategies.
    function _setSharedVolatility(uint256 volatilityBps, uint256 price) internal {
        aquaOracle.setVolatility(aquaStrategyId, volatilityBps, price);
        uniOracle.setVolatility(uniStrategyId, volatilityBps, price);
    }
}
