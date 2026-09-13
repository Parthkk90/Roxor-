// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
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
import { ConditionalLiquidityEngine } from "../../contracts/engine/ConditionalLiquidityEngine.sol";
import { ConditionalLiquidityProgramLib } from "../../contracts/swapvm/ConditionalLiquidityProgramLib.sol";
import { ConditionalLiquidityHook } from "../../contracts/uniswap/ConditionalLiquidityHook.sol";
import { IHookStrategyAdapter } from "../../contracts/uniswap/interfaces/IHookStrategyAdapter.sol";
import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { MockERC20 } from "../../contracts/mocks/MockERC20.sol";
import { MockMarketStateProvider } from "../../contracts/mocks/MockMarketStateProvider.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";

import { Solver } from "../../contracts/solver/Solver.sol";
import { ISolver } from "../../contracts/solver/interfaces/ISolver.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { IExecutableLiquidity } from "../../contracts/venues/interfaces/IExecutableLiquidity.sol";
import { AquaVenue } from "../../contracts/venues/AquaVenue.sol";
import { UniswapV4Venue } from "../../contracts/venues/UniswapV4Venue.sol";

import { SepoliaReuse } from "../../script/SepoliaReuse.sol";

/// @notice Runs the whole `script/DeploySepolia.s.sol` plan against a fork of live Ethereum
///         Sepolia, then trades through it, before a single wei of real testnet gas is spent.
///
/// @dev This is the gate on the deployment, not a regression test of the contracts - those are
///      covered by the local suites. What only a fork can answer is whether the *reused* Sepolia
///      state is actually what the audit concluded it is: whether the reconstructed SwapVM order
///      really hashes to the strategy already shipped into Aqua, whether Uniswap's own Sepolia
///      `PoolManager` / `PoolSwapTest` / `PoolModifyLiquidityTest` are ABI-compatible with the
///      v4-core version this repository compiles against, and whether a real `Solver.settle`
///      clears end to end over both backends at once.
///
/// @dev Skips itself when no Sepolia RPC is reachable, so `forge test` stays hermetic.
contract SepoliaMarketplaceForkTest is Test {
    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_1_1 = uint160(1) << 96;
    uint256 internal constant POOL_BASE_LIQUIDITY = 10 ether;
    uint256 internal constant POOL_POSITION_LIQUIDITY = 20 ether;
    uint256 internal constant POOL_FUNDING = 25 ether;

    address internal constant MAKER = 0x025e4Cd04a671C309572fA3E6dEc9A8C79b847F4;

    AquaVenue internal aquaVenue;
    UniswapV4Venue internal uniVenue;
    Solver internal solver;
    PoolKey internal poolKey;

    address internal trader = makeAddr("trader");

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("sepolia")) { }
        catch {
            return;
        }
        if (block.chainid != SepoliaReuse.CHAIN_ID) {
            return;
        }

        // The hook is CREATE2-deployed by this test contract, so its salt is mined against
        // `address(this)`. On the real broadcast path Foundry routes `new X{salt:}` through the
        // canonical CREATE2 proxy instead, which is why `script/DeploySepolia.s.sol` mines against
        // {SepoliaReuse.CREATE2_DEPLOYER}. Same contract, same permission bits, different creator.
        ConditionalLiquidityHook hook = _deployHook();

        vm.startPrank(MAKER);
        aquaVenue = new AquaVenue(
            IAqua(SepoliaReuse.AQUA),
            AquaSwapVMRouter(payable(SepoliaReuse.AQUA_SWAPVM_ROUTER)),
            ConditionalLiquidityEngine(SepoliaReuse.AQUA_ENGINE),
            ConditionalLiquidityRegistry(SepoliaReuse.AQUA_REGISTRY),
            SepoliaReuse.AQUA_STRATEGY_ID,
            _reconstructAquaOrder()
        );
        uniVenue = _deployUniswapLeg(hook);

        ILiquidityVenue[] memory venues = new ILiquidityVenue[](2);
        venues[0] = ILiquidityVenue(address(aquaVenue));
        venues[1] = ILiquidityVenue(address(uniVenue));
        solver = new Solver(venues);
        vm.stopPrank();
    }

    modifier onFork() {
        if (block.chainid != SepoliaReuse.CHAIN_ID) {
            vm.skip(true);
        }
        _;
    }

    /// @dev The order is not stored anywhere on-chain in a form this script can read back, so it
    ///      is rebuilt from first principles. Equality of the derived strategy id with the one the
    ///      registry already holds is the proof the rebuild is exact.
    function _reconstructAquaOrder() internal view returns (ISwapVM.Order memory order) {
        MakerTraitsLib.Args memory args;
        args.maker = MAKER;
        args.tokenA = SepoliaReuse.DTB;
        args.tokenB = SepoliaReuse.DTA;
        args.useAquaInsteadOfSignature = true;
        args.program = ConditionalLiquidityProgramLib.build(SepoliaReuse.AQUA_EXTRUCTION);
        order = MakerTraitsLib.build(args);
    }

    function _deployHook() internal returns (ConditionalLiquidityHook hook) {
        IPoolManager manager = IPoolManager(SepoliaReuse.V4_POOL_MANAGER);
        bytes memory ctorArgs = abi.encode(manager, SepoliaReuse.UNI_ENGINE, SepoliaReuse.UNI_REGISTRY);
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), uint160(Hooks.BEFORE_SWAP_FLAG), type(ConditionalLiquidityHook).creationCode, ctorArgs);
        hook = new ConditionalLiquidityHook{ salt: salt }(
            manager, ConditionalLiquidityEngine(SepoliaReuse.UNI_ENGINE), ConditionalLiquidityRegistry(SepoliaReuse.UNI_REGISTRY)
        );
        assertEq(address(hook), predicted, "hook address mismatch");
    }

    function _deployUniswapLeg(ConditionalLiquidityHook hook) internal returns (UniswapV4Venue venue) {
        IPoolManager manager = IPoolManager(SepoliaReuse.V4_POOL_MANAGER);

        poolKey = PoolKey({
            currency0: Currency.wrap(SepoliaReuse.DTB),
            currency1: Currency.wrap(SepoliaReuse.DTA),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        hook.registerPoolStrategy(poolKey, SepoliaReuse.UNI_STRATEGY_ID, POOL_BASE_LIQUIDITY, POOL_BASE_LIQUIDITY);

        PoolModifyLiquidityTest lpRouter = PoolModifyLiquidityTest(SepoliaReuse.V4_POOL_MODIFY_LIQUIDITY_TEST);
        MockERC20(SepoliaReuse.DTB).mint(MAKER, POOL_FUNDING);
        MockERC20(SepoliaReuse.DTA).mint(MAKER, POOL_FUNDING);
        MockERC20(SepoliaReuse.DTB).approve(address(lpRouter), POOL_FUNDING);
        MockERC20(SepoliaReuse.DTA).approve(address(lpRouter), POOL_FUNDING);
        lpRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(TICK_SPACING),
                tickUpper: TickMath.maxUsableTick(TICK_SPACING),
                liquidityDelta: int256(POOL_POSITION_LIQUIDITY),
                salt: bytes32(0)
            }),
            ""
        );

        venue = new UniswapV4Venue(manager, PoolSwapTest(SepoliaReuse.V4_POOL_SWAP_TEST), IHookStrategyAdapter(address(hook)), poolKey);
    }

    /* ------------------------------------------------------------------ the reuse claims */

    function test_ReconstructedOrderMatchesTheStrategyAlreadyShippedIntoAqua() public onFork {
        assertEq(StrategyLib.strategyIdMemory(_reconstructAquaOrder()), SepoliaReuse.AQUA_STRATEGY_ID);
        assertEq(aquaVenue.STRATEGY_ID(), SepoliaReuse.AQUA_STRATEGY_ID);
    }

    function test_ReusedAquaStrategyIsLiveAndShipped() public onFork {
        assertTrue(ConditionalLiquidityRegistry(SepoliaReuse.AQUA_REGISTRY).isActive(SepoliaReuse.AQUA_STRATEGY_ID));
        (uint256 balanceIn, uint256 balanceOut) = IAqua(SepoliaReuse.AQUA)
            .safeBalances(MAKER, SepoliaReuse.AQUA_SWAPVM_ROUTER, SepoliaReuse.AQUA_STRATEGY_ID, SepoliaReuse.DTB, SepoliaReuse.DTA);
        assertGt(balanceIn, 0, "no DTB shipped");
        assertGt(balanceOut, 0, "no DTA shipped");
    }

    /* --------------------------------------------- the property missing from the old deployment */

    function test_BothVenuesExposeExecutableLiquidityBoundedByRealSolvency() public onFork {
        for (uint256 i = 0; i < 2; ++i) {
            ILiquidityVenue venue = i == 0 ? ILiquidityVenue(address(aquaVenue)) : ILiquidityVenue(address(uniVenue));
            IExecutableLiquidity.ExecutableLiquidity memory exec = venue.executableLiquidity(SepoliaReuse.DTB, SepoliaReuse.DTA);

            assertLe(exec.deliverableLiquidity, exec.virtualLiquidity, "deliverable exceeds advertised");
            assertLe(exec.deliverableLiquidity, exec.walletLiquidity, "deliverable exceeds wallet");
            assertLe(exec.deliverableLiquidity, exec.allowance, "deliverable exceeds allowance");
            assertLe(exec.conditionalLiquidity, exec.deliverableLiquidity, "conditional exceeds deliverable");
            assertEq(venue.snapshot(SepoliaReuse.DTB, SepoliaReuse.DTA).effectiveLiquidity, exec.conditionalLiquidity);
        }
    }

    function test_SolverNeverRoutesBeyondExecutableLiquidity() public onFork {
        ISolver.ExecutionPlan memory plan = solver.route(_request(1 ether));
        assertEq(plan.totalAmountIn, 1 ether);
        for (uint256 i = 0; i < plan.legs.length; ++i) {
            IExecutableLiquidity.ExecutableLiquidity memory exec =
                ILiquidityVenue(plan.legs[i].venue).executableLiquidity(SepoliaReuse.DTB, SepoliaReuse.DTA);
            assertLe(plan.legs[i].amountIn, exec.conditionalLiquidity);
        }
    }

    /* ------------------------------------------------------------------ real settlement */

    function test_SettlesARealSwapAcrossTheLiveSepoliaStack() public onFork {
        uint256 amountIn = 1 ether;
        MockERC20(SepoliaReuse.DTB).mint(trader, amountIn);
        vm.startPrank(trader);
        MockERC20(SepoliaReuse.DTB).approve(address(solver), amountIn);
        uint256 before = MockERC20(SepoliaReuse.DTA).balanceOf(trader);
        uint256 out = solver.settle(_request(amountIn), 0);
        vm.stopPrank();

        assertGt(out, 0, "no output");
        assertEq(MockERC20(SepoliaReuse.DTA).balanceOf(trader) - before, out, "output not delivered");
    }

    /// @dev Forces the split the single-venue case never exercises: with Aqua's maker holding less
    ///      than it advertises, an order larger than the deliverable amount must spill onto the
    ///      Uniswap pool rather than being routed against liquidity Aqua could not pay.
    function test_PhantomLiquidityPushesTheRouteOntoUniswap() public onFork {
        uint256 makerBalance = MockERC20(SepoliaReuse.DTB).balanceOf(MAKER);
        vm.prank(MAKER);
        MockERC20(SepoliaReuse.DTB).transfer(address(0xdead), makerBalance - 2 ether);

        IExecutableLiquidity.ExecutableLiquidity memory exec = aquaVenue.executableLiquidity(SepoliaReuse.DTB, SepoliaReuse.DTA);
        assertEq(exec.deliverableLiquidity, 2 ether, "solvency bound did not bind");
        assertLt(exec.deliverableLiquidity, exec.virtualLiquidity, "no phantom gap to demonstrate");

        ISolver.ExecutionPlan memory plan = solver.route(_request(3 ether));
        assertEq(plan.legs.length, 2, "route did not split");
        assertEq(plan.legs[0].amountIn + plan.legs[1].amountIn, 3 ether);

        uint256 aquaLeg = plan.legs[0].venue == address(aquaVenue) ? plan.legs[0].amountIn : plan.legs[1].amountIn;
        assertLe(aquaLeg, exec.conditionalLiquidity, "routed past what Aqua can settle");
    }

    /// @dev The regime change must come from the deployed rule program reacting to the deployed
    ///      oracle, never from the test asserting a mode directly.
    function test_ShockingTheOracleCollapsesExecutableDepthOnChain() public onFork {
        uint256 before = aquaVenue.executableLiquidity(SepoliaReuse.DTB, SepoliaReuse.DTA).conditionalLiquidity;
        assertEq(uint8(aquaVenue.snapshot(SepoliaReuse.DTB, SepoliaReuse.DTA).mode), uint8(IStrategyTypes.StrategyMode.NORMAL));

        MockMarketStateProvider(SepoliaReuse.AQUA_ORACLE).setVolatility(SepoliaReuse.AQUA_STRATEGY_ID, 6500, 4000e18);

        ILiquidityVenue.VenueSnapshot memory snap = aquaVenue.snapshot(SepoliaReuse.DTB, SepoliaReuse.DTA);
        assertEq(uint8(snap.mode), uint8(IStrategyTypes.StrategyMode.DEFENSIVE), "strategy did not go defensive");
        assertLt(snap.effectiveLiquidity, before, "defensive mode did not reduce depth");
    }

    function _request(uint256 amount) internal pure returns (ISolver.TraderRequest memory) {
        return ISolver.TraderRequest({ tokenIn: SepoliaReuse.DTB, tokenOut: SepoliaReuse.DTA, amount: amount, maxSlippageBps: 10_000 });
    }
}
