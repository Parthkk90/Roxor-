// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { ConditionalLiquidityRegistry } from "../../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../../contracts/core/StrategyValidator.sol";
import { IConditionalLiquidityRegistry } from "../../contracts/core/interfaces/IConditionalLiquidityRegistry.sol";
import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";
import { OrderFixture } from "../utils/OrderFixture.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

contract ConditionalLiquidityRegistryTest is OrderFixture {
    ConditionalLiquidityRegistry internal registry;
    StrategyValidator internal validator;

    address internal owner = makeAddr("owner");
    address internal maker = makeAddr("maker");
    address internal engine = makeAddr("engine");
    address internal intruder = makeAddr("intruder");

    uint16 internal constant BASE_LIQ = 10_000;
    uint16 internal constant BASE_SPREAD = 20;

    function setUp() public {
        _deployPair();
        validator = new StrategyValidator();
        registry = new ConditionalLiquidityRegistry(validator, owner);
        vm.prank(owner);
        registry.setStateAuthority(engine);
    }

    function _register() internal returns (bytes32 id, ISwapVM.Order memory order) {
        order = _buildOrder(maker);
        vm.prank(maker);
        id = registry.registerStrategy(order, BASE_LIQ, BASE_SPREAD, StrategyFixtures.volatilityShield());
    }

    /* ------------------------------------------------------------------ registration */

    function test_RegisterValidStrategy() public {
        (bytes32 id, ISwapVM.Order memory order) = _register();

        assertTrue(registry.isRegistered(id), "should be registered");
        assertTrue(registry.isActive(id), "should start active");

        IStrategyTypes.Strategy memory s = registry.getStrategy(id);
        assertEq(s.maker, maker);
        assertEq(s.tokenA, address(tokenA));
        assertEq(s.tokenB, address(tokenB));
        assertEq(s.baseLiquidityBps, BASE_LIQ);
        assertEq(s.baseSpreadBps, BASE_SPREAD);
        assertEq(s.createdAt, uint64(block.timestamp));

        // The registry key must be the value SwapVM/Aqua will independently derive.
        assertEq(id, keccak256(abi.encode(order)), "id must equal keccak256(abi.encode(order))");
    }

    /// @notice The registry key must match the identifier Aqua and SwapVM derive for the same order.
    /// @dev This is the linchpin of the whole design: it is what lets an Extruction target find our
    ///      state from `ctx.query.orderHash` alone.
    function test_StrategyIdMatchesAquaAndSwapVmDerivation() public view {
        ISwapVM.Order memory order = _buildOrder(maker);

        // Aqua: `ship(app, strategy, ...)` computes keccak256(strategy); makers ship abi.encode(order).
        bytes memory shippedStrategy = abi.encode(order);
        bytes32 aquaStrategyHash = keccak256(shippedStrategy);

        // SwapVM: `hash(order)` on its Aqua branch computes keccak256(abi.encode(order)).
        bytes32 swapVmOrderHash = keccak256(abi.encode(order));

        assertEq(aquaStrategyHash, swapVmOrderHash, "Aqua and SwapVM must agree");
        assertEq(StrategyLib.strategyIdMemory(order), aquaStrategyHash, "registry must agree too");
    }

    function test_StrategyHashIsDeterministic() public view {
        ISwapVM.Order memory a = _buildOrder(maker);
        ISwapVM.Order memory b = _buildOrder(maker);
        assertEq(StrategyLib.strategyIdMemory(a), StrategyLib.strategyIdMemory(b));
    }

    function test_StrategyHashChangesWithProgram() public view {
        ISwapVM.Order memory a = _buildOrder(maker, _defaultProgram(uint64(1)));
        ISwapVM.Order memory b = _buildOrder(maker, _defaultProgram(uint64(2)));
        assertTrue(StrategyLib.strategyIdMemory(a) != StrategyLib.strategyIdMemory(b));
    }

    function test_RevertWhen_DuplicateStrategy() public {
        (bytes32 id, ISwapVM.Order memory order) = _register();
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(IConditionalLiquidityRegistry.StrategyAlreadyRegistered.selector, id));
        registry.registerStrategy(order, BASE_LIQ, BASE_SPREAD, StrategyFixtures.volatilityShield());
    }

    function test_RevertWhen_RegisteringForAnotherMaker() public {
        ISwapVM.Order memory order = _buildOrder(maker);
        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(IConditionalLiquidityRegistry.MakerMismatch.selector, maker, intruder));
        registry.registerStrategy(order, BASE_LIQ, BASE_SPREAD, StrategyFixtures.volatilityShield());
    }

    /* ------------------------------------------------------------------ lifecycle */

    function test_DeactivateAndActivate() public {
        (bytes32 id,) = _register();

        vm.prank(maker);
        registry.deactivateStrategy(id);
        assertFalse(registry.isActive(id));

        vm.prank(maker);
        registry.activateStrategy(id);
        assertTrue(registry.isActive(id));
    }

    function test_RevertWhen_NonMakerDeactivates() public {
        (bytes32 id,) = _register();
        vm.prank(intruder);
        vm.expectRevert(abi.encodeWithSelector(IConditionalLiquidityRegistry.NotStrategyMaker.selector, id, intruder));
        registry.deactivateStrategy(id);
    }

    function test_RevertWhen_ReadingUnknownStrategy() public {
        bytes32 ghost = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(IConditionalLiquidityRegistry.StrategyNotRegistered.selector, ghost));
        registry.getStrategy(ghost);
    }

    /* ------------------------------------------------------------------ state authority */

    function test_InitialRuntimeStateMatchesBase() public {
        (bytes32 id,) = _register();
        IStrategyTypes.RuntimeState memory st = registry.getStrategyState(id);
        assertEq(uint8(st.mode), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(st.liquidityBps, BASE_LIQ);
        assertEq(st.spreadBps, BASE_SPREAD);
        assertEq(st.transitionCount, 0);
    }

    function test_EngineCanCommitState() public {
        (bytes32 id,) = _register();

        IStrategyTypes.RuntimeState memory next = registry.getStrategyState(id);
        next.mode = IStrategyTypes.StrategyMode.DEFENSIVE;
        next.liquidityBps = 2500;
        next.spreadBps = 90;

        vm.expectEmit(true, false, false, true, address(registry));
        emit IConditionalLiquidityRegistry.StrategyStateChanged(
            id, IStrategyTypes.StrategyMode.NORMAL, IStrategyTypes.StrategyMode.DEFENSIVE, 2500, 90
        );
        vm.prank(engine);
        registry.commitState(id, next);

        IStrategyTypes.RuntimeState memory st = registry.getStrategyState(id);
        assertEq(uint8(st.mode), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
        assertEq(st.liquidityBps, 2500);
    }

    /// @notice No path exists for a maker, taker or stranger to write runtime state directly.
    function test_RevertWhen_NonAuthorityCommitsState() public {
        (bytes32 id,) = _register();
        IStrategyTypes.RuntimeState memory next = registry.getStrategyState(id);
        next.liquidityBps = 10_000;

        address[3] memory outsiders = [maker, intruder, owner];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(IConditionalLiquidityRegistry.NotStateAuthority.selector, outsiders[i]));
            registry.commitState(id, next);
        }
    }

    function test_RevertWhen_NonOwnerSetsStateAuthority() public {
        vm.prank(intruder);
        vm.expectRevert();
        registry.setStateAuthority(intruder);
    }
}
