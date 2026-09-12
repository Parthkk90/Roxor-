// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { IStrategyTypes } from "../core/interfaces/IStrategyTypes.sol";
import { FixedPointMath } from "./FixedPointMath.sol";

/// @title StrategyLib
/// @notice Strategy identity and the protocol-wide safety bounds.
///
/// @dev IDENTITY
///      A conditional-liquidity strategy is not a new object with its own id. It is additional
///      behaviour attached to a SwapVM order that is backed by Aqua liquidity. Three independent
///      systems already derive an identifier for that order, and they all agree:
///
///        Aqua.ship(app, strategy, ...)   -> strategyHash = keccak256(strategy)
///        SwapVM.hash(order)              -> orderHash    = keccak256(abi.encode(order))
///                                           (Aqua branch; the EIP-712 branch is used only for
///                                            signature-backed orders)
///        StrategyLib.strategyId(order)   -> keccak256(abi.encode(order))
///
///      A maker ships with `strategy = abi.encode(order)`, so Aqua's `strategyHash`, SwapVM's
///      `ctx.query.orderHash` and this registry's key are the *same 32 bytes*. That is what lets
///      an Extruction target look up our runtime state using only `ctx.query.orderHash`, with no
///      extra plumbing and nothing for a caller to spoof.
library StrategyLib {
    /// @notice Largest addressable SwapVM program.
    /// @dev SwapVM jump instructions (`Jump`, `JumpIfDirection`, `JumpIfTokenIn`, `JumpIfTokenOut`)
    ///      encode their target as a `uint16`. A longer program still executes, but its tail
    ///      becomes unreachable by any jump, so we refuse to register one.
    uint256 internal constant MAX_PROGRAM_SIZE = 65_535;

    /// @notice Largest argument blob a single SwapVM instruction can carry.
    /// @dev The run loop reads the args length from one byte of the instruction header.
    uint256 internal constant MAX_INSTRUCTION_ARGS = 255;

    /// @notice Liquidity multiplier bounds, in bps.
    /// @dev The upper bound is 100%: a strategy may only ever *reduce* the liquidity a maker has
    ///      committed through Aqua. Allowing >100% would let a strategy quote against balances the
    ///      maker never shipped.
    uint16 internal constant MIN_LIQUIDITY_BPS = 0;
    uint16 internal constant MAX_LIQUIDITY_BPS = uint16(FixedPointMath.BPS);

    /// @notice Spread bounds, in bps. Capped well below 100% so a strategy cannot expropriate a taker.
    uint16 internal constant MIN_SPREAD_BPS = 0;
    uint16 internal constant MAX_SPREAD_BPS = 5000;

    /// @notice Derive the canonical strategy identifier for a SwapVM order.
    /// @dev Must stay byte-identical to `SwapVM.hash()` on its Aqua branch and to the digest
    ///      `Aqua.ship` computes over `abi.encode(order)`.
    function strategyId(ISwapVM.Order calldata order) internal pure returns (bytes32) {
        return keccak256(abi.encode(order));
    }

    /// @notice Memory overload of {strategyId}, for callers that built the order locally.
    function strategyIdMemory(ISwapVM.Order memory order) internal pure returns (bytes32) {
        return keccak256(abi.encode(order));
    }

    /// @notice Sort a token pair into the ordering SwapVM's `MakerTraitsLib.build` requires.
    function sortTokens(address tokenX, address tokenY) internal pure returns (address tokenA, address tokenB) {
        return tokenX < tokenY ? (tokenX, tokenY) : (tokenY, tokenX);
    }
}
