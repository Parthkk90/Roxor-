// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import { Extruction } from "@1inch/swap-vm/src/instructions/Extruction.sol";

/// @title ConditionalLiquidityProgramLib
/// @notice Builds the standard SwapVM program bytecode for an Aqua-backed conditional-liquidity
///         AMM strategy: a constant-product curve gated by {ConditionalLiquidityExtruction}.
///
/// @dev NO BALANCES INSTRUCTION
///      `StaticBalances`/`DynamicBalances` exist for signature-backed orders that have no other
///      place to keep reserve state. An Aqua-backed order (`useAquaInsteadOfSignature = true`)
///      does not need either: `SwapVM.swap()`/`quote()` populate `ctx.swap.balanceIn/balanceOut`
///      directly from `AQUA.safeBalances(...)` before the program even starts running. Adding a
///      Balances instruction here would silently overwrite those real balances with a second,
///      disconnected tracking mechanism (this is confirmed by 1inch's own Aqua test helper,
///      `AquaStrategyBuilders.buildProgram`, which builds Aqua programs the same way: fee
///      instructions, then straight to the curve, with no Balances instruction).
///
/// @dev Instruction order otherwise matters (see {ConditionalLiquidityExtruction}'s NatSpec): the
///      curve must run before the extruction so the extruction can gate the curve's own output.
library ConditionalLiquidityProgramLib {
    /// @param extructionTarget Deployed {ConditionalLiquidityExtruction} instance.
    function build(address extructionTarget) internal pure returns (bytes memory) {
        return bytes.concat(XYCSwap.build(), Extruction.build(extructionTarget, ""));
    }
}
