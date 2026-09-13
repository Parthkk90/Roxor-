// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
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
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { ModifyLiquidityParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { HookMiner } from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import { ConditionalLiquidityRegistry } from "../contracts/core/ConditionalLiquidityRegistry.sol";
import { ConditionalLiquidityEngine } from "../contracts/engine/ConditionalLiquidityEngine.sol";
import { ConditionalLiquidityExtruction } from "../contracts/swapvm/ConditionalLiquidityExtruction.sol";
import { ConditionalLiquidityProgramLib } from "../contracts/swapvm/ConditionalLiquidityProgramLib.sol";
import { ConditionalLiquidityHook } from "../contracts/uniswap/ConditionalLiquidityHook.sol";
import { IHookStrategyAdapter } from "../contracts/uniswap/interfaces/IHookStrategyAdapter.sol";
import { MockERC20 } from "../contracts/mocks/MockERC20.sol";
import { StrategyLib } from "../contracts/libraries/StrategyLib.sol";

import { Solver } from "../contracts/solver/Solver.sol";
import { ILiquidityVenue } from "../contracts/solver/interfaces/ILiquidityVenue.sol";
import { AquaVenue } from "../contracts/venues/AquaVenue.sol";
import { UniswapV4Venue } from "../contracts/venues/UniswapV4Venue.sol";

import { SepoliaReuse } from "./SepoliaReuse.sol";

/// @notice Deploys ONLY the parts of the Conditional Liquidity Marketplace that Ethereum Sepolia
///         is actually missing, and reuses everything the on-chain audit proved is still valid.
///
/// @dev WHY THIS SCRIPT EXISTS. Sepolia already carried a marketplace deployment, but the audit
///      (`scripts/audit/*.mjs`) showed its three marketplace contracts - `AquaVenue`,
///      `UniswapV4Venue` and `Solver` - predate the executable-liquidity work: they return a
///      six-field `VenueSnapshot` with no `coverageBps`, and `executableLiquidity(...)` reverts
///      because the function does not exist on them. The single property this product is built
///      around, "the solver routes against liquidity that can actually execute", was therefore
///      absent from the public deployment. Those three, and only those three, are redeployed.
///
/// @dev WHAT IS *NOT* REDEPLOYED. The tokens, Aqua, `AquaSwapVMRouter`, both
///      registry/validator/engine/extruction sets, both `MockMarketStateProvider`s and both
///      registered strategies are reused verbatim from {SepoliaReuse} - all verified on-chain
///      against artifacts this repository builds today. Re-shipping Aqua liquidity or
///      re-registering a strategy would spend testnet gas to arrive back where the chain already
///      is.
///
/// @dev WHAT MOVES. The Uniswap v4 leg is re-pointed from the private `PoolManager` the earlier
///      run deployed (owner = this project's deployer) onto Uniswap's own Sepolia `PoolManager`.
///      A v4 hook is bound to its manager at construction, so that migration necessarily brings a
///      freshly-mined `ConditionalLiquidityHook`, a pool initialization and a liquidity position
///      with it. The *strategy* behind that pool is still the one already registered on-chain.
contract DeploySepolia is Script {
    using PoolIdLibrary for PoolKey;

    int24 internal constant TICK_SPACING = 60;
    uint160 internal constant SQRT_PRICE_1_1 = uint160(1) << 96;

    /// @notice Depth the Uniswap pool advertises per side, before the strategy multiplier.
    /// @dev Deliberately two orders of magnitude below the previous deployment's `100 ether`:
    ///      this demonstration settles single-token trades, so a 10-token ceiling is already far
    ///      more headroom than it needs. See `docs/sepolia-deployment.md` (minimal-usage policy).
    uint256 internal constant POOL_BASE_LIQUIDITY = 10 ether;

    /// @notice Full-range position size. At a 1:1 price this puts ~20 of each token into the
    ///         PoolManager's custody, which is the real depth backing the advertised ceiling.
    uint256 internal constant POOL_POSITION_LIQUIDITY = 20 ether;

    /// @notice Minted to the deployer purely to fund {POOL_POSITION_LIQUIDITY}, with a small
    ///         margin. The previous deployment minted `type(uint128).max` of each token here.
    uint256 internal constant POOL_FUNDING = 25 ether;

    function run() external returns (address aquaVenue, address uniVenue, address solver, address hook) {
        require(block.chainid == SepoliaReuse.CHAIN_ID, "not Ethereum Sepolia");

        vm.startBroadcast();
        address deployer = msg.sender;

        ISwapVM.Order memory order = _reconstructAquaOrder(deployer);

        aquaVenue = address(
            new AquaVenue(
                IAqua(SepoliaReuse.AQUA),
                AquaSwapVMRouter(payable(SepoliaReuse.AQUA_SWAPVM_ROUTER)),
                ConditionalLiquidityEngine(SepoliaReuse.AQUA_ENGINE),
                ConditionalLiquidityRegistry(SepoliaReuse.AQUA_REGISTRY),
                SepoliaReuse.AQUA_STRATEGY_ID,
                order
            )
        );

        PoolKey memory poolKey;
        (hook, poolKey) = _deployHookAndPool();
        uniVenue = address(
            new UniswapV4Venue(
                IPoolManager(SepoliaReuse.V4_POOL_MANAGER),
                PoolSwapTest(SepoliaReuse.V4_POOL_SWAP_TEST),
                IHookStrategyAdapter(hook),
                poolKey
            )
        );

        ILiquidityVenue[] memory venueList = new ILiquidityVenue[](2);
        venueList[0] = ILiquidityVenue(aquaVenue);
        venueList[1] = ILiquidityVenue(uniVenue);
        solver = address(new Solver(venueList));

        vm.stopBroadcast();

        console.log("AquaVenue      ", aquaVenue);
        console.log("UniswapV4Venue ", uniVenue);
        console.log("Solver         ", solver);
        console.log("Hook           ", hook);
        console.log("PoolId");
        console.logBytes32(PoolId.unwrap(poolKey.toId()));

        _writeManifest(deployer, aquaVenue, uniVenue, solver, hook, poolKey);
    }

    /// @dev The `AquaVenue` constructor needs the exact `ISwapVM.Order` the strategy was shipped
    ///      with - it replays that order on every `execute`. Rebuilding it from the same inputs
    ///      `DeployAquaFix` used and asserting the resulting strategy id matches the one already
    ///      on-chain is what proves the reconstruction is byte-identical, rather than merely
    ///      plausible.
    function _reconstructAquaOrder(address maker) private view returns (ISwapVM.Order memory order) {
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = SepoliaReuse.DTB;
        args.tokenB = SepoliaReuse.DTA;
        args.useAquaInsteadOfSignature = true;
        args.program = ConditionalLiquidityProgramLib.build(SepoliaReuse.AQUA_EXTRUCTION);
        order = MakerTraitsLib.build(args);

        require(
            StrategyLib.strategyIdMemory(order) == SepoliaReuse.AQUA_STRATEGY_ID,
            "reconstructed order does not match the registered strategy"
        );
    }

    /// @dev Mines a hook address carrying the `BEFORE_SWAP` permission bit, deploys it against
    ///      Uniswap's own PoolManager, initializes the pool and seeds the minimum position the
    ///      demonstration needs. The strategy bound to the pool is the one already registered
    ///      in {SepoliaReuse.UNI_REGISTRY}; no new strategy is created.
    function _deployHookAndPool() private returns (address hook, PoolKey memory poolKey) {
        IPoolManager manager = IPoolManager(SepoliaReuse.V4_POOL_MANAGER);

        bytes memory constructorArgs = abi.encode(manager, SepoliaReuse.UNI_ENGINE, SepoliaReuse.UNI_REGISTRY);
        (address predicted, bytes32 salt) = HookMiner.find(
            SepoliaReuse.CREATE2_DEPLOYER, uint160(Hooks.BEFORE_SWAP_FLAG), type(ConditionalLiquidityHook).creationCode, constructorArgs
        );
        ConditionalLiquidityHook deployed = new ConditionalLiquidityHook{ salt: salt }(
            manager, ConditionalLiquidityEngine(SepoliaReuse.UNI_ENGINE), ConditionalLiquidityRegistry(SepoliaReuse.UNI_REGISTRY)
        );
        require(address(deployed) == predicted, "hook address mismatch");
        hook = address(deployed);

        poolKey = PoolKey({
            currency0: Currency.wrap(SepoliaReuse.DTB),
            currency1: Currency.wrap(SepoliaReuse.DTA),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        deployed.registerPoolStrategy(poolKey, SepoliaReuse.UNI_STRATEGY_ID, POOL_BASE_LIQUIDITY, POOL_BASE_LIQUIDITY);

        PoolModifyLiquidityTest lpRouter = PoolModifyLiquidityTest(SepoliaReuse.V4_POOL_MODIFY_LIQUIDITY_TEST);
        MockERC20(SepoliaReuse.DTB).mint(msg.sender, POOL_FUNDING);
        MockERC20(SepoliaReuse.DTA).mint(msg.sender, POOL_FUNDING);
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
    }

    function _writeManifest(
        address deployer,
        address aquaVenue,
        address uniVenue,
        address solver,
        address hook,
        PoolKey memory poolKey
    )
        private
    {
        string memory market = "market";
        vm.serializeString(market, "label", "DTB/DTA");
        vm.serializeAddress(market, "tokenIn", SepoliaReuse.DTB);
        vm.serializeAddress(market, "tokenOut", SepoliaReuse.DTA);
        vm.serializeAddress(market, "solver", solver);
        vm.serializeAddress(market, "aquaVenue", aquaVenue);
        vm.serializeAddress(market, "uniswapV4Venue", uniVenue);
        vm.serializeAddress(market, "aquaOracle", SepoliaReuse.AQUA_ORACLE);
        vm.serializeBytes32(market, "aquaStrategyId", SepoliaReuse.AQUA_STRATEGY_ID);
        vm.serializeAddress(market, "uniOracle", SepoliaReuse.UNI_ORACLE);
        vm.serializeAddress(market, "extruction", SepoliaReuse.AQUA_EXTRUCTION);
        vm.serializeAddress(market, "hook", hook);
        vm.serializeBytes32(market, "poolId", PoolId.unwrap(poolKey.toId()));
        string memory marketJson = vm.serializeBytes32(market, "uniStrategyId", SepoliaReuse.UNI_STRATEGY_ID);

        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "network", "sepolia");
        vm.serializeAddress(root, "deployer", deployer);
        vm.serializeUint(root, "deploymentBlock", block.number);
        string[] memory markets = new string[](1);
        markets[0] = marketJson;
        string memory finalJson = vm.serializeString(root, "markets", markets);

        vm.writeJson(finalJson, string(abi.encodePacked(vm.projectRoot(), "/deployments/11155111.json")));
    }
}
