// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { XYCSwap } from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import { Salt } from "@1inch/swap-vm/src/instructions/Controls.sol";

import { MockERC20 } from "../../contracts/mocks/MockERC20.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";

/// @notice Builds real SwapVM orders for tests.
/// @dev Everything here goes through the protocol's own `MakerTraitsLib.build` and instruction
///      builders. Nothing hand-rolls the order encoding or an opcode byte, so if 1inch changes
///      either, these fixtures break loudly at compile time instead of drifting.
abstract contract OrderFixture is Test {
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;

    function _deployPair() internal {
        MockERC20 first = new MockERC20("Wrapped Ether", "WETH", 18);
        MockERC20 second = new MockERC20("USD Coin", "USDC", 6);
        // Sort so the pair satisfies MakerTraitsLib's tokenA < tokenB requirement.
        (address a, address b) = StrategyLib.sortTokens(address(first), address(second));
        tokenA = MockERC20(a);
        tokenB = MockERC20(b);
    }

    /// @notice A plain Aqua-backed constant-product program.
    /// @dev No Balances instruction: an Aqua-backed order's balances come from `AQUA.safeBalances`,
    ///      set by SwapVM itself before the program runs (see `ConditionalLiquidityProgramLib`).
    function _defaultProgram() internal pure returns (bytes memory) {
        return XYCSwap.build();
    }

    /// @notice Same program, distinguished only by an embedded salt. Lets a test vary bytecode
    ///         (and therefore the derived order hash) without implying reserves are encoded here.
    function _defaultProgram(uint64 salt) internal pure returns (bytes memory) {
        return bytes.concat(XYCSwap.build(), Salt.build(salt));
    }

    /// @notice Build an Aqua-backed order for `maker` over the fixture's token pair.
    function _buildOrder(address maker, bytes memory program) internal view returns (ISwapVM.Order memory) {
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = address(tokenA);
        args.tokenB = address(tokenB);
        args.useAquaInsteadOfSignature = true;
        args.program = program;
        return MakerTraitsLib.build(args);
    }

    function _buildOrder(address maker) internal view returns (ISwapVM.Order memory) {
        return _buildOrder(maker, _defaultProgram());
    }
}
