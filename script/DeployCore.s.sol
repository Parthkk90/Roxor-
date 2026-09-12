// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { ConditionalLiquidityRegistry } from "../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../contracts/core/StrategyValidator.sol";
import { MockMarketStateProvider } from "../contracts/mocks/MockMarketStateProvider.sol";

/// @notice Deploys the Part 1 core: validator, registry and a market-state provider.
/// @dev The mock provider is deployed only when `USE_MOCK_ORACLE` is set, so this script is
///      usable both on a local Anvil node and against a real network.
contract DeployCore is Script {
    function run() external returns (StrategyValidator validator, ConditionalLiquidityRegistry registry) {
        address owner = vm.envOr("OWNER", msg.sender);

        vm.startBroadcast();

        validator = new StrategyValidator();
        registry = new ConditionalLiquidityRegistry(validator, owner);

        if (vm.envOr("USE_MOCK_ORACLE", false)) {
            MockMarketStateProvider provider = new MockMarketStateProvider();
            console.log("MockMarketStateProvider:", address(provider));
        }

        vm.stopBroadcast();

        console.log("StrategyValidator:            ", address(validator));
        console.log("ConditionalLiquidityRegistry: ", address(registry));
        console.log("owner:                        ", owner);
    }
}
