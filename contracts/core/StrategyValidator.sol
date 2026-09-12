// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IStrategyValidator } from "./interfaces/IStrategyValidator.sol";
import { RuleProgram } from "../libraries/RuleProgram.sol";
import { StrategyLib } from "../libraries/StrategyLib.sol";

/// @title StrategyValidator
/// @notice Stateless admission checks for conditional-liquidity strategies.
/// @dev Kept separate from the registry so the rule set can be replaced without migrating
///      registry storage, and so the checks can be unit-tested in isolation.
contract StrategyValidator is IStrategyValidator {
    /// @inheritdoc IStrategyValidator
    function validate(address tokenA, address tokenB, uint16 baseLiquidityBps, uint16 baseSpreadBps, bytes calldata program) external pure {
        _validateTokens(tokenA, tokenB);
        _validateBounds(baseLiquidityBps, baseSpreadBps);
        _validateProgramShape(program);
    }

    /// @inheritdoc IStrategyValidator
    function validateProgramShape(bytes calldata program) external pure {
        _validateProgramShape(program);
    }

    /// @inheritdoc IStrategyValidator
    function validateRuleProgram(bytes calldata ruleProgram) external pure {
        RuleProgram.validate(ruleProgram);
    }

    function _validateTokens(address tokenA, address tokenB) private pure {
        require(tokenA != address(0), InvalidToken(tokenA));
        require(tokenB != address(0), InvalidToken(tokenB));
        require(tokenA != tokenB, IdenticalTokens(tokenA));
        // SwapVM's MakerTraitsLib.build rejects an unsorted pair, so a strategy registered with
        // the opposite ordering could never be executed. Reject it here instead of at swap time.
        require(tokenA < tokenB, TokensNotSorted(tokenA, tokenB));
    }

    function _validateBounds(uint16 baseLiquidityBps, uint16 baseSpreadBps) private pure {
        require(
            baseLiquidityBps >= StrategyLib.MIN_LIQUIDITY_BPS && baseLiquidityBps <= StrategyLib.MAX_LIQUIDITY_BPS,
            LiquidityOutOfBounds(baseLiquidityBps, StrategyLib.MIN_LIQUIDITY_BPS, StrategyLib.MAX_LIQUIDITY_BPS)
        );
        require(
            baseSpreadBps >= StrategyLib.MIN_SPREAD_BPS && baseSpreadBps <= StrategyLib.MAX_SPREAD_BPS,
            SpreadOutOfBounds(baseSpreadBps, StrategyLib.MIN_SPREAD_BPS, StrategyLib.MAX_SPREAD_BPS)
        );
    }

    /// @dev Mirrors the header walk in `ContextLib.runLoop`: each instruction is
    ///      `[opcode:1][argsLength:1][args:argsLength]`. We only check framing, not opcode
    ///      semantics; the router owns the opcode table and rejects unknown opcodes itself.
    function _validateProgramShape(bytes calldata program) private pure {
        uint256 length = program.length;
        require(length != 0, ProgramEmpty());
        require(length <= StrategyLib.MAX_PROGRAM_SIZE, ProgramTooLarge(length, StrategyLib.MAX_PROGRAM_SIZE));

        uint256 pc = 0;
        while (pc < length) {
            // Need the opcode byte and the args-length byte before we can read the args.
            if (pc + 2 > length) {
                revert MalformedProgram(pc, length);
            }
            uint256 argsLength = uint8(program[pc + 1]);
            uint256 next = pc + 2 + argsLength;
            if (next > length) {
                revert MalformedProgram(pc, length);
            }
            pc = next;
        }
    }
}
