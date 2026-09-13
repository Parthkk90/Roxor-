"""Python reference implementation of contracts/libraries/RuleEngineLib.sol.

This decodes the *same binary rule-program format* that RuleProgram.sol decodes (see that file's
NatSpec for the layout) and evaluates it with the same semantics as RuleEngineLib.evaluate. It is
deliberately a second, independent implementation in a different language, reading the exact same
artifact the Solidity contracts consume in production - not a redescription of the strategy's logic
in Python. A bug in either the Solidity decoder or the Solidity evaluator that this model doesn't
share will show up as a mismatch in test/differential/ReferenceEngine.t.sol.

Fixed-point convention matches FixedPointMath.sol: ratios in bps (10_000 = 100%), prices in WAD.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from enum import IntEnum


BPS = 10_000
MAX_LIQUIDITY_BPS = 10_000
MAX_SPREAD_BPS = 5_000


class ConditionType(IntEnum):
    VOLATILITY = 0
    PRICE = 1
    PRICE_CHANGE_5M = 2
    PRICE_CHANGE_1H = 3
    TIME_SINCE_TRANSITION = 4
    MODE = 5
    ORACLE_CONFIDENCE = 6
    CUMULATIVE_VOLUME = 7


class Comparison(IntEnum):
    GT = 0
    GTE = 1
    LT = 2
    LTE = 3
    EQ = 4
    NEQ = 5


class ActionType(IntEnum):
    SET_MODE = 0
    SET_LIQUIDITY = 1
    SET_SPREAD = 2
    MULTIPLY_LIQUIDITY = 3
    ADD_SPREAD = 4


class StrategyMode(IntEnum):
    NORMAL = 0
    DEFENSIVE = 1
    RECOVERY = 2


@dataclass(frozen=True)
class Condition:
    type: ConditionType
    comparison: Comparison
    operand: int  # signed


@dataclass(frozen=True)
class Action:
    type: ActionType
    operand: int  # unsigned


@dataclass(frozen=True)
class Rule:
    conditions: tuple[Condition, ...]
    duration_seconds: int
    actions: tuple[Action, ...]


@dataclass(frozen=True)
class RuntimeState:
    mode: StrategyMode
    reference_price: int
    liquidity_bps: int
    spread_bps: int
    last_transition: int
    last_execution: int
    cumulative_volume: int
    transition_count: int
    armed_rule: int
    armed_since: int


@dataclass(frozen=True)
class MarketState:
    price: int
    volatility: int
    price_change_5m: int
    price_change_1h: int
    volume: int
    oracle_confidence: int
    timestamp: int


@dataclass(frozen=True)
class LiquidityConfig:
    liquidity_bps: int
    spread_bps: int
    mode: StrategyMode


def _to_int256(v: int) -> int:
    """Two's-complement decode of a 256-bit big-endian word, mirroring `int256(uint256)`."""
    if v >= 2**255:
        return v - 2**256
    return v


def decode_program(data: bytes) -> tuple[int, list[Rule]]:
    version = data[0]
    rule_count = data[1]
    offset = 2
    rules: list[Rule] = []

    for _ in range(rule_count):
        condition_count = data[offset]
        duration_seconds = int.from_bytes(data[offset + 1 : offset + 5], "big")
        action_count = data[offset + 5]
        offset += 6

        conditions = []
        for _ in range(condition_count):
            ctype = ConditionType(data[offset])
            comparison = Comparison(data[offset + 1])
            operand = _to_int256(int.from_bytes(data[offset + 2 : offset + 34], "big"))
            conditions.append(Condition(ctype, comparison, operand))
            offset += 34

        actions = []
        for _ in range(action_count):
            atype = ActionType(data[offset])
            operand = int.from_bytes(data[offset + 1 : offset + 33], "big")
            actions.append(Action(atype, operand))
            offset += 33

        rules.append(Rule(tuple(conditions), duration_seconds, tuple(actions)))

    assert offset == len(data), f"trailing bytes: consumed {offset} of {len(data)}"
    return version, rules


