// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { IConditionalLiquidityEngine } from "../contracts/engine/interfaces/IConditionalLiquidityEngine.sol";
import { IStrategyTypes } from "../contracts/core/interfaces/IStrategyTypes.sol";
import { MockMarketStateProvider } from "../contracts/mocks/MockMarketStateProvider.sol";
import { AquaVenue } from "../contracts/venues/AquaVenue.sol";
import { UniswapV4Venue } from "../contracts/venues/UniswapV4Venue.sol";
import { ConditionalLiquidityHook } from "../contracts/uniswap/ConditionalLiquidityHook.sol";

/// @notice Walks the DUSDC/DDAI market (index 2 of `DeploySolver`'s output, written to
///         `deployments/<chainId>.json`) to RECOVERY, through the real rule program: shock ->
///         DEFENSIVE -> sustained calm -> RECOVERY.
///
/// @dev Split into two scripts run around a real time advance, orchestrated by
///      `script/seed-markets.sh` — NOT within a single `run()`. `vm.rpc` genuinely mutates the
///      target node's clock, but it does so at *simulation* time; every broadcast-tagged call in a
///      script is deferred and sent as one batch only after the whole simulation finishes. A
///      `vm.rpc` time-jump placed between two broadcast regions of the same `run()` therefore lands
///      on-chain *before all of them*, not between them — the DEFENSIVE-entry poke and the
///      final poke would then still be only one block apart. Two separate `forge script`
///      invocations, each with its own simulation pass, avoid that: the wrapper shell script
///      genuinely advances chain time between them.
///
///      Against a real testnet, `seed-markets.sh`'s `evm_increaseTime`/`evm_mine` step is a no-op
///      (anvil-only RPC methods): the market sits in DEFENSIVE until 10 real minutes elapse, at
///      which point anyone calling `ConditionalLiquidityEngine.poke` (permissionless) moves it to
///      RECOVERY — `SeedRecoveryFinalize` still works there, it just cannot fast-forward the wait.
abstract contract SeedRecoveryBase is Script {
    uint256 internal constant DEFENSIVE_SHOCK_BPS = 6500;
    uint256 internal constant CALM_VOLATILITY_BPS = 2000;
    uint256 internal constant REFERENCE_PRICE = 4000e18;

    struct MarketRefs {
        MockMarketStateProvider aquaOracle;
        bytes32 aquaStrategyId;
        IConditionalLiquidityEngine aquaEngine;
        MockMarketStateProvider uniOracle;
        bytes32 uniStrategyId;
        IConditionalLiquidityEngine uniEngine;
    }

    function _loadMarket() internal returns (MarketRefs memory m) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));

        address aquaVenueAddr = vm.parseJsonAddress(json, ".markets[2].aquaVenue");
        m.aquaOracle = MockMarketStateProvider(vm.parseJsonAddress(json, ".markets[2].aquaOracle"));
        m.aquaStrategyId = vm.parseJsonBytes32(json, ".markets[2].aquaStrategyId");
        m.aquaEngine = AquaVenue(aquaVenueAddr).ENGINE();

        address uniVenueAddr = vm.parseJsonAddress(json, ".markets[2].uniswapV4Venue");
        m.uniOracle = MockMarketStateProvider(vm.parseJsonAddress(json, ".markets[2].uniOracle"));
        m.uniStrategyId = vm.parseJsonBytes32(json, ".markets[2].uniStrategyId");
        ConditionalLiquidityHook uniHook = ConditionalLiquidityHook(address(UniswapV4Venue(uniVenueAddr).HOOK()));
        m.uniEngine = uniHook.ENGINE();
    }

    function _logModes(MarketRefs memory m) internal view {
        (IStrategyTypes.RuntimeState memory aquaState,) = m.aquaEngine.preview(m.aquaStrategyId);
        (IStrategyTypes.RuntimeState memory uniState,) = m.uniEngine.preview(m.uniStrategyId);
        console.log("DUSDC/DDAI Aqua mode:", uint8(aquaState.mode));
        console.log("DUSDC/DDAI Uni mode: ", uint8(uniState.mode));
    }
}

/// @notice Phase 1: NORMAL -> DEFENSIVE (real shock+poke), then calm returns and arms the
///         sustained-calm rule (a poke while calm records the point to measure the wait from).
contract SeedRecoveryShock is SeedRecoveryBase {
    function run() external {
        MarketRefs memory m = _loadMarket();

        vm.startBroadcast();
        m.aquaOracle.setVolatility(m.aquaStrategyId, DEFENSIVE_SHOCK_BPS, REFERENCE_PRICE);
        m.uniOracle.setVolatility(m.uniStrategyId, DEFENSIVE_SHOCK_BPS, REFERENCE_PRICE);
        m.aquaEngine.poke(m.aquaStrategyId);
        m.uniEngine.poke(m.uniStrategyId);

        m.aquaOracle.setVolatility(m.aquaStrategyId, CALM_VOLATILITY_BPS, REFERENCE_PRICE);
        m.uniOracle.setVolatility(m.uniStrategyId, CALM_VOLATILITY_BPS, REFERENCE_PRICE);
        m.aquaEngine.poke(m.aquaStrategyId);
        m.uniEngine.poke(m.uniStrategyId);
        vm.stopBroadcast();

        _logModes(m);
    }
}

/// @notice Phase 2: run after `seed-markets.sh` has actually advanced chain time past
///         `StrategyFixtures.CALM_PERIOD`. This single poke fires the sustained-calm rule:
///         DEFENSIVE -> RECOVERY.
contract SeedRecoveryFinalize is SeedRecoveryBase {
    function run() external {
        MarketRefs memory m = _loadMarket();

        vm.startBroadcast();
        m.aquaEngine.poke(m.aquaStrategyId);
        m.uniEngine.poke(m.uniStrategyId);
        vm.stopBroadcast();

        _logModes(m);
    }
}
