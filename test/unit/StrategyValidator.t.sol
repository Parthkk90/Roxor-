// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { StrategyValidator } from "../../contracts/core/StrategyValidator.sol";
import { IStrategyValidator } from "../../contracts/core/interfaces/IStrategyValidator.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";

contract StrategyValidatorTest is Test {
    StrategyValidator internal validator;

    address internal constant TOKEN_A = address(0xAAA1);
    address internal constant TOKEN_B = address(0xBBB2);

    /// @dev One well-formed instruction: opcode 0x50 (XYCSwap) carrying zero args.
    bytes internal constant GOOD_PROGRAM = hex"5000";

    function setUp() public {
        validator = new StrategyValidator();
    }

    function _validate(address a, address b, uint16 liq, uint16 spread, bytes memory program) internal view {
        validator.validate(a, b, liq, spread, program);
    }

    function test_AcceptsValidStrategy() public view {
        _validate(TOKEN_A, TOKEN_B, 10_000, 20, GOOD_PROGRAM);
    }

    /* ------------------------------------------------------------------ tokens */

    function test_RevertWhen_ZeroToken() public {
        vm.expectRevert(abi.encodeWithSelector(IStrategyValidator.InvalidToken.selector, address(0)));
        _validate(address(0), TOKEN_B, 10_000, 20, GOOD_PROGRAM);

        vm.expectRevert(abi.encodeWithSelector(IStrategyValidator.InvalidToken.selector, address(0)));
        _validate(TOKEN_A, address(0), 10_000, 20, GOOD_PROGRAM);
    }

    function test_RevertWhen_IdenticalTokens() public {
        vm.expectRevert(abi.encodeWithSelector(IStrategyValidator.IdenticalTokens.selector, TOKEN_A));
        _validate(TOKEN_A, TOKEN_A, 10_000, 20, GOOD_PROGRAM);
    }

    /// @notice An unsorted pair would be rejected by SwapVM at swap time, so reject it at registration.
    function test_RevertWhen_TokensNotSorted() public {
        vm.expectRevert(abi.encodeWithSelector(IStrategyValidator.TokensNotSorted.selector, TOKEN_B, TOKEN_A));
        _validate(TOKEN_B, TOKEN_A, 10_000, 20, GOOD_PROGRAM);
    }

    /* ------------------------------------------------------------------ bounds */

    function test_RevertWhen_LiquidityAboveOneHundredPercent() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IStrategyValidator.LiquidityOutOfBounds.selector,
                uint16(10_001),
                StrategyLib.MIN_LIQUIDITY_BPS,
                StrategyLib.MAX_LIQUIDITY_BPS
            )
        );
        _validate(TOKEN_A, TOKEN_B, 10_001, 20, GOOD_PROGRAM);
    }

    function test_RevertWhen_SpreadAboveCap() public {
        uint16 tooWide = StrategyLib.MAX_SPREAD_BPS + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                IStrategyValidator.SpreadOutOfBounds.selector, tooWide, StrategyLib.MIN_SPREAD_BPS, StrategyLib.MAX_SPREAD_BPS
            )
        );
        _validate(TOKEN_A, TOKEN_B, 10_000, tooWide, GOOD_PROGRAM);
    }

    function test_AcceptsExactBounds() public view {
        _validate(TOKEN_A, TOKEN_B, StrategyLib.MAX_LIQUIDITY_BPS, StrategyLib.MAX_SPREAD_BPS, GOOD_PROGRAM);
        _validate(TOKEN_A, TOKEN_B, StrategyLib.MIN_LIQUIDITY_BPS, StrategyLib.MIN_SPREAD_BPS, GOOD_PROGRAM);
    }

    /* ------------------------------------------------------------------ program shape */

    function test_RevertWhen_ProgramEmpty() public {
        vm.expectRevert(IStrategyValidator.ProgramEmpty.selector);
        _validate(TOKEN_A, TOKEN_B, 10_000, 20, "");
    }

    function test_RevertWhen_ProgramTooLarge() public {
        bytes memory huge = new bytes(StrategyLib.MAX_PROGRAM_SIZE + 1);
        vm.expectRevert(abi.encodeWithSelector(IStrategyValidator.ProgramTooLarge.selector, huge.length, StrategyLib.MAX_PROGRAM_SIZE));
        _validate(TOKEN_A, TOKEN_B, 10_000, 20, huge);
    }

    /// @notice A trailing instruction whose args run past the end of the program.
    function test_RevertWhen_ProgramTruncated() public {
        // opcode 0x50, declares 4 args bytes, but only 2 follow.
        bytes memory truncated = hex"5004dead";
        vm.expectRevert(abi.encodeWithSelector(IStrategyValidator.MalformedProgram.selector, uint256(0), uint256(4)));
        validator.validateProgramShape(truncated);
    }

    /// @notice A lone opcode byte with no args-length byte after it.
    function test_RevertWhen_ProgramMissingArgsLengthByte() public {
        bytes memory dangling = hex"500050";
        vm.expectRevert(abi.encodeWithSelector(IStrategyValidator.MalformedProgram.selector, uint256(2), uint256(3)));
        validator.validateProgramShape(dangling);
    }

    function test_AcceptsMultiInstructionProgram() public view {
        // [0x90 StaticBalances with 2 args][0x50 XYCSwap with 0 args]
        validator.validateProgramShape(hex"9002beef5000");
    }

    /* ------------------------------------------------------------------ fuzz */

    function testFuzz_NeverAcceptsUnsortedOrZeroTokens(address a, address b) public {
        vm.assume(a != address(0) && b != address(0) && a != b);
        (address lo, address hi) = a < b ? (a, b) : (b, a);

        _validate(lo, hi, 10_000, 20, GOOD_PROGRAM); // sorted: fine
        vm.expectRevert(abi.encodeWithSelector(IStrategyValidator.TokensNotSorted.selector, hi, lo));
        _validate(hi, lo, 10_000, 20, GOOD_PROGRAM); // reversed: always rejected
    }

    function testFuzz_LiquidityBoundsEnforced(uint16 liq) public {
        if (liq <= StrategyLib.MAX_LIQUIDITY_BPS) {
            _validate(TOKEN_A, TOKEN_B, liq, 20, GOOD_PROGRAM);
        } else {
            vm.expectRevert();
            _validate(TOKEN_A, TOKEN_B, liq, 20, GOOD_PROGRAM);
        }
    }
}
