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
import { MockERC20 } from "../../contracts/mocks/MockERC20.sol";
import { MockMarketStateProvider } from "../../contracts/mocks/MockMarketStateProvider.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @title UniswapMainnetForkTest
/// @notice Optional mainnet fork test (Part 5, Steps 21-22). Additive to, never a replacement for,
///         the deterministic local Anvil suite (`UniswapConditionalLiquidity.t.sol`,
///         `UniswapMarketShock.t.sol`, etc.), which remains the canonical, always-run test path.
///
/// @dev Behavior:
///        - `RPC_URL` unset -> every test in this file calls `vm.skip(true)` immediately and the
///          suite reports skipped, not failed. `forge test` (no args) never needs an RPC to pass.
///        - `RPC_URL` set -> forks mainnet (at `FORK_BLOCK` if set, else the latest block), verifies
///          the real PoolManager deployment exists at its documented address, then deploys our own
///          hook and pool against the fork and runs a real swap through it.
///
///      No credentials are hardcoded anywhere in this file; `RPC_URL` must be supplied by the
///      environment. To run this suite locally:
///        RPC_URL=https://your-mainnet-rpc forge test --match-path "test/fork/*"
///        RPC_URL=https://your-mainnet-rpc FORK_BLOCK=21000000 forge test --match-path "test/fork/*"
contract UniswapMainnetForkTest is Test {
    using PoolIdLibrary for PoolKey;

    /// @dev Verified against the official Uniswap developer documentation
    ///      (developers.uniswap.org/docs/protocols/v4/deployments), not inferred.
    address internal constant MAINNET_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

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

    address internal maker = makeAddr("forkMaker");
    address internal trader = makeAddr("forkTrader");
    address internal owner = makeAddr("forkOwner");

    uint256 internal constant BASE_LIQUIDITY = 100 ether;

    modifier onlyWithRpc() {
        if (bytes(vm.envOr("RPC_URL", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _fork() private {
        string memory rpcUrl = vm.envString("RPC_URL");
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            vm.createSelectFork(rpcUrl);
        } else {
            vm.createSelectFork(rpcUrl, forkBlock);
        }
    }

    /// @notice Confirms the real PoolManager is actually deployed at its documented mainnet
    ///         address on whatever block the fork lands on.
    function test_Fork_PoolManagerIsDeployedAtDocumentedAddress() public onlyWithRpc {
        _fork();
        assertGt(MAINNET_POOL_MANAGER.code.length, 0, "no code at the documented PoolManager address");
    }

    /// @notice Deploys our own hook and a fresh pool against the forked mainnet PoolManager, and
    ///         drives the same NORMAL -> DEFENSIVE -> real-token-swap scenario the local suite
    ///         proves, this time against production Uniswap v4 infrastructure.
    function test_Fork_HookEnforcesEffectiveLiquidityAgainstRealPoolManager() public onlyWithRpc {
        _fork();
        manager = IPoolManager(MAINNET_POOL_MANAGER);

        _deployProtocolStack();
        _deployHookAndPool();
        _registerStrategyAndSeedLiquidity();

        // NORMAL: a swap within the base liquidity succeeds.
        BalanceDelta normalDelta = _swap(10 ether);
        assertGt(uint128(normalDelta.amount1()), 0);

        // SHOCK: volatility spikes; DEFENSIVE cuts effective liquidity to 25%.
        oracle.setVolatility(strategyId, 6300, 4000e18);
        _swap(1 ether); // commits the transition
        assertEq(hook.getEffectiveLiquidity(poolId), 25 ether);

        // A 50 ETH-equivalent swap now exceeds the cap and must revert.
        vm.prank(trader);
        vm.expectRevert();
        swapRouter.swap(
            poolKey,
            SwapParams({ zeroForOne: true, amountSpecified: -50 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
    }

    /* ------------------------------------------------------------------ setup helpers */

    function _deployProtocolStack() private {
        registry = new ConditionalLiquidityRegistry(new StrategyValidator(), owner);
        oracle = new MockMarketStateProvider();
        engine = new ConditionalLiquidityEngine(registry, oracle);
        vm.prank(owner);
        registry.setStateAuthority(address(engine));
    }

    function _deployHookAndPool() private {
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);

        MockERC20 a = new MockERC20("Fork Token X", "FKX", 18);
        MockERC20 b = new MockERC20("Fork Token Y", "FKY", 18);
        (address lo, address hi) = StrategyLib.sortTokens(address(a), address(b));
        tokenX = MockERC20(lo);
        tokenY = MockERC20(hi);

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
        bytes memory constructorArgs = abi.encode(manager, engine, registry);
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), flags, type(ConditionalLiquidityHook).creationCode, constructorArgs);
        hook = new ConditionalLiquidityHook{ salt: salt }(manager, engine, registry);
        require(address(hook) == predicted, "hook address mismatch");

        poolKey = PoolKey({
            currency0: Currency.wrap(address(tokenX)),
            currency1: Currency.wrap(address(tokenY)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        poolId = poolKey.toId();
        manager.initialize(poolKey, uint160(1) << 96);
    }

    function _registerStrategyAndSeedLiquidity() private {
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = address(tokenX);
        args.tokenB = address(tokenY);
        args.useAquaInsteadOfSignature = true;
        args.program = hex"5000";
        ISwapVM.Order memory order = MakerTraitsLib.build(args);

        vm.prank(maker);
        strategyId = registry.registerStrategy(
            order, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );
        vm.prank(maker);
        hook.registerPoolStrategy(poolKey, strategyId, BASE_LIQUIDITY, BASE_LIQUIDITY);

        tokenX.mint(maker, type(uint128).max);
        tokenY.mint(maker, type(uint128).max);
        vm.startPrank(maker);
        tokenX.approve(address(lpRouter), type(uint256).max);
        tokenY.approve(address(lpRouter), type(uint256).max);
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

        tokenX.mint(trader, 1000 ether);
        vm.prank(trader);
        tokenX.approve(address(swapRouter), type(uint256).max);

        oracle.setVolatility(strategyId, 2000, 4000e18);
    }

    function _swap(uint256 amountIn) private returns (BalanceDelta delta) {
        vm.prank(trader);
        delta = swapRouter.swap(
            poolKey,
            SwapParams({ zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1 }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
    }
}
