// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { LPFeeLibrary } from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { ModifyLiquidityParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import { HookMiner } from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import { ConditionalLiquidityRegistry } from "../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../contracts/core/StrategyValidator.sol";
import { ConditionalLiquidityEngine } from "../contracts/engine/ConditionalLiquidityEngine.sol";
import { ConditionalLiquidityHook } from "../contracts/uniswap/ConditionalLiquidityHook.sol";
import { MockERC20 } from "../contracts/mocks/MockERC20.sol";
import { MockMarketStateProvider } from "../contracts/mocks/MockMarketStateProvider.sol";
import { StrategyLib } from "../contracts/libraries/StrategyLib.sol";
import { StrategyFixtures } from "../test/utils/StrategyFixtures.sol";

/// @notice Deploys the full Uniswap v4 conditional-liquidity stack: PoolManager, a CREATE2-mined
///         hook, a test pool with the volatility-shield strategy bound to it, and seeded liquidity.
/// @dev Mirrors `test/utils/UniswapExecutionFixture.sol` exactly, but as a broadcastable script.
///      PoolManager is deployed via `vm.deployCode` for the same reason the test fixture uses it:
///      `PoolManager.sol` exact-pins solc 0.8.26, incompatible with this project's 0.8.30 files in
///      one compiler invocation (see `test/utils/deployers/PoolManagerImport.sol`).
contract DeployUniswapHook is Script {
    using PoolIdLibrary for PoolKey;

    /// @dev The canonical deterministic CREATE2 deployer, present on essentially every EVM chain
    ///      (including a modern local Anvil by default) and the address Foundry's script
    ///      broadcaster routes salted `new X{salt: ...}(...)` deployments through. HookMiner's own
    ///      NatSpec names this exact address for script (as opposed to test) contexts.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    uint256 internal constant BASE_LIQUIDITY = 100 ether;
    uint256 internal constant SEEDED_LIQUIDITY = 1_000_000 ether;
    int24 internal constant TICK_SPACING = 60;

    function run()
        external
        returns (IPoolManager manager, ConditionalLiquidityHook hook, PoolId poolId, bytes32 strategyId, address token0, address token1)
    {
        address owner = vm.envOr("OWNER", msg.sender);
        address maker = vm.envOr("MAKER", msg.sender);

        vm.startBroadcast();

        manager = IPoolManager(vm.deployCode("PoolManager.sol:PoolManager", abi.encode(owner)));

        MockERC20 a = new MockERC20("Demo Token A", "DTA", 18);
        MockERC20 b = new MockERC20("Demo Token B", "DTB", 18);
        (address lo, address hi) = StrategyLib.sortTokens(address(a), address(b));
        token0 = lo;
        token1 = hi;

        StrategyValidator validator = new StrategyValidator();
        ConditionalLiquidityRegistry registry = new ConditionalLiquidityRegistry(validator, owner);
        MockMarketStateProvider oracle = new MockMarketStateProvider();
        ConditionalLiquidityEngine engine = new ConditionalLiquidityEngine(registry, oracle);
        registry.setStateAuthority(address(engine));

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(manager, engine, registry);
        (address predicted, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, flags, type(ConditionalLiquidityHook).creationCode, constructorArgs);

        hook = new ConditionalLiquidityHook{ salt: salt }(manager, engine, registry);
        require(address(hook) == predicted, "hook address mismatch");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(token0),
            currency1: Currency.wrap(token1),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();
        manager.initialize(key, uint160(1) << 96);

        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = token0;
        args.tokenB = token1;
        args.useAquaInsteadOfSignature = true;
        args.program = hex"5000"; // identity vehicle only; never executed via SwapVM in this script
        ISwapVM.Order memory order = MakerTraitsLib.build(args);

        strategyId = registry.registerStrategy(
            order, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );
        hook.registerPoolStrategy(key, strategyId, BASE_LIQUIDITY, BASE_LIQUIDITY);

        MockERC20(token0).mint(maker, type(uint128).max);
        MockERC20(token1).mint(maker, type(uint128).max);
        PoolModifyLiquidityTest lpRouter = new PoolModifyLiquidityTest(manager);
        MockERC20(token0).approve(address(lpRouter), type(uint256).max);
        MockERC20(token1).approve(address(lpRouter), type(uint256).max);
        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(TICK_SPACING),
                tickUpper: TickMath.maxUsableTick(TICK_SPACING),
                liquidityDelta: int256(SEEDED_LIQUIDITY),
                salt: bytes32(0)
            }),
            ""
        );

        oracle.setVolatility(strategyId, 2000, 4000e18);

        vm.stopBroadcast();

        console.log("PoolManager: ", address(manager));
        console.log("Hook:        ", address(hook));
        console.log("PoolId:");
        console.logBytes32(PoolId.unwrap(poolId));
        console.log("StrategyId:");
        console.logBytes32(strategyId);
        console.log("Token0:      ", token0);
        console.log("Token1:      ", token1);
        console.log("Registry:    ", address(registry));
        console.log("Engine:      ", address(engine));
        console.log("Oracle:      ", address(oracle));
        console.log("Maker:       ", maker);
        console.log("Owner:       ", owner);
    }
}
