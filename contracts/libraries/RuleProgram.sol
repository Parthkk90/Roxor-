// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IStrategyTypes } from "../core/interfaces/IStrategyTypes.sol";
import { StrategyLib } from "./StrategyLib.sol";

/// @title RuleProgram
/// @notice Binary encoding of a compiled conditional-liquidity rule set, plus its decoder and
///         structural validator.
///
/// @dev This is the contract between the off-chain compiler (Part 3) and the on-chain engine
///      (Part 2). It is deliberately a flat, fixed-width, little-branching format: every field has
///      a known offset, so decoding is O(1) per element and a malformed program is detectable
///      without executing it.
///
/// @dev FORMAT (version 1), all integers big-endian:
///
///      header
///        +0   uint8    version            must equal VERSION
///        +1   uint8    ruleCount          <= MAX_RULES
///
///      then `ruleCount` rules laid out back to back; each rule is
///        +0   uint8    conditionCount     1..MAX_CONDITIONS_PER_RULE
///        +1   uint32   durationSeconds    0 = fire immediately, else sustained gate
///        +5   uint8    actionCount        1..MAX_ACTIONS_PER_RULE
///        +6   conditionCount * CONDITION_SIZE bytes
///        ...  actionCount    * ACTION_SIZE    bytes
///
///      condition (CONDITION_SIZE bytes)
///        +0   uint8    ConditionType
///        +1   uint8    Comparison
///        +2   int256   operand            signed; unsigned quantities occupy the positive range
///
///      action (ACTION_SIZE bytes)
///        +0   uint8    ActionType
///        +1   uint256  operand
library RuleProgram {
    /// @notice Format version. Bump on any layout change; the decoder refuses other versions.
    uint8 internal constant VERSION = 1;

    uint256 internal constant HEADER_SIZE = 2;
    uint256 internal constant RULE_HEADER_SIZE = 6;
    uint256 internal constant CONDITION_SIZE = 34;
    uint256 internal constant ACTION_SIZE = 33;

    /// @notice Complexity ceilings. These bound worst-case gas for a single evaluation, so a
    ///         maliciously complex strategy cannot make execution unpredictably expensive.
    uint256 internal constant MAX_RULES = 16;
    uint256 internal constant MAX_CONDITIONS_PER_RULE = 4;
    uint256 internal constant MAX_ACTIONS_PER_RULE = 4;

    /// @notice At most one rule may fire per evaluation.
    /// @dev Enforced structurally by {RuleEngineLib}: evaluation selects the first matching rule
    ///      and stops. This is the `MAX_STATE_TRANSITIONS_PER_EXECUTION = 1` guarantee.
    uint256 internal constant MAX_TRANSITIONS_PER_EXECUTION = 1;

    enum ConditionType {
        VOLATILITY,
        PRICE,
        PRICE_CHANGE_5M,
        PRICE_CHANGE_1H,
        TIME_SINCE_TRANSITION,
        MODE,
        ORACLE_CONFIDENCE,
        CUMULATIVE_VOLUME
    }

    enum Comparison {
        GT,
        GTE,
        LT,
        LTE,
        EQ,
        NEQ
    }

    enum ActionType {
        SET_MODE,
        SET_LIQUIDITY,
        SET_SPREAD,
        MULTIPLY_LIQUIDITY,
        ADD_SPREAD
    }

    struct Condition {
        ConditionType conditionType;
        Comparison comparison;
        int256 operand;
    }

    struct Action {
        ActionType actionType;
        uint256 operand;
    }

    error UnsupportedVersion(uint8 version);
    error TooManyRules(uint256 count, uint256 max);
    error TooManyConditions(uint256 ruleIndex, uint256 count, uint256 max);
    error TooManyActions(uint256 ruleIndex, uint256 count, uint256 max);
    error EmptyRuleSet();
    error RuleHasNoConditions(uint256 ruleIndex);
    error RuleHasNoActions(uint256 ruleIndex);
    error ProgramTruncated(uint256 needed, uint256 available);
    error TrailingBytes(uint256 consumed, uint256 length);
    error UnknownConditionType(uint256 value);
    error UnknownComparison(uint256 value);
    error UnknownActionType(uint256 value);
    error UnknownMode(uint256 value);
    error ActionOperandOutOfRange(uint256 ruleIndex, uint8 actionType, uint256 operand);

    /* --------------------------------------------------------------- primitive readers */

    function _u8(bytes memory data, uint256 offset) private pure returns (uint8) {
        return uint8(data[offset]);
    }

    function _u32(bytes memory data, uint256 offset) private pure returns (uint32) {
        uint32 v;
        for (uint256 i = 0; i < 4; i++) {
            v = (v << 8) | uint32(uint8(data[offset + i]));
        }
        return v;
    }

    function _u256(bytes memory data, uint256 offset) private pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := mload(add(add(data, 0x20), offset))
        }
    }

    /* --------------------------------------------------------------- decoding */

    function version(bytes memory program) internal pure returns (uint8) {
        require(program.length >= HEADER_SIZE, ProgramTruncated(HEADER_SIZE, program.length));
        return _u8(program, 0);
    }

    function ruleCount(bytes memory program) internal pure returns (uint256) {
        require(program.length >= HEADER_SIZE, ProgramTruncated(HEADER_SIZE, program.length));
        return _u8(program, 1);
    }

    /// @notice Byte offset at which rule `index` begins.
    /// @dev Rules are variable length, so this walks the preceding rule headers. Bounded by
    ///      MAX_RULES, and each step is two byte reads.
    function ruleOffset(bytes memory program, uint256 index) internal pure returns (uint256 offset) {
        offset = HEADER_SIZE;
        for (uint256 i = 0; i < index; i++) {
            offset += ruleSize(program, offset);
        }
    }

    function ruleSize(bytes memory program, uint256 offset) internal pure returns (uint256) {
        require(offset + RULE_HEADER_SIZE <= program.length, ProgramTruncated(offset + RULE_HEADER_SIZE, program.length));
        uint256 conditions = _u8(program, offset);
        uint256 actions = _u8(program, offset + 5);
        return RULE_HEADER_SIZE + conditions * CONDITION_SIZE + actions * ACTION_SIZE;
    }

    function readRuleHeader(
        bytes memory program,
        uint256 offset
    )
        internal
        pure
        returns (uint256 conditionCount, uint32 durationSeconds, uint256 actionCount)
    {
        conditionCount = _u8(program, offset);
        durationSeconds = _u32(program, offset + 1);
        actionCount = _u8(program, offset + 5);
    }

    function readCondition(bytes memory program, uint256 ruleStart, uint256 index) internal pure returns (Condition memory c) {
        uint256 at = ruleStart + RULE_HEADER_SIZE + index * CONDITION_SIZE;
        c.conditionType = _toConditionType(_u8(program, at));
        c.comparison = _toComparison(_u8(program, at + 1));
        // forge-lint: disable-next-line(unsafe-typecast)
        c.operand = int256(_u256(program, at + 2));
    }

    function readAction(
        bytes memory program,
        uint256 ruleStart,
        uint256 conditionCount,
        uint256 index
    )
        internal
        pure
        returns (Action memory a)
    {
        uint256 at = ruleStart + RULE_HEADER_SIZE + conditionCount * CONDITION_SIZE + index * ACTION_SIZE;
        a.actionType = _toActionType(_u8(program, at));
        a.operand = _u256(program, at + 1);
    }

    function _toConditionType(uint8 v) private pure returns (ConditionType) {
        require(v <= uint8(type(ConditionType).max), UnknownConditionType(v));
        return ConditionType(v);
    }

    function _toComparison(uint8 v) private pure returns (Comparison) {
        require(v <= uint8(type(Comparison).max), UnknownComparison(v));
        return Comparison(v);
    }

    function _toActionType(uint8 v) private pure returns (ActionType) {
        require(v <= uint8(type(ActionType).max), UnknownActionType(v));
        return ActionType(v);
    }

    /* --------------------------------------------------------------- validation */

    /// @notice Fully validate a rule program's structure and operand ranges.
    /// @dev Run once at registration so execution never has to defend against a malformed program.
    ///      Checks: version, rule/condition/action counts, every enum discriminant, every action
    ///      operand's range, exact length (no trailing bytes).
    function validate(bytes memory program) internal pure {
        require(program.length >= HEADER_SIZE, ProgramTruncated(HEADER_SIZE, program.length));
        require(_u8(program, 0) == VERSION, UnsupportedVersion(_u8(program, 0)));

        uint256 rules = _u8(program, 1);
        require(rules != 0, EmptyRuleSet());
        require(rules <= MAX_RULES, TooManyRules(rules, MAX_RULES));

        uint256 offset = HEADER_SIZE;
        for (uint256 r = 0; r < rules; r++) {
            require(offset + RULE_HEADER_SIZE <= program.length, ProgramTruncated(offset + RULE_HEADER_SIZE, program.length));
            (uint256 conditions,, uint256 actions) = readRuleHeader(program, offset);

            require(conditions != 0, RuleHasNoConditions(r));
            require(conditions <= MAX_CONDITIONS_PER_RULE, TooManyConditions(r, conditions, MAX_CONDITIONS_PER_RULE));
            require(actions != 0, RuleHasNoActions(r));
            require(actions <= MAX_ACTIONS_PER_RULE, TooManyActions(r, actions, MAX_ACTIONS_PER_RULE));

            uint256 size = RULE_HEADER_SIZE + conditions * CONDITION_SIZE + actions * ACTION_SIZE;
            require(offset + size <= program.length, ProgramTruncated(offset + size, program.length));

            for (uint256 c = 0; c < conditions; c++) {
                Condition memory cond = readCondition(program, offset, c);
                if (cond.conditionType == ConditionType.MODE) {
                    require(
                        cond.operand >= 0 && uint256(cond.operand) <= uint256(uint8(type(IStrategyTypes.StrategyMode).max)),
                        UnknownMode(uint256(cond.operand))
                    );
                }
            }

            for (uint256 a = 0; a < actions; a++) {
                Action memory act = readAction(program, offset, conditions, a);
                _validateActionOperand(r, act);
            }

            offset += size;
        }

        require(offset == program.length, TrailingBytes(offset, program.length));
    }

    function _validateActionOperand(uint256 ruleIndex, Action memory act) private pure {
        uint256 v = act.operand;
        if (act.actionType == ActionType.SET_MODE) {
            require(
                v <= uint256(uint8(type(IStrategyTypes.StrategyMode).max)), ActionOperandOutOfRange(ruleIndex, uint8(act.actionType), v)
            );
        } else if (act.actionType == ActionType.SET_LIQUIDITY || act.actionType == ActionType.MULTIPLY_LIQUIDITY) {
            // A multiplier above 100% would let a strategy quote against balances the maker never
            // shipped to Aqua, so both forms share the same ceiling.
            require(v <= StrategyLib.MAX_LIQUIDITY_BPS, ActionOperandOutOfRange(ruleIndex, uint8(act.actionType), v));
        } else {
            // SET_SPREAD and ADD_SPREAD
            require(v <= StrategyLib.MAX_SPREAD_BPS, ActionOperandOutOfRange(ruleIndex, uint8(act.actionType), v));
        }
    }
}
