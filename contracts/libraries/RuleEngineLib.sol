// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IStrategyTypes } from "../core/interfaces/IStrategyTypes.sol";
import { FixedPointMath } from "./FixedPointMath.sol";
import { RuleProgram } from "./RuleProgram.sol";
import { StrategyLib } from "./StrategyLib.sol";

/// @title RuleEngineLib
/// @notice The pure state-transition and liquidity function at the centre of the protocol.
///
/// @dev Implements the two equations the protocol is built around:
///
///        X_{t+1} = F(X_t, M_t)     {evaluate} -> next
///        L_t     = G(X_{t+1})      {evaluate} -> config
///
///      where X is {IStrategyTypes.RuntimeState}, M is {IStrategyTypes.MarketState} and L is
///      {IStrategyTypes.LiquidityConfig}.
///
/// @dev WHY THIS IS `pure`
///      SwapVM runs a strategy twice with different privileges: `quote()` executes in a static
///      context, `swap()` does not. If evaluation could read anything not passed in as an
///      argument, the quote and the swap could disagree and the taker's threshold check would be
///      meaningless. Keeping F and G pure makes quote/swap divergence structurally impossible:
///      identical inputs always produce identical outputs, and the only difference between the two
///      paths is whether the result is persisted.
///
/// @dev DETERMINISM RULES
///      1. Rules are tested in ascending index order.
///      2. The first rule whose conditions all hold is the only rule considered. At most one rule
///         fires per evaluation, so a strategy cannot chain transitions or loop.
///      3. Configuration is carried in state rather than recomputed from a base, so a strategy that
///         entered DEFENSIVE keeps its defensive liquidity on subsequent ticks even though the
///         transition rule no longer matches.
///      4. All results are clamped to protocol bounds after the rule's actions are applied.
library RuleEngineLib {
    using FixedPointMath for uint256;

    /// @notice Evaluate one tick of the strategy.
    /// @param current Runtime state before this tick.
    /// @param market Market conditions for this tick.
    /// @param program Compiled rule program, already structurally validated at registration.
    /// @param nowTs Timestamp to evaluate against; passed in rather than read so the function
    ///        stays pure and the Python reference model can reproduce it exactly.
    /// @return next Runtime state after this tick.
    /// @return config Liquidity configuration this tick resolves to.
    function evaluate(
        IStrategyTypes.RuntimeState memory current,
        IStrategyTypes.MarketState memory market,
        bytes memory program,
        uint256 nowTs
    )
        internal
        pure
        returns (IStrategyTypes.RuntimeState memory next, IStrategyTypes.LiquidityConfig memory config)
    {
        // Deep copy, deliberately field by field. `next = current` would alias the two structs
        // (memory-to-memory assignment copies the pointer), so every mutation below would also
        // rewrite the caller's "before" snapshot and transition detection would silently never fire.
        next = IStrategyTypes.RuntimeState({
            mode: current.mode,
            referencePrice: current.referencePrice,
            liquidityBps: current.liquidityBps,
            spreadBps: current.spreadBps,
            lastTransition: current.lastTransition,
            lastExecution: current.lastExecution,
            cumulativeVolume: current.cumulativeVolume,
            transitionCount: current.transitionCount,
            armedRule: current.armedRule,
            armedSince: current.armedSince
        });

        uint256 rules = RuleProgram.ruleCount(program);
        uint256 offset = RuleProgram.HEADER_SIZE;
        uint256 matched = type(uint256).max;
        uint256 matchedOffset;
        uint32 matchedDuration;
        uint256 matchedConditions;
        uint256 matchedActions;

        for (uint256 r = 0; r < rules; r++) {
            (uint256 conditionCount, uint32 duration, uint256 actionCount) = RuleProgram.readRuleHeader(program, offset);

            if (_allConditionsHold(program, offset, conditionCount, current, market, nowTs)) {
                matched = r;
                matchedOffset = offset;
                matchedDuration = duration;
                matchedConditions = conditionCount;
                matchedActions = actionCount;
                break;
            }

            offset += RuleProgram.RULE_HEADER_SIZE + conditionCount * RuleProgram.CONDITION_SIZE + actionCount * RuleProgram.ACTION_SIZE;
        }

        if (matched == type(uint256).max) {
            // Nothing matched: any pending sustained rule is no longer satisfied, so disarm it.
            next.armedRule = 0;
            next.armedSince = 0;
            return (next, _configOf(next));
        }

        if (matchedDuration != 0) {
            uint8 armIndex = uint8(matched + 1); // 1-based so 0 can mean "nothing armed"
            if (next.armedRule != armIndex) {
                // First tick this rule has held: start the clock, do not act yet.
                next.armedRule = armIndex;
                next.armedSince = uint64(nowTs);
                return (next, _configOf(next));
            }
            if (nowTs - next.armedSince < matchedDuration) {
                // Still counting down.
                return (next, _configOf(next));
            }
        }

        _applyActions(program, matchedOffset, matchedConditions, matchedActions, next, market, nowTs);
        next.armedRule = 0;
        next.armedSince = 0;

        return (next, _configOf(next));
    }

    function _configOf(IStrategyTypes.RuntimeState memory s) private pure returns (IStrategyTypes.LiquidityConfig memory) {
        return IStrategyTypes.LiquidityConfig({ liquidityBps: s.liquidityBps, spreadBps: s.spreadBps, mode: s.mode });
    }

    function _allConditionsHold(
        bytes memory program,
        uint256 ruleStart,
        uint256 conditionCount,
        IStrategyTypes.RuntimeState memory state,
        IStrategyTypes.MarketState memory market,
        uint256 nowTs
    )
        private
        pure
        returns (bool)
    {
        for (uint256 i = 0; i < conditionCount; i++) {
            RuleProgram.Condition memory c = RuleProgram.readCondition(program, ruleStart, i);
            if (!_holds(c, state, market, nowTs)) {
                return false;
            }
        }
        return true;
    }

    function _holds(
        RuleProgram.Condition memory c,
        IStrategyTypes.RuntimeState memory state,
        IStrategyTypes.MarketState memory market,
        uint256 nowTs
    )
        private
        pure
        returns (bool)
    {
        int256 lhs = _resolve(c.conditionType, state, market, nowTs);
        int256 rhs = c.operand;

        if (c.comparison == RuleProgram.Comparison.GT) {
            return lhs > rhs;
        }
        if (c.comparison == RuleProgram.Comparison.GTE) {
            return lhs >= rhs;
        }
        if (c.comparison == RuleProgram.Comparison.LT) {
            return lhs < rhs;
        }
        if (c.comparison == RuleProgram.Comparison.LTE) {
            return lhs <= rhs;
        }
        if (c.comparison == RuleProgram.Comparison.EQ) {
            return lhs == rhs;
        }
        return lhs != rhs; // NEQ
    }

    /// @dev Every observable the DSL can name, resolved to a signed integer in the protocol's
    ///      fixed-point convention. Values sourced from `market` are bps or WAD as declared on
    ///      {IStrategyTypes.MarketState}; durations are whole seconds.
    function _resolve(
        RuleProgram.ConditionType t,
        IStrategyTypes.RuntimeState memory state,
        IStrategyTypes.MarketState memory market,
        uint256 nowTs
    )
        private
        pure
        returns (int256)
    {
        if (t == RuleProgram.ConditionType.VOLATILITY) {
            return _toInt(market.volatility);
        }
        if (t == RuleProgram.ConditionType.PRICE) {
            return _toInt(market.price);
        }
        if (t == RuleProgram.ConditionType.PRICE_CHANGE_5M) {
            return market.priceChange5m;
        }
        if (t == RuleProgram.ConditionType.PRICE_CHANGE_1H) {
            return market.priceChange1h;
        }
        if (t == RuleProgram.ConditionType.TIME_SINCE_TRANSITION) {
            // Guard against a state written in a future block; clamp rather than underflow.
            return nowTs > state.lastTransition ? _toInt(nowTs - state.lastTransition) : int256(0);
        }
        if (t == RuleProgram.ConditionType.MODE) {
            return int256(uint256(uint8(state.mode)));
        }
        if (t == RuleProgram.ConditionType.ORACLE_CONFIDENCE) {
            return _toInt(market.oracleConfidence);
        }
        return _toInt(state.cumulativeVolume); // CUMULATIVE_VOLUME
    }

    /// @dev Saturating cast. A market value above `int256.max` is nonsensical, and saturating keeps
    ///      comparisons monotonic instead of wrapping to a negative number.
    function _toInt(uint256 v) private pure returns (int256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return v > uint256(type(int256).max) ? type(int256).max : int256(v);
    }

    function _applyActions(
        bytes memory program,
        uint256 ruleStart,
        uint256 conditionCount,
        uint256 actionCount,
        IStrategyTypes.RuntimeState memory next,
        IStrategyTypes.MarketState memory market,
        uint256 nowTs
    )
        private
        pure
    {
        IStrategyTypes.StrategyMode previousMode = next.mode;

        for (uint256 i = 0; i < actionCount; i++) {
            RuleProgram.Action memory a = RuleProgram.readAction(program, ruleStart, conditionCount, i);

            if (a.actionType == RuleProgram.ActionType.SET_MODE) {
                next.mode = IStrategyTypes.StrategyMode(uint8(a.operand));
            } else if (a.actionType == RuleProgram.ActionType.SET_LIQUIDITY) {
                next.liquidityBps = uint16(a.operand);
            } else if (a.actionType == RuleProgram.ActionType.SET_SPREAD) {
                next.spreadBps = uint16(a.operand);
            } else if (a.actionType == RuleProgram.ActionType.MULTIPLY_LIQUIDITY) {
                next.liquidityBps = uint16(uint256(next.liquidityBps).mulBps(a.operand));
            } else {
                // ADD_SPREAD, saturating at the protocol cap rather than wrapping the uint16.
                uint256 widened = uint256(next.spreadBps) + a.operand;
                next.spreadBps = widened > StrategyLib.MAX_SPREAD_BPS ? StrategyLib.MAX_SPREAD_BPS : uint16(widened);
            }
        }

        _clamp(next);

        if (next.mode != previousMode) {
            next.lastTransition = uint64(nowTs);
            next.transitionCount += 1;
            // Anchor the new mode to the price that triggered it, so a later rule can measure
            // drift from the point of transition rather than from an arbitrary earlier price.
            next.referencePrice = market.price;
        }
    }

    /// @dev Final safety net. Action operands are range-checked at registration, but
    ///      MULTIPLY_LIQUIDITY and ADD_SPREAD compose with prior state, so the composed result is
    ///      clamped here too. No strategy can ever emerge with liquidity above 100%.
    function _clamp(IStrategyTypes.RuntimeState memory s) private pure {
        if (s.liquidityBps > StrategyLib.MAX_LIQUIDITY_BPS) {
            s.liquidityBps = StrategyLib.MAX_LIQUIDITY_BPS;
        }
        if (s.spreadBps > StrategyLib.MAX_SPREAD_BPS) {
            s.spreadBps = StrategyLib.MAX_SPREAD_BPS;
        }
    }
}
