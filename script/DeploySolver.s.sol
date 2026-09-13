// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

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

import { ConditionalLiquidityRegistry } from "../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../contracts/core/StrategyValidator.sol";
import { ConditionalLiquidityEngine } from "../contracts/engine/ConditionalLiquidityEngine.sol";
import { ConditionalLiquidityExtruction } from "../contracts/swapvm/ConditionalLiquidityExtruction.sol";
import { ConditionalLiquidityProgramLib } from "../contracts/swapvm/ConditionalLiquidityProgramLib.sol";
import { ConditionalLiquidityHook } from "../contracts/uniswap/ConditionalLiquidityHook.sol";
import { MockERC20 } from "../contracts/mocks/MockERC20.sol";
import { MockWETH } from "../contracts/mocks/MockWETH.sol";
import { MockMarketStateProvider } from "../contracts/mocks/MockMarketStateProvider.sol";
import { StrategyLib } from "../contracts/libraries/StrategyLib.sol";
import { StrategyFixtures } from "../test/utils/StrategyFixtures.sol";

import { Solver } from "../contracts/solver/Solver.sol";
import { ILiquidityVenue } from "../contracts/solver/interfaces/ILiquidityVenue.sol";
import { AquaVenue } from "../contracts/venues/AquaVenue.sol";
import { UniswapV4Venue } from "../contracts/venues/UniswapV4Venue.sol";

