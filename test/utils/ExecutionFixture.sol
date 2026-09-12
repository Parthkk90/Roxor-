// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { ConditionalLiquidityRegistry } from "../../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../../contracts/core/StrategyValidator.sol";
import { ConditionalLiquidityEngine } from "../../contracts/engine/ConditionalLiquidityEngine.sol";
import { ConditionalLiquidityExtruction } from "../../contracts/swapvm/ConditionalLiquidityExtruction.sol";
import { ConditionalLiquidityProgramLib } from "../../contracts/swapvm/ConditionalLiquidityProgramLib.sol";
import { MockERC20 } from "../../contracts/mocks/MockERC20.sol";
import { MockWETH } from "../../contracts/mocks/MockWETH.sol";
import { MockMarketStateProvider } from "../../contracts/mocks/MockMarketStateProvider.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";
import { StrategyFixtures } from "./StrategyFixtures.sol";

/// @notice Deploys the real 1inch Aqua + SwapVM stack alongside the full Conditional Liquidity
///         Functions protocol, and ships one live strategy backed by real ERC-20 balances.
///
/// @dev Nothing here is mocked at the settlement layer: Aqua and AquaSwapVMRouter are the actual
///      contracts from the pinned 1inch aqua / swap-vm packages. Only the tokens, WETH and the
///      price oracle are test doubles, because those are things a maker or an external oracle
///      would supply on a real deployment.
abstract contract ExecutionFixture is Test {
    Aqua internal aqua;
    MockWETH internal weth;
    AquaSwapVMRouter internal router;

    ConditionalLiquidityRegistry internal registry;
    ConditionalLiquidityEngine internal engine;
    ConditionalLiquidityExtruction internal extruction;
    MockMarketStateProvider internal oracle;

    MockERC20 internal tokenA;
    MockERC20 internal tokenB;

    address internal protocolOwner = makeAddr("protocolOwner");
    address internal maker;
    uint256 internal makerKey;
    address internal taker;
    uint256 internal takerKey;

    bytes32 internal strategyId;
    ISwapVM.Order internal order;

    /// @dev 100 ETH-equivalent, matching the spec's narrative numbers exactly (100 -> 25 -> 50 -> 100).
    uint256 internal constant MAKER_BALANCE_A = 100 ether;
    uint256 internal constant MAKER_BALANCE_B = 500_000e6; // USDC-like, 6 decimals

    function _setUpExecution() internal {
        (maker, makerKey) = makeAddrAndKey("maker");
        (taker, takerKey) = makeAddrAndKey("taker");

        _deployTokens();
        _deployProtocolStack();
        _shipStrategy();
    }

    function _deployTokens() private {
        MockERC20 first = new MockERC20("Wrapped Ether", "WETH-LIKE", 18);
        MockERC20 second = new MockERC20("USD Coin", "USDC", 6);
        (address a, address b) = StrategyLib.sortTokens(address(first), address(second));
        tokenA = MockERC20(a);
        tokenB = MockERC20(b);
        weth = new MockWETH();
    }

    function _deployProtocolStack() private {
        aqua = new Aqua();
        router = new AquaSwapVMRouter(address(aqua), address(weth), protocolOwner, "ConditionalLiquidityRouter", "1");

        registry = new ConditionalLiquidityRegistry(new StrategyValidator(), protocolOwner);
        oracle = new MockMarketStateProvider();
        engine = new ConditionalLiquidityEngine(registry, oracle);
        extruction = new ConditionalLiquidityExtruction(engine, registry);

        vm.prank(protocolOwner);
        registry.setStateAuthority(address(engine));
    }

    /// @dev Mirrors 1inch's own `AquaStrategyBuilders.shipStrategy`: the maker approves Aqua to
    ///      move both tokens from their wallet (Aqua never custodies funds, it only tracks
    ///      allowances), then ships the strategy so those allowances become live.
    function _shipStrategy() private {
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = address(tokenA);
        args.tokenB = address(tokenB);
        args.useAquaInsteadOfSignature = true;
        args.program = ConditionalLiquidityProgramLib.build(address(extruction));
        order = MakerTraitsLib.build(args);

        vm.prank(maker);
        strategyId = registry.registerStrategy(
            order, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );

        tokenA.mint(maker, MAKER_BALANCE_A);
        tokenB.mint(maker, MAKER_BALANCE_B);

        vm.startPrank(maker);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = MAKER_BALANCE_A;
        amounts[1] = MAKER_BALANCE_B;

        bytes32 shippedHash = aqua.ship(address(router), abi.encode(order), tokens, amounts);
        vm.stopPrank();

        require(shippedHash == strategyId, "aqua strategyHash must equal registry strategyId");

        // A calm starting market: 20% volatility, $4000 reference price.
        oracle.setVolatility(strategyId, 2000, 4000e18);
    }

    /// @notice Fund `who` with both tokens and approve the router to pull from them.
    function _fundTaker(address who, uint256 amountA, uint256 amountB) internal {
        tokenA.mint(who, amountA);
        tokenB.mint(who, amountB);
        vm.startPrank(who);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice The current effective liquidity cap for an A->B trade: the maker's live Aqua
    ///         balance of tokenA (which grows as takers push tokenA in on prior trades) times the
    ///         strategy's current liquidity multiplier. Tests must read this dynamically rather
    ///         than assume a fixed cap, because every successful trade changes the maker's balance.
    function _currentCapA() internal view returns (uint256) {
        (uint256 balanceA,) = aqua.safeBalances(maker, address(router), strategyId, address(tokenA), address(tokenB));
        uint16 liquidityBps = registry.getStrategyState(strategyId).liquidityBps;
        return (balanceA * liquidityBps) / StrategyLib.MAX_LIQUIDITY_BPS;
    }

    /// @notice Execute an exact-in swap from tokenA to tokenB as `taker`.
    function _swapAToB(address who, uint256 amountIn, uint256 minOut) internal returns (uint256 amountInUsed, uint256 amountOut) {
        TakerTraitsLib.Args memory targs;
        targs.taker = who;
        targs.isExactIn = true;
        targs.isFirstTransferFromTaker = true;
        targs.useTransferFromAndAquaPush = true;
        targs.isAToB = true;
        targs.threshold = abi.encodePacked(minOut);

        bytes memory takerData = TakerTraitsLib.build(targs);

        vm.prank(who);
        (amountInUsed, amountOut,) = router.swap(order, amountIn, takerData);
    }
}
