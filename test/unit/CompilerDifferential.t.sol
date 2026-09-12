// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { RuleProgram } from "../../contracts/libraries/RuleProgram.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @title CompilerDifferentialTest
/// @notice Differential check between the TypeScript compiler (Part 3) and the Solidity encoding
///         of the same logical strategy.
///
/// @dev `StrategyFixtures.volatilityShield()` and `examples/volatility-shield.clf` describe the
///      same strategy by hand, in two different languages, against the same written spec (see the
///      comment above each). This test pins the TypeScript compiler's committed golden bytecode
///      (`test/compiler/golden/volatility-shield.bytecode.hex`, produced by
///      `npm run compile examples/volatility-shield.clf --emit test/compiler/golden`) and asserts
///      the Solidity fixture encodes to the exact same bytes.
///
///      If this test ever fails, do not "fix" it by editing the constant below — that would just
///      make both encoders agree on something wrong. Regenerate the TypeScript golden file, review
///      the diff by hand, and only update this constant if the new bytecode is correct.
contract CompilerDifferentialTest is Test {
    // solhint-disable-next-line max-line-length
    bytes internal constant TS_COMPILER_GOLDEN =
        hex"010402000000000305040000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000013880000000000000000000000000000000000000000000000000000000000000000010100000000000000000000000000000000000000000000000000000000000009c402000000000000000000000000000000000000000000000000000000000000005a0200000258030504000000000000000000000000000000000000000000000000000000000000000100020000000000000000000000000000000000000000000000000000000000000bb800000000000000000000000000000000000000000000000000000000000000000201000000000000000000000000000000000000000000000000000000000000138802000000000000000000000000000000000000000000000000000000000000003202000000000305040000000000000000000000000000000000000000000000000000000000000002000100000000000000000000000000000000000000000000000000000000000013880000000000000000000000000000000000000000000000000000000000000000010100000000000000000000000000000000000000000000000000000000000009c402000000000000000000000000000000000000000000000000000000000000005a0200000000030504000000000000000000000000000000000000000000000000000000000000000204010000000000000000000000000000000000000000000000000000000000000258000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000002710020000000000000000000000000000000000000000000000000000000000000014";

    function test_SolidityFixtureMatchesTypeScriptCompilerOutput() public pure {
        bytes memory solidityEncoded = StrategyFixtures.volatilityShield();
        assertEq(solidityEncoded, TS_COMPILER_GOLDEN, "Solidity and TypeScript encoders diverged");
    }

    /// @notice The shared bytecode must also pass the on-chain structural validator.
    function test_SharedBytecodeIsStructurallyValid() public pure {
        RuleProgram.validate(TS_COMPILER_GOLDEN);
    }
}
