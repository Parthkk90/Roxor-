// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { RuleProgram } from "../../contracts/libraries/RuleProgram.sol";

/// @notice Encodes rule programs in the {RuleProgram} binary format.
/// @dev Mirrors what the TypeScript compiler emits in Part 3. The golden tests assert both
///      producers agree byte-for-byte, so this doubles as an executable spec of the format.
library RuleProgramBuilder {
    /// @notice Encode one condition (34 bytes).
    function cond(RuleProgram.ConditionType t, RuleProgram.Comparison c, int256 operand) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(t), uint8(c), operand);
    }

    /// @notice Encode one action (33 bytes).
    function act(RuleProgram.ActionType t, uint256 operand) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(t), operand);
    }

    /// @notice Encode a rule from pre-encoded condition and action blobs.
    function rule(uint32 durationSeconds, bytes memory conditions, bytes memory actions) internal pure returns (bytes memory) {
        uint8 nConds = uint8(conditions.length / RuleProgram.CONDITION_SIZE);
        uint8 nActs = uint8(actions.length / RuleProgram.ACTION_SIZE);
        return abi.encodePacked(nConds, durationSeconds, nActs, conditions, actions);
    }

    /// @notice Assemble a complete program from encoded rules.
    function program(bytes[] memory rules) internal pure returns (bytes memory out) {
        out = abi.encodePacked(RuleProgram.VERSION, uint8(rules.length));
        for (uint256 i = 0; i < rules.length; i++) {
            out = bytes.concat(out, rules[i]);
        }
    }
}
