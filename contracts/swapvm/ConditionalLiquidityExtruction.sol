// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { IConditionalLiquidityEngine } from "../engine/interfaces/IConditionalLiquidityEngine.sol";
import { IConditionalLiquidityRegistry } from "../core/interfaces/IConditionalLiquidityRegistry.sol";
import { IStrategyTypes } from "../core/interfaces/IStrategyTypes.sol";
import { IConditionalLiquidityExtruction } from "./interfaces/IConditionalLiquidityExtruction.sol";
import { FixedPointMath } from "../libraries/FixedPointMath.sol";

/// @title ConditionalLiquidityExtruction
/// @notice The SwapVM `Extruction` target that turns strategy state into an enforced execution
///         constraint. This is the seam where Parts 1-3 (registry, engine, compiler) meet SwapVM.
///
/// @dev PLACEMENT IN THE PROGRAM
///      A conditional-liquidity strategy's bytecode is:
///        DynamicBalances.build(reserveA, reserveB)   // sets balanceIn/balanceOut from Aqua state
///        XYCSwap.build()                              // curve computes amountIn/amountOut
///        Extruction.build(address(this), "")          // <- this contract, runs last
///      By running after the curve, this instruction never influences the *price* the curve
///      quotes - it only gates *how much* of that price a given trade may use, and applies the
///      strategy's spread as a final adjustment. Quote and swap therefore always agree on price;
///      they can only differ on whether a given size is currently permitted.
///
/// @dev QUOTE / SWAP SYMMETRY
///      SwapVM calls this contract through two different interfaces depending on whether it is
///      executing a quote() (static) or a swap() (mutating): see Extruction.exec in the swap-vm
///      package. Both interfaces share this contract's single "extruction" function selector; the
///      EVM enforces the static/mutating split for us via STATICCALL for the quote path, so this
///      function simply branches on isStaticContext and calls the engine's matching view/write
///      entry point ({IConditionalLiquidityEngine.preview} vs {IConditionalLiquidityEngine.poke}).
///      Attempting a write on the static path would revert at the EVM level regardless of what
///      this contract does, so the branch is not a trust boundary, only a gas optimisation
///      (poke's SSTORE is skipped when it would fail anyway).
///
/// @dev NO STATE OF ITS OWN
///      This contract holds no storage beyond its two immutables. It cannot be a point of
///      privilege escalation: it only ever forwards to the engine and registry, and the registry
///      independently enforces that only the engine may write runtime state.
contract ConditionalLiquidityExtruction is IStrategyTypes, IConditionalLiquidityExtruction {
    using FixedPointMath for uint256;

    IConditionalLiquidityEngine public immutable ENGINE;
    IConditionalLiquidityRegistry public immutable REGISTRY;

    constructor(IConditionalLiquidityEngine engine, IConditionalLiquidityRegistry registry) {
        ENGINE = engine;
        REGISTRY = registry;
    }

    /// @notice SwapVM Extruction entry point. Matches both IExtruction and IStaticExtruction from
    ///         the swap-vm package's Extruction instruction by selector; which one the router
    ///         calls determines whether the EVM permits state writes.
    function extruction(
        bool isStaticContext,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata, /* args */
        bytes calldata /* takerData */
    )
        external
        returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap)
    {
        // The registry key, Aqua's strategyHash and SwapVM's orderHash are one and the same value
        // by construction (see StrategyLib), so no extra lookup is needed to find our state.
        bytes32 strategyId = query.orderHash;
        require(REGISTRY.isActive(strategyId), StrategyNotActiveForExecution(strategyId));

        LiquidityConfig memory config;
        if (isStaticContext) {
            (, config) = ENGINE.preview(strategyId);
        } else {
            config = ENGINE.poke(strategyId);
        }

        updatedSwap = swap;

        if (query.isExactIn) {
            uint256 cap = swap.balanceIn.mulBps(config.liquidityBps);
            require(swap.amountIn <= cap, ExceedsEffectiveLiquidity(strategyId, swap.amountIn, cap));
            updatedSwap.amountOut = swap.amountOut.applySpread(config.spreadBps);
        } else {
            uint256 cap = swap.balanceOut.mulBps(config.liquidityBps);
            require(swap.amountOut <= cap, ExceedsEffectiveLiquidity(strategyId, swap.amountOut, cap));
            // Ceil so a taker requesting an exact output always pays at least the true spread,
            // mirroring XYCSwap's own "ceil division favors maker" convention for the !isExactIn case.
            updatedSwap.amountIn = Math.ceilDiv(swap.amountIn * FixedPointMath.BPS, FixedPointMath.BPS - config.spreadBps);
        }

        updatedNextPC = nextPC;
        choppedLength = 0;
    }
}
