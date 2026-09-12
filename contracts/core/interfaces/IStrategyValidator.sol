// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IStrategyTypes } from "./IStrategyTypes.sol";

/// @title IStrategyValidator
/// @notice Stateless admission checks applied to a strategy before it is registered.
interface IStrategyValidator is IStrategyTypes {
    error InvalidToken(address token);
    error IdenticalTokens(address token);
    error TokensNotSorted(address tokenA, address tokenB);
    error ProgramEmpty();
    error ProgramTooLarge(uint256 size, uint256 maxSize);
    error MalformedProgram(uint256 offset, uint256 programLength);
    error LiquidityOutOfBounds(uint16 value, uint16 min, uint16 max);
    error SpreadOutOfBounds(uint16 value, uint16 min, uint16 max);

    /// @notice Revert unless the supplied strategy definition is admissible.
    /// @param tokenA Lower-addressed token of the pair.
    /// @param tokenB Higher-addressed token of the pair.
    /// @param baseLiquidityBps Base liquidity multiplier in bps.
    /// @param baseSpreadBps Base spread in bps.
    /// @param program Compiled SwapVM program the strategy will execute.
    function validate(address tokenA, address tokenB, uint16 baseLiquidityBps, uint16 baseSpreadBps, bytes calldata program) external view;

    /// @notice Walk a SwapVM program's instruction headers and revert if it is malformed.
    /// @dev Catches a truncated trailing instruction, which the VM would otherwise only detect
    ///      mid-execution after side effects had already been applied.
    function validateProgramShape(bytes calldata program) external pure;

    /// @notice Fully validate a compiled conditional-liquidity rule program.
    /// @dev Checks version, complexity ceilings, enum discriminants and operand ranges, so that
    ///      evaluation at swap time never has to defend against a malformed program.
    function validateRuleProgram(bytes calldata ruleProgram) external pure;
}