/// @notice Deploys the full Part 6 marketplace stack on a live network: THREE independent demo
///         markets (DWA/DUSDC, DWA/DDAI, DUSDC/DDAI), each with its own Aqua/SwapVM strategy and
///         Uniswap-v4-pool strategy, wrapped in {AquaVenue}/{UniswapV4Venue}, behind its own
///         {Solver} - a {Solver} snapshots every venue it holds unconditionally, so one venue set
///         per market is required, not a per-pair filter inside a shared Solver.
///
///         Mirrors `test/utils/SolverFixture.sol`'s per-market wiring, repeated three times, as a
///         broadcastable script with a single funded EOA acting as both makers and deployer.
///
/// @dev PoolManager is deployed fresh via `vm.deployCode`, same reason as
///      `script/DeployUniswapHook.s.sol`: `PoolManager.sol` pins solc 0.8.26, incompatible with
///      this project's 0.8.30 files in one compiler invocation.
///
/// @dev All three tokens are 18 decimals and every pool is seeded 1:1. `Solver._quoteOut`/`route`
///      compares `tokenOut`-denominated output against a `tokenIn`-denominated slippage floor
///      (see `Solver.sol`), which only cancels out at 18/18 decimals and a ~1:1 price. That is an
///      existing routing-layer unit assumption this script does not change; it is why the demo
///      tokens are same-decimal mocks rather than realistic WETH/USDC-shaped ones.
contract DeploySolver is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint256 internal constant BASE_LIQUIDITY = 100 ether;
    uint256 internal constant QUOTE_BASE_LIQUIDITY = 150 ether;
    uint256 internal constant SEEDED_LIQUIDITY = 1_000_000 ether;
    int24 internal constant TICK_SPACING = 60;

    /// @dev Volatility shock used to genuinely walk a market's strategy into DEFENSIVE via the
    ///      real rule program (`StrategyFixtures.volatilityShield`), not by writing state
    ///      directly. RECOVERY additionally needs `CALM_PERIOD` (10 minutes) of chain time to
    ///      elapse after this, which a single broadcast cannot do - see `script/SeedRecovery.s.sol`.
    uint256 internal constant DEFENSIVE_SHOCK_BPS = 6500;
    uint256 internal constant CALM_VOLATILITY_BPS = 2000;
    uint256 internal constant REFERENCE_PRICE = 4000e18;

    struct Market {
        string label;
        address tokenIn;
        address tokenOut;
        Solver solver;
        AquaVenue aquaVenue;
        UniswapV4Venue uniVenue;
        address aquaOracle;
        bytes32 aquaStrategyId;
        address uniOracle;
        bytes32 uniStrategyId;
    }

    /// @dev Shared Uniswap-v4 infrastructure. One `PoolManager` and one mined hook host all three
    ///      pools (`registerPoolStrategy` is per-`PoolKey`, so this is supported), which keeps
    ///      deploy cost and script size down without touching how any single market behaves.
    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    ConditionalLiquidityHook internal hook;

    /// @dev Shared Aqua/SwapVM infrastructure, same rationale.
    Aqua internal aqua;
    AquaSwapVMRouter internal aquaRouter;

    function run() external returns (Market[3] memory markets) {
        vm.startBroadcast();

        // Resolved AFTER startBroadcast: msg.sender here is the actual broadcasting account
        // (the --account/--private-key given to `forge script`), not Foundry's default
        // simulation sender that msg.sender would resolve to beforehand.
        address maker = vm.envOr("MAKER", msg.sender);
        address owner = vm.envOr("OWNER", msg.sender);

        (MockERC20 dwa, MockERC20 dusdc, MockERC20 ddai) = _deployTokens();

        MockWETH weth = new MockWETH();
        aqua = new Aqua();
        aquaRouter = new AquaSwapVMRouter(address(aqua), address(weth), owner, "SolverRouter", "1");
        manager = IPoolManager(vm.deployCode("PoolManager.sol:PoolManager", abi.encode(owner)));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);
        hook = _deployHook(owner);

        // Market 1: DWA/DUSDC - left at NORMAL, exactly as the original single-market deployment.
        markets[0] = _deployMarket("DWA/DUSDC", owner, maker, dwa, dusdc);

        // Market 2: DWA/DDAI - shocked into DEFENSIVE via the real rule program.
        markets[1] = _deployMarket("DWA/DDAI", owner, maker, dwa, ddai);
        _shock(markets[1], DEFENSIVE_SHOCK_BPS);

        // Market 3: DUSDC/DDAI - left at NORMAL here; `script/SeedRecovery.s.sol` walks it through
        // DEFENSIVE -> RECOVERY afterwards, once chain time can actually advance (anvil) or has
        // actually elapsed (a live testnet).
        markets[2] = _deployMarket("DUSDC/DDAI", owner, maker, dusdc, ddai);

        vm.stopBroadcast();

        for (uint256 i = 0; i < markets.length; ++i) {
            _log(markets[i]);
        }
        _writeDeployment(markets);
    }

    function _deployTokens() private returns (MockERC20 dwa, MockERC20 dusdc, MockERC20 ddai) {
        dwa = new MockERC20("Demo Wrapped Asset", "DWA", 18);
        dusdc = new MockERC20("Demo USD Coin", "DUSDC", 18);
        ddai = new MockERC20("Demo Dai", "DDAI", 18);
    }

    function _deployHook(address owner) private returns (ConditionalLiquidityHook deployedHook) {
        // The hook is bound to one registry+engine pair at construction, but `registerPoolStrategy`
        // takes the strategy id per pool - so a single hook instance can host independently-staffed
        // strategies for all three pools as long as each pool's strategy lives in the same
        // registry. We give the shared hook its own registry/engine (separate from every market's
        // Aqua-side registry), used only for the Uniswap leg of all three markets.
        ConditionalLiquidityRegistry registry = new ConditionalLiquidityRegistry(new StrategyValidator(), owner);
        MockMarketStateProvider oracle = new MockMarketStateProvider();
        ConditionalLiquidityEngine engine = new ConditionalLiquidityEngine(registry, oracle);
        registry.setStateAuthority(address(engine));

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(manager, engine, registry);
        (address predicted, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(ConditionalLiquidityHook).creationCode, constructorArgs);
        deployedHook = new ConditionalLiquidityHook{ salt: salt }(manager, engine, registry);
        require(address(deployedHook) == predicted, "hook address mismatch");

        _uniRegistry = registry;
        _uniEngine = engine;
        _uniOracle = oracle;
    }

    // Set once by `_deployHook`, read by every `_deployMarket` call - the shared Uniswap-side
    // registry/engine/oracle backing all three pools' strategies.
    ConditionalLiquidityRegistry private _uniRegistry;
    ConditionalLiquidityEngine private _uniEngine;
    MockMarketStateProvider private _uniOracle;

    function _deployMarket(
        string memory label,
        address owner,
        address maker,
        MockERC20 tokenX,
        MockERC20 tokenY
    ) private returns (Market memory market) {
        (address tokenA, address tokenB) = StrategyLib.sortTokens(address(tokenX), address(tokenY));

        (bytes32 aStrategyId, ConditionalLiquidityEngine aquaEngine, ConditionalLiquidityRegistry aquaRegistry, address aquaOracle, ISwapVM.Order memory aquaOrder) =
            _deployAquaStrategy(owner, maker, tokenA, tokenB);

        (bytes32 uStrategyId, PoolKey memory poolKey) = _deployUniswapStrategy(maker, tokenA, tokenB);

        AquaVenue aquaVenue = new AquaVenue(aqua, aquaRouter, aquaEngine, aquaRegistry, aStrategyId, aquaOrder);
        UniswapV4Venue uniVenue = new UniswapV4Venue(manager, swapRouter, hook, poolKey);

        ILiquidityVenue[] memory venueList = new ILiquidityVenue[](2);
        venueList[0] = ILiquidityVenue(address(aquaVenue));
        venueList[1] = ILiquidityVenue(address(uniVenue));
        Solver solver = new Solver(venueList);

        market = Market({
            label: label,
            tokenIn: tokenA,
            tokenOut: tokenB,
            solver: solver,
            aquaVenue: aquaVenue,
            uniVenue: uniVenue,
            aquaOracle: aquaOracle,
            aquaStrategyId: aStrategyId,
            uniOracle: address(_uniOracle),
            uniStrategyId: uStrategyId
        });
    }

    function _deployAquaStrategy(
        address owner,
        address maker,
        address tokenA,
        address tokenB
    )
        private
        returns (
            bytes32 strategyId,
            ConditionalLiquidityEngine engine,
            ConditionalLiquidityRegistry registry,
            address oracleAddr,
            ISwapVM.Order memory order
        )
    {
        registry = new ConditionalLiquidityRegistry(new StrategyValidator(), owner);
        MockMarketStateProvider oracle = new MockMarketStateProvider();
        engine = new ConditionalLiquidityEngine(registry, oracle);
        ConditionalLiquidityExtruction extruction = new ConditionalLiquidityExtruction(engine, registry);
        registry.setStateAuthority(address(engine));
        oracleAddr = address(oracle);

        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = tokenA;
        args.tokenB = tokenB;
        args.useAquaInsteadOfSignature = true;
        args.program = ConditionalLiquidityProgramLib.build(address(extruction));
        order = MakerTraitsLib.build(args);

        strategyId = registry.registerStrategy(
            order, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );

        MockERC20(tokenA).mint(maker, BASE_LIQUIDITY);
        MockERC20(tokenB).mint(maker, QUOTE_BASE_LIQUIDITY);
        MockERC20(tokenA).approve(address(aqua), type(uint256).max);
        MockERC20(tokenB).approve(address(aqua), type(uint256).max);

        address[] memory tokens = new address[](2);
        tokens[0] = tokenA;
        tokens[1] = tokenB;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = BASE_LIQUIDITY;
        amounts[1] = QUOTE_BASE_LIQUIDITY;
        aqua.ship(address(aquaRouter), abi.encode(order), tokens, amounts);

        oracle.setVolatility(strategyId, CALM_VOLATILITY_BPS, REFERENCE_PRICE);
    }

    function _deployUniswapStrategy(
        address maker,
        address tokenA,
        address tokenB
    ) private returns (bytes32 strategyId, PoolKey memory poolKey) {
        poolKey = PoolKey({
            currency0: Currency.wrap(tokenA),
            currency1: Currency.wrap(tokenB),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        manager.initialize(poolKey, uint160(1) << 96);

        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = tokenA;
        args.tokenB = tokenB;
        args.useAquaInsteadOfSignature = true;
        args.program = hex"5000";
        ISwapVM.Order memory order = MakerTraitsLib.build(args);

        strategyId = _uniRegistry.registerStrategy(
            order, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );
        hook.registerPoolStrategy(poolKey, strategyId, BASE_LIQUIDITY, BASE_LIQUIDITY);

        // MockERC20 supply is free to mint (it's our own test token, not real testnet ETH), so
        // mint generously: full-range liquidity needs far more raw tokens than the liquidityDelta
        // number itself for a 1:1-priced pool.
        MockERC20(tokenA).mint(maker, type(uint128).max);
        MockERC20(tokenB).mint(maker, type(uint128).max);
        MockERC20(tokenA).approve(address(lpRouter), type(uint256).max);
        MockERC20(tokenB).approve(address(lpRouter), type(uint256).max);
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

        _uniOracle.setVolatility(strategyId, CALM_VOLATILITY_BPS, REFERENCE_PRICE);
    }

    /// @dev Walks a market's Aqua AND Uniswap strategies into DEFENSIVE via the real rule program:
    ///      push volatility above `ENTER_DEFENSIVE_BPS` on both oracles, then `poke()` both engines
    ///      to persist the transition (reads are live either way, but `poke` is what a real keeper
    ///      would call, and it's what leaves `StateTransition` events for the subgraph).
    function _shock(Market memory market, uint256 volatilityBps) private {
        MockMarketStateProvider(market.aquaOracle).setVolatility(market.aquaStrategyId, volatilityBps, REFERENCE_PRICE);
        _uniOracle.setVolatility(market.uniStrategyId, volatilityBps, REFERENCE_PRICE);

        market.aquaVenue.ENGINE().poke(market.aquaStrategyId);
        _uniEngine.poke(market.uniStrategyId);
    }

    function _log(Market memory market) private pure {
        console.log("--- Market:", market.label);
        console.log("Token in:      ", market.tokenIn);
        console.log("Token out:     ", market.tokenOut);
        console.log("Solver:        ", address(market.solver));
        console.log("AquaVenue:     ", address(market.aquaVenue));
        console.log("UniswapV4Venue:", address(market.uniVenue));
        console.log("Aqua oracle:   ", market.aquaOracle);
        console.log("Uni oracle:    ", market.uniOracle);
        console.log("Aqua strategy:");
        console.logBytes32(market.aquaStrategyId);
        console.log("Uni strategy:");
        console.logBytes32(market.uniStrategyId);
    }

    function _writeDeployment(Market[3] memory markets) private {
        string memory root = "deployment";
        string memory marketsKey = "markets";
        string[] memory marketJson = new string[](markets.length);

        for (uint256 i = 0; i < markets.length; ++i) {
            Market memory m = markets[i];
            string memory obj = string(abi.encodePacked("market", vm.toString(i)));
            vm.serializeString(obj, "label", m.label);
            vm.serializeAddress(obj, "tokenIn", m.tokenIn);
            vm.serializeAddress(obj, "tokenOut", m.tokenOut);
            vm.serializeAddress(obj, "solver", address(m.solver));
            vm.serializeAddress(obj, "aquaVenue", address(m.aquaVenue));
            vm.serializeAddress(obj, "uniswapV4Venue", address(m.uniVenue));
            vm.serializeAddress(obj, "aquaOracle", m.aquaOracle);
            vm.serializeBytes32(obj, "aquaStrategyId", m.aquaStrategyId);
            vm.serializeAddress(obj, "uniOracle", m.uniOracle);
            marketJson[i] = vm.serializeBytes32(obj, "uniStrategyId", m.uniStrategyId);
        }

        string memory finalJson = vm.serializeString(root, marketsKey, marketJson);
        string memory outPath = string(abi.encodePacked(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
        vm.writeJson(finalJson, outPath);
        console.log("Wrote deployment addresses to", outPath);
    }
}