def _resolve(ctype: ConditionType, state: RuntimeState, market: MarketState, now: int) -> int:
    if ctype == ConditionType.VOLATILITY:
        return market.volatility
    if ctype == ConditionType.PRICE:
        return market.price
    if ctype == ConditionType.PRICE_CHANGE_5M:
        return market.price_change_5m
    if ctype == ConditionType.PRICE_CHANGE_1H:
        return market.price_change_1h
    if ctype == ConditionType.TIME_SINCE_TRANSITION:
        return now - state.last_transition if now > state.last_transition else 0
    if ctype == ConditionType.MODE:
        return int(state.mode)
    if ctype == ConditionType.ORACLE_CONFIDENCE:
        return market.oracle_confidence
    return state.cumulative_volume  # CUMULATIVE_VOLUME


def _compare(lhs: int, comparison: Comparison, rhs: int) -> bool:
    if comparison == Comparison.GT:
        return lhs > rhs
    if comparison == Comparison.GTE:
        return lhs >= rhs
    if comparison == Comparison.LT:
        return lhs < rhs
    if comparison == Comparison.LTE:
        return lhs <= rhs
    if comparison == Comparison.EQ:
        return lhs == rhs
    return lhs != rhs  # NEQ


def _clamp(state: RuntimeState) -> RuntimeState:
    liq = min(state.liquidity_bps, MAX_LIQUIDITY_BPS)
    spread = min(state.spread_bps, MAX_SPREAD_BPS)
    if liq != state.liquidity_bps or spread != state.spread_bps:
        state = replace(state, liquidity_bps=liq, spread_bps=spread)
    return state


def _apply_actions(rule: Rule, state: RuntimeState, market: MarketState, now: int) -> RuntimeState:
    previous_mode = state.mode
    next_state = state

    for action in rule.actions:
        if action.type == ActionType.SET_MODE:
            next_state = replace(next_state, mode=StrategyMode(action.operand))
        elif action.type == ActionType.SET_LIQUIDITY:
            next_state = replace(next_state, liquidity_bps=action.operand)
        elif action.type == ActionType.SET_SPREAD:
            next_state = replace(next_state, spread_bps=action.operand)
        elif action.type == ActionType.MULTIPLY_LIQUIDITY:
            next_state = replace(next_state, liquidity_bps=(next_state.liquidity_bps * action.operand) // BPS)
        else:  # ADD_SPREAD, saturating
            widened = next_state.spread_bps + action.operand
            next_state = replace(next_state, spread_bps=min(widened, MAX_SPREAD_BPS))

    next_state = _clamp(next_state)

    if next_state.mode != previous_mode:
        next_state = replace(
            next_state,
            last_transition=now,
            transition_count=next_state.transition_count + 1,
            reference_price=market.price,
        )

    return next_state


def evaluate(
    state: RuntimeState, market: MarketState, rules: list[Rule], now: int
) -> tuple[RuntimeState, LiquidityConfig]:
    """Mirrors RuleEngineLib.evaluate exactly: first matching rule wins, sustained rules arm
    before they fire, anything else leaves state untouched but disarms a no-longer-true sustain."""

    matched_index = None
    for i, rule in enumerate(rules):
        if all(_compare(_resolve(c.type, state, market, now), c.comparison, c.operand) for c in rule.conditions):
            matched_index = i
            break

    def config_of(s: RuntimeState) -> LiquidityConfig:
        return LiquidityConfig(s.liquidity_bps, s.spread_bps, s.mode)

    if matched_index is None:
        next_state = replace(state, armed_rule=0, armed_since=0)
        return next_state, config_of(next_state)

    rule = rules[matched_index]

    if rule.duration_seconds != 0:
        arm_index = matched_index + 1
        if state.armed_rule != arm_index:
            next_state = replace(state, armed_rule=arm_index, armed_since=now)
            return next_state, config_of(next_state)
        if now - state.armed_since < rule.duration_seconds:
            return state, config_of(state)

    next_state = _apply_actions(rule, state, market, now)
    next_state = replace(next_state, armed_rule=0, armed_since=0)
    return next_state, config_of(next_state)
