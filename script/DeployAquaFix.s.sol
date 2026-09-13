// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import { ConditionalLiquidityRegistry } from "../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../contracts/core/StrategyValidator.sol";
import { ConditionalLiquidityEngine } from "../contracts/engine/ConditionalLiquidityEngine.sol";
import { ConditionalLiquidityExtruction } from "../contracts/swapvm/ConditionalLiquidityExtruction.sol";
import { ConditionalLiquidityProgramLib } from "../contracts/swapvm/ConditionalLiquidityProgramLib.sol";
import { MockERC20 } from "../contracts/mocks/MockERC20.sol";
import { MockWETH } from "../contracts/mocks/MockWETH.sol";
import { MockMarketStateProvider } from "../contracts/mocks/MockMarketStateProvider.sol";
import { StrategyFixtures } from "../test/utils/StrategyFixtures.sol";

import { Solver } from "../contracts/solver/Solver.sol";
import { ILiquidityVenue } from "../contracts/solver/interfaces/ILiquidityVenue.sol";
import { AquaVenue } from "../contracts/venues/AquaVenue.sol";
import { UniswapV4Venue } from "../contracts/venues/UniswapV4Venue.sol";

/// @notice Redeploys ONLY the Aqua/SwapVM half of the Part 6 stack plus a fresh {Solver}, reusing
///         the tokens and the already-deployed, already-working {UniswapV4Venue} from a prior
///         `DeploySolver` run.
///
/// @dev Exists because `AquaSwapVMRouter`'s compiled bytecode (26,827 bytes under this project's
///      default `optimizer_runs = 44_444_444`) exceeds Ethereum's EIP-170 24,576-byte contract-size
///      limit: on a real network the router deploys with EMPTY code, and everything built on it
///      (the strategy shipment, `AquaVenue`) is silently broken. Compile and run THIS script under
///      the lower-optimizer `ci` profile (`FOUNDRY_PROFILE=ci`), which brings the router down to
///      20,442 bytes - safely under the limit. `PoolManager.sol`'s unrelated 0.8.26 compile unit
///      must be skipped in that profile (it hits a known stack-too-deep failure below
///      `optimizer_runs = 44_444_444`, see `foundry.toml`'s comment) via
///      `--skip test/utils/deployers/PoolManagerImport.sol` - harmless here since this script never
///      touches PoolManager.
contract DeployAquaFix is Script {
    uint256 internal constant BASE_LIQUIDITY = 100 ether;
    uint256 internal constant AQUA_BASE_LIQUIDITY_B = 150 ether;

    function run(address tokenAAddr, address tokenBAddr, address existingUniVenue)
        external
        returns (AquaVenue aquaVenue, Solver solver, bytes32 aquaStrategyId)
    {
        vm.startBroadcast();

        address maker = vm.envOr("MAKER", msg.sender);
        address owner = vm.envOr("OWNER", msg.sender);

        MockERC20 tokenA = MockERC20(tokenAAddr);
        MockERC20 tokenB = MockERC20(tokenBAddr);

        MockWETH weth = new MockWETH();
        Aqua aqua = new Aqua();
        AquaSwapVMRouter router = new AquaSwapVMRouter(address(aqua), address(weth), owner, "SolverRouter", "1");

        ConditionalLiquidityRegistry registry = new ConditionalLiquidityRegistry(new StrategyValidator(), owner);
        MockMarketStateProvider oracle = new MockMarketStateProvider();
        ConditionalLiquidityEngine engine = new ConditionalLiquidityEngine(registry, oracle);
        ConditionalLiquidityExtruction extruction = new ConditionalLiquidityExtruction(engine, registry);
        registry.setStateAuthority(address(engine));

        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = address(tokenA);
        args.tokenB = address(tokenB);
        args.useAquaInsteadOfSignature = true;
        args.program = ConditionalLiquidityProgramLib.build(address(extruction));
        ISwapVM.Order memory order = MakerTraitsLib.build(args);

        aquaStrategyId = registry.registerStrategy(
            order, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );

        tokenA.mint(maker, BASE_LIQUIDITY);
        tokenB.mint(maker, AQUA_BASE_LIQUIDITY_B);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);

        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = BASE_LIQUIDITY;
        amounts[1] = AQUA_BASE_LIQUIDITY_B;
        bytes32 shippedHash = aqua.ship(address(router), abi.encode(order), tokens, amounts);
        require(shippedHash == aquaStrategyId, "aqua strategyHash must equal registry strategyId");

        oracle.setVolatility(aquaStrategyId, 2000, 4000e18);

        aquaVenue = new AquaVenue(aqua, router, engine, registry, aquaStrategyId, order);

        ILiquidityVenue[] memory venueList = new ILiquidityVenue[](2);
        venueList[0] = ILiquidityVenue(address(aquaVenue));
        venueList[1] = ILiquidityVenue(existingUniVenue);
        solver = new Solver(venueList);

        vm.stopBroadcast();

        console.log("Aqua:          ", address(aqua));
        console.log("AquaSwapVMRouter:", address(router));
        console.log("AquaVenue:     ", address(aquaVenue));
        console.log("New Solver:    ", address(solver));
        console.log("Aqua strategy:");
        console.logBytes32(aquaStrategyId);
    }
}
