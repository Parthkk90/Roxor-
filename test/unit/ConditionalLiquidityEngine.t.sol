// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { ConditionalLiquidityEngine } from "../../contracts/engine/ConditionalLiquidityEngine.sol";
import { IConditionalLiquidityEngine } from "../../contracts/engine/interfaces/IConditionalLiquidityEngine.sol";
import { ConditionalLiquidityRegistry } from "../../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../../contracts/core/StrategyValidator.sol";
import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { MockMarketStateProvider } from "../../contracts/mocks/MockMarketStateProvider.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";
import { OrderFixture } from "../utils/OrderFixture.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

contract ConditionalLiquidityEngineTest is OrderFixture {
    ConditionalLiquidityRegistry internal registry;
    ConditionalLiquidityEngine internal engine;
    MockMarketStateProvider internal oracle;

    address internal owner = makeAddr("owner");
    address internal maker = makeAddr("maker");

    bytes32 internal id;

    /// @dev Explicit test clock. Do NOT write `vm.warp(block.timestamp + x)`: under `via_ir`
    ///      Solidity treats `block.timestamp` as constant within a call frame and common-subexpression
    ///      eliminates it across cheatcode boundaries, so chained warps can silently move time
    ///      backwards. Keeping the clock in storage sidesteps that entirely.
    uint256 internal clock;

    uint16 internal constant BASE_LIQ = 10_000;
    uint16 internal constant BASE_SPREAD = 20;

    function _advance(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
    }

    function setUp() public {
        _deployPair();
        clock = 1_700_000_000; // avoid timestamp 0 edge cases
        vm.warp(clock);

        registry = new ConditionalLiquidityRegistry(new StrategyValidator(), owner);
        oracle = new MockMarketStateProvider();
        engine = new ConditionalLiquidityEngine(registry, oracle);

        vm.prank(owner);
        registry.setStateAuthority(address(engine));

        ISwapVM.Order memory order = _buildOrder(maker);
        vm.prank(maker);
        id = registry.registerStrategy(order, BASE_LIQ, BASE_SPREAD, StrategyFixtures.volatilityShield());

        _setVol(2000); // calm start: 20%
    }

    function _setVol(uint256 volBps) internal {
        oracle.setVolatility(id, volBps, 4000e18);
    }

    function _mode() internal view returns (IStrategyTypes.StrategyMode) {
        return registry.getStrategyState(id).mode;
    }

    function _liq() internal view returns (uint16) {
        return registry.getStrategyState(id).liquidityBps;
    }

    function _spread() internal view returns (uint16) {
        return registry.getStrategyState(id).spreadBps;
    }

    /* ------------------------------------------------------------------ core transitions */

    function test_StartsNormalAtFullSize() public view {
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(_liq(), StrategyFixtures.NORMAL_LIQ);
        assertEq(_spread(), StrategyFixtures.NORMAL_SPREAD);
    }

    function test_CalmMarketDoesNotTransition() public {
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(_liq(), StrategyFixtures.NORMAL_LIQ);
    }

    /// @notice The headline scenario: a volatility shock cuts quoted liquidity to 25%.
    function test_ShockTransitionsToDefensiveAndCutsLiquidity() public {
        _setVol(6300); // 63%

        vm.expectEmit(true, false, false, true, address(engine));
        emit IConditionalLiquidityEngine.StateTransition(
            id, IStrategyTypes.StrategyMode.NORMAL, IStrategyTypes.StrategyMode.DEFENSIVE, block.timestamp, 6300
        );
        engine.poke(id);

        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
        assertEq(_liq(), StrategyFixtures.DEFENSIVE_LIQ, "liquidity must drop to 25%");
        assertEq(_spread(), StrategyFixtures.DEFENSIVE_SPREAD, "spread must widen to 90bps");
    }

    /// @notice Defensive posture persists while the shock lasts, even though the entry rule no
    ///         longer matches (mode is no longer NORMAL).
    function test_DefensivePersistsWhileVolatilityStaysHigh() public {
        _setVol(6300);
        engine.poke(id);

        for (uint256 i = 0; i < 5; i++) {
            _advance(5 minutes);
            engine.poke(id);
            assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
            assertEq(_liq(), StrategyFixtures.DEFENSIVE_LIQ);
        }
    }

    function test_FullShockAndRecoveryCycle() public {
        // Shock.
        _setVol(6300);
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));

        // Market calms, but the calm must be sustained before anything changes.
        _setVol(2400);
        engine.poke(id); // arms the sustained rule
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.DEFENSIVE), "must not leave on first calm sample");

        _advance(StrategyFixtures.CALM_PERIOD);
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.RECOVERY));
        assertEq(_liq(), StrategyFixtures.RECOVERY_LIQ, "liquidity partially restored to 50%");

        // Recovery completes on its timer.
        _advance(StrategyFixtures.RECOVERY_PERIOD);
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(_liq(), StrategyFixtures.NORMAL_LIQ, "liquidity fully restored");
    }

    function test_RelapseDuringRecoveryReturnsToDefensive() public {
        _setVol(6300);
        engine.poke(id);
        _setVol(2400);
        engine.poke(id);
        _advance(StrategyFixtures.CALM_PERIOD);
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.RECOVERY));

        // A fresh shock must beat the recovery timer.
        _setVol(7000);
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
        assertEq(_liq(), StrategyFixtures.DEFENSIVE_LIQ);
    }

    /* ------------------------------------------------------------------ hysteresis */

    /// @notice The property hysteresis exists to provide: oscillating around one threshold must
    ///         not make the strategy flap between modes.
    function test_HysteresisPreventsFlapping() public {
        uint256[6] memory series = [uint256(4900), 5100, 4900, 3100, 2900, 4000];
        uint8[6] memory expected = [
            uint8(IStrategyTypes.StrategyMode.NORMAL), // 49% - below entry threshold
            uint8(IStrategyTypes.StrategyMode.DEFENSIVE), // 51% - crosses entry
            uint8(IStrategyTypes.StrategyMode.DEFENSIVE), // 49% - above exit threshold, holds
            uint8(IStrategyTypes.StrategyMode.DEFENSIVE), // 31% - still above exit threshold
            uint8(IStrategyTypes.StrategyMode.DEFENSIVE), // 29% - below exit, but not yet sustained
            uint8(IStrategyTypes.StrategyMode.DEFENSIVE) //  40% - calm broken, stays defensive
        ];

        for (uint256 i = 0; i < series.length; i++) {
            _setVol(series[i]);
            engine.poke(id);
            assertEq(uint8(_mode()), expected[i], "mode at sample");
            _advance(1 minutes);
        }

        // Only a *sustained* calm below 30% actually exits DEFENSIVE.
        _setVol(2900);
        engine.poke(id);
        _advance(StrategyFixtures.CALM_PERIOD);
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.RECOVERY));
    }

    /// @notice Interrupting the calm window restarts the countdown rather than banking progress.
    function test_InterruptedCalmRestartsCountdown() public {
        _setVol(6300);
        engine.poke(id);

        _setVol(2400);
        engine.poke(id); // arm

        _advance(9 minutes);
        _setVol(4000); // calm broken with 1 minute to go
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));

        _advance(2 minutes);
        _setVol(2400); // calm resumes; clock restarts from here
        engine.poke(id);
        _advance(9 minutes);
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.DEFENSIVE), "9 min is not enough after restart");

        _advance(1 minutes);
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.RECOVERY));
    }

    /* ------------------------------------------------------------------ boundaries */

    function test_ExactEntryThresholdTransitions() public {
        _setVol(StrategyFixtures.ENTER_DEFENSIVE_BPS); // exactly 50%, rule uses GTE
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
    }

    function test_JustBelowEntryThresholdDoesNot() public {
        _setVol(StrategyFixtures.ENTER_DEFENSIVE_BPS - 1);
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.NORMAL));
    }

    function test_ExactExitThresholdDoesNotLeave() public {
        _setVol(6300);
        engine.poke(id);
        _setVol(StrategyFixtures.LEAVE_DEFENSIVE_BPS); // exactly 30%, rule uses LT
        engine.poke(id);
        _advance(StrategyFixtures.CALM_PERIOD);
        engine.poke(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.DEFENSIVE), "30% is not < 30%");
    }

    /* ------------------------------------------------------------------ liquidity sizing */

    function test_EffectiveLiquidityTracksMode() public {
        uint256 balance = 100 ether;
        assertEq(engine.effectiveLiquidity(id, balance), 100 ether);

        _setVol(6300);
        engine.poke(id);
        assertEq(engine.effectiveLiquidity(id, balance), 25 ether, "25% of the maker balance");
    }

    function test_InactiveStrategyOffersNoLiquidity() public {
        vm.prank(maker);
        registry.deactivateStrategy(id);
        assertEq(engine.effectiveLiquidity(id, 100 ether), 0);

        vm.expectRevert(abi.encodeWithSelector(IConditionalLiquidityEngine.StrategyNotActive.selector, id));
        engine.poke(id);
    }

    /* ------------------------------------------------------------------ purity / preview */

    /// @notice `preview` must return exactly what `poke` commits. This is what keeps SwapVM's
    ///         static `quote()` path in agreement with its mutating `swap()` path.
    function test_PreviewMatchesPoke() public {
        _setVol(6300);
        (IStrategyTypes.RuntimeState memory previewed,) = engine.preview(id);
        engine.poke(id);
        IStrategyTypes.RuntimeState memory committed = registry.getStrategyState(id);

        assertEq(uint8(previewed.mode), uint8(committed.mode));
        assertEq(previewed.liquidityBps, committed.liquidityBps);
        assertEq(previewed.spreadBps, committed.spreadBps);
        assertEq(previewed.transitionCount, committed.transitionCount);
    }

    function test_PreviewDoesNotMutate() public {
        _setVol(6300);
        engine.preview(id);
        assertEq(uint8(_mode()), uint8(IStrategyTypes.StrategyMode.NORMAL), "preview must not commit");
    }

    /// @notice Repeated pokes in the same block are idempotent: no double transition.
    function test_PokeIsIdempotentWithinABlock() public {
        _setVol(6300);
        engine.poke(id);
        uint64 transitions = registry.getStrategyState(id).transitionCount;

        engine.poke(id);
        engine.poke(id);
        assertEq(registry.getStrategyState(id).transitionCount, transitions, "no extra transitions");
    }

    /* ------------------------------------------------------------------ fuzz / invariants */

    /// @notice No market snapshot, at any time, can push a strategy outside its bounds.
    function testFuzz_BoundsAlwaysHold(uint256 vol, uint256 price, uint32 skip) public {
        vol = bound(vol, 0, 1_000_000);
        price = bound(price, 1, 1e30);
        _advance(bound(skip, 0, 365 days));

        oracle.setVolatility(id, vol, price);
        engine.poke(id);

        IStrategyTypes.RuntimeState memory s = registry.getStrategyState(id);
        assertLe(s.liquidityBps, StrategyLib.MAX_LIQUIDITY_BPS, "liquidity never exceeds 100%");
        assertLe(s.spreadBps, StrategyLib.MAX_SPREAD_BPS, "spread never exceeds cap");
        assertLe(uint8(s.mode), uint8(IStrategyTypes.StrategyMode.RECOVERY), "mode always valid");
    }

    /// @notice A single evaluation may change mode at most once, whatever the market does.
    function testFuzz_AtMostOneTransitionPerPoke(uint256 vol, uint32 skip) public {
        vol = bound(vol, 0, 20_000);
        _advance(bound(skip, 0, 30 days));
        oracle.setVolatility(id, vol, 4000e18);

        uint64 before = registry.getStrategyState(id).transitionCount;
        engine.poke(id);
        uint64 afterCount = registry.getStrategyState(id).transitionCount;

        assertLe(afterCount - before, 1, "at most one transition per execution");
    }

    /// @notice Evaluation is a pure function of (state, market, time): same inputs, same result.
    function testFuzz_EvaluationIsDeterministic(uint256 vol) public {
        vol = bound(vol, 0, 20_000);
        oracle.setVolatility(id, vol, 4000e18);

        (IStrategyTypes.RuntimeState memory a,) = engine.preview(id);
        (IStrategyTypes.RuntimeState memory b,) = engine.preview(id);

        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)));
    }
}
