// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";

import { ConditionalLiquidityRegistry } from "../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../contracts/core/StrategyValidator.sol";
import { ConditionalLiquidityEngine } from "../contracts/engine/ConditionalLiquidityEngine.sol";
import { ConditionalLiquidityExtruction } from "../contracts/swapvm/ConditionalLiquidityExtruction.sol";
import { MockWETH } from "../contracts/mocks/MockWETH.sol";
import { MockMarketStateProvider } from "../contracts/mocks/MockMarketStateProvider.sol";

/// @notice Deploys the full Part 4 execution stack: Aqua, AquaSwapVMRouter, and the
///         Conditional Liquidity Functions protocol wired to it via {ConditionalLiquidityExtruction}.
/// @dev Aqua and AquaSwapVMRouter are the real 1inch contracts (pinned versions), not mocks. Only
///      WETH and the market-state oracle are test doubles here, matching `ExecutionFixture` in the
///      test suite.
contract DeploySwapVM is Script {
    function run()
        external
        returns (
            Aqua aqua,
            AquaSwapVMRouter router,
            StrategyValidator validator,
            ConditionalLiquidityRegistry registry,
            ConditionalLiquidityEngine engine,
            ConditionalLiquidityExtruction extruction
        )
    {
        address owner = vm.envOr("OWNER", msg.sender);

        vm.startBroadcast();

        aqua = new Aqua();
        MockWETH weth = new MockWETH();
        router = new AquaSwapVMRouter(address(aqua), address(weth), owner, "ConditionalLiquidityRouter", "1");

        validator = new StrategyValidator();
        registry = new ConditionalLiquidityRegistry(validator, owner);

        MockMarketStateProvider oracle = new MockMarketStateProvider();
        engine = new ConditionalLiquidityEngine(registry, oracle);
        extruction = new ConditionalLiquidityExtruction(engine, registry);

        registry.setStateAuthority(address(engine));

        vm.stopBroadcast();

        console.log("Aqua:                          ", address(aqua));
        console.log("MockWETH:                      ", address(weth));
        console.log("AquaSwapVMRouter:              ", address(router));
        console.log("StrategyValidator:             ", address(validator));
        console.log("ConditionalLiquidityRegistry:  ", address(registry));
        console.log("MockMarketStateProvider:       ", address(oracle));
        console.log("ConditionalLiquidityEngine:    ", address(engine));
        console.log("ConditionalLiquidityExtruction:", address(extruction));
        console.log("owner:                         ", owner);
    }
}
