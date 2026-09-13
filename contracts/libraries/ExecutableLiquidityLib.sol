// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IExecutableLiquidity } from "../venues/interfaces/IExecutableLiquidity.sol";
import { FixedPointMath } from "./FixedPointMath.sol";

/// @title ExecutableLiquidityLib
/// @notice Pure, deterministic integer arithmetic that turns a venue's *claimed* liquidity into
///         the amount it can actually deliver right now.
///
/// @dev This library exists because a quoted balance is not a solvent balance. On the Aqua side
///      this is not a theoretical concern: {IAqua} describes its balances as "allowances", `ship`
///      moves no tokens at all, and `pull` settles with
///      `IERC20(token).safeTransferFrom(maker, to, amount)` - straight out of the maker's own
///      wallet. A maker can therefore advertise a 100e18 virtual balance while holding 1e18 and
///      having revoked their approval. Routing against that advertised number is what this
///      protocol calls *phantom liquidity*, and every number below exists to make it unroutable.
///
/// @dev Deliberately pure and allocation-free: the solver calls into this on its settlement path,
///      where floating point, oracles and offchain scores are all forbidden. The only inputs are
///      values read live from chain state at the call site.
library ExecutableLiquidityLib {
    using FixedPointMath for uint256;

    /// @notice Build a fully-derived {IExecutableLiquidity.ExecutableLiquidity} from raw live reads.
    /// @param virtualLiquidity Liquidity the venue *advertises* (Aqua virtual balance, or an AMM's
    ///        maker-declared notional ceiling). Never trusted on its own.
    /// @param walletLiquidity Tokens the settling party actually holds right now.
    /// @param allowance Amount the settling party has actually approved to the pulling contract.
    /// @param liquidityBps The strategy's live conditional-liquidity multiplier, from the existing
    ///        rule engine. Applied *last*, so a conditional haircut can only ever shrink an
    ///        already-solvent amount - it can never be used to inflate one.
    function derive(
        uint256 virtualLiquidity,
        uint256 walletLiquidity,
        uint256 allowance,
        uint16 liquidityBps
    )
        internal
        pure
        returns (IExecutableLiquidity.ExecutableLiquidity memory out)
    {
        uint256 deliverable = min3(virtualLiquidity, walletLiquidity, allowance);

        out.virtualLiquidity = virtualLiquidity;
        out.walletLiquidity = walletLiquidity;
        out.allowance = allowance;
        out.deliverableLiquidity = deliverable;
        out.conditionalLiquidity = deliverable.mulBps(liquidityBps);
        out.coverageBps = coverageBps(deliverable, virtualLiquidity);
    }

    /// @notice Smallest of three values. The single chokepoint every solvency bound flows through.
    function min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        uint256 ab = a < b ? a : b;
        return ab < c ? ab : c;
    }

    /// @notice How much of the advertised liquidity is actually deliverable, in bps.
    /// @dev Clamped to `BPS` so a venue whose wallet exceeds its advertised balance still reports
    ///      100% rather than an above-100% figure that would make coverage useless as a ranking
    ///      signal. A zero advertised balance reports 0 (nothing to cover, nothing to trust)
    ///      rather than a vacuous 100%, so "no liquidity" and "fully covered liquidity" are never
    ///      confused by the UI or the offchain ranker.
    function coverageBps(uint256 deliverable, uint256 virtualLiquidity) internal pure returns (uint16) {
        if (virtualLiquidity == 0) {
            return 0;
        }
        uint256 bps = (deliverable * FixedPointMath.BPS) / virtualLiquidity;
        return uint16(bps > FixedPointMath.BPS ? FixedPointMath.BPS : bps);
    }
}
