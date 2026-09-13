// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { ISolver } from "./interfaces/ISolver.sol";
import { ILiquidityVenue } from "./interfaces/ILiquidityVenue.sol";
import { IExecutableLiquidity } from "../venues/interfaces/IExecutableLiquidity.sol";
import { FixedPointMath } from "../libraries/FixedPointMath.sol";

/// @title Solver
/// @notice Deterministic, non-AI router across a fixed set of {ILiquidityVenue}s for one token
///         pair. Owns no strategy/liquidity logic: every number it acts on comes from a venue's
///         own {ILiquidityVenue.snapshot}, which itself traces back to the existing
///         conditional-liquidity engine/registry (Aqua path) or hook (Uniswap v4 path).
///
/// @dev Ranking: venues are sorted by net-of-spread price, best first, then filled greedily up to
///      each venue's live `effectiveLiquidity` until the request is satisfied or venues run out.
///      This is optimal for "several flat-priced supply tranches, pick cheapest first" and is the
///      textbook deterministic algorithm the spec calls for (no AI dependency).
///
/// @dev Three layers of truth, never collapsed. An offchain indexer may *discover* and *rank*
///      candidates, but nothing offchain reaches this contract: `route` re-reads every venue live,
///      and `settle` then re-reads solvency a second time, immediately before moving tokens, via
///      {_revalidate}. That second read is not redundant with the first - it is the only thing
///      standing between a plan built one block ago and a maker who has since drained their wallet
///      or revoked their approval. Offchain scores, historical reliability and indexed coverage
///      are all inadmissible here by construction: this contract cannot even see them.
contract Solver is ISolver {
    using FixedPointMath for uint256;
    using SafeERC20 for IERC20;

    ILiquidityVenue[] private _venues;

    constructor(ILiquidityVenue[] memory venues_) {
        _venues = venues_;
    }

    function venues() external view returns (ILiquidityVenue[] memory) {
        return _venues;
    }

    /// @inheritdoc ISolver
    function route(TraderRequest calldata request) public view returns (ExecutionPlan memory plan) {
        uint256 n = _venues.length;
        ILiquidityVenue.VenueSnapshot[] memory snaps = new ILiquidityVenue.VenueSnapshot[](n);
        for (uint256 i = 0; i < n; ++i) {
            snaps[i] = _venues[i].snapshot(request.tokenIn, request.tokenOut);
        }

        // Selection sort by descending net-of-spread price (n is small: 2 venues in practice).
        for (uint256 i = 0; i < n; ++i) {
            uint256 bestIdx = i;
            uint256 bestPrice = _netPrice(snaps[i]);
            for (uint256 j = i + 1; j < n; ++j) {
                uint256 candidatePrice = _netPrice(snaps[j]);
                if (candidatePrice > bestPrice) {
                    bestIdx = j;
                    bestPrice = candidatePrice;
                }
            }
            if (bestIdx != i) {
                (snaps[i], snaps[bestIdx]) = (snaps[bestIdx], snaps[i]);
            }
        }

        // Total executable depth is summed in its own pass over every snapshot. Accumulating it
        // inside the fill loop instead would double-count any venue that the loop skips for zero
        // depth (a skip advances `i` but not `legCount`, so a trailing catch-up loop would add it
        // a second time) - and zero-depth venues are the normal case now that an insolvent maker
        // correctly reports nothing. This figure is the shortfall a caller sees in {NoRoute}, so
        // it has to be the honest total rather than an artefact of iteration order.
        uint256 totalExecutable = 0;
        for (uint256 i = 0; i < n; ++i) {
            totalExecutable += snaps[i].effectiveLiquidity;
        }

        RouteLeg[] memory legs = new RouteLeg[](n);
        uint256 legCount = 0;
        uint256 remaining = request.amount;
        uint256 totalExpectedOut = 0;

        for (uint256 i = 0; i < n && remaining > 0; ++i) {
            ILiquidityVenue.VenueSnapshot memory s = snaps[i];
            if (s.effectiveLiquidity == 0) {
                continue;
            }

            uint256 legAmountIn = remaining < s.effectiveLiquidity ? remaining : s.effectiveLiquidity;
            uint256 legAmountOut = _quoteOut(s, legAmountIn);

            legs[legCount++] = RouteLeg({ venue: s.venue, amountIn: legAmountIn, expectedAmountOut: legAmountOut, spreadBps: s.spreadBps });
            totalExpectedOut += legAmountOut;
            remaining -= legAmountIn;
        }

        if (remaining > 0) {
            revert NoRoute(request.tokenIn, request.tokenOut, request.amount, totalExecutable);
        }

        RouteLeg[] memory trimmedLegs = new RouteLeg[](legCount);
        for (uint256 i = 0; i < legCount; ++i) {
            trimmedLegs[i] = legs[i];
        }

        plan = ExecutionPlan({
            tokenIn: request.tokenIn,
            tokenOut: request.tokenOut,
            totalAmountIn: request.amount,
            totalExpectedAmountOut: totalExpectedOut,
            legs: trimmedLegs
        });

        uint256 minAcceptableOut = request.amount - request.amount.mulBps(request.maxSlippageBps);
        if (totalExpectedOut < minAcceptableOut) {
            revert SlippageExceeded(totalExpectedOut, minAcceptableOut);
        }
    }

    /// @inheritdoc ISolver
    function settle(TraderRequest calldata request, uint256 minTotalAmountOut) external returns (uint256 totalAmountOut) {
        ExecutionPlan memory plan = route(request);

        // Re-check solvency for every leg *before* any token moves, rather than per-leg inside the
        // loop. Checking up-front means the whole settlement is rejected atomically on a shortfall,
        // instead of half-filling a route and leaving the trader holding a partial position in a
        // market that just proved itself unreliable.
        uint256[] memory executable = _revalidate(plan, request.tokenIn, request.tokenOut);

        IERC20(request.tokenIn).safeTransferFrom(msg.sender, address(this), plan.totalAmountIn);

        for (uint256 i = 0; i < plan.legs.length; ++i) {
            RouteLeg memory leg = plan.legs[i];
            IERC20(request.tokenIn).safeTransfer(leg.venue, leg.amountIn);
            uint256 legOut = ILiquidityVenue(leg.venue).execute(request.tokenIn, request.tokenOut, leg.amountIn, 0, msg.sender);
            totalAmountOut += legOut;

            emit LegExecuted(
                msg.sender,
                leg.venue,
                ILiquidityVenue(leg.venue).snapshot(request.tokenIn, request.tokenOut).strategyId,
                leg.amountIn,
                legOut,
                executable[i],
                leg.spreadBps
            );
        }

        if (totalAmountOut < minTotalAmountOut) {
            revert SlippageExceeded(totalAmountOut, minTotalAmountOut);
        }

        emit PlanExecuted(msg.sender, keccak256(abi.encode(plan)), plan.totalAmountIn, totalAmountOut);
    }

    /// @notice Re-read each leg's venue solvency at settlement time and reject any leg that would
    ///         allocate more than the venue can actually deliver.
    /// @dev The no-phantom-liquidity invariant, `allocated <= executableLiquidity`, enforced on the
    ///      settlement path itself. Also rejects a plan that names the same venue twice: the greedy
    ///      builder never emits one, but a duplicate leg would let two individually-valid
    ///      allocations sum past a single venue's real depth, so it is refused rather than assumed
    ///      impossible.
    /// @return executable Each leg's revalidated executable depth, returned so the settlement loop
    ///         can report it without a third read of the same value.
    function _revalidate(ExecutionPlan memory plan, address tokenIn, address tokenOut) private view returns (uint256[] memory executable) {
        uint256 n = plan.legs.length;
        executable = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            RouteLeg memory leg = plan.legs[i];

            for (uint256 j = 0; j < i; ++j) {
                if (plan.legs[j].venue == leg.venue) {
                    revert DuplicateRouteLeg(leg.venue);
                }
            }

            IExecutableLiquidity.ExecutableLiquidity memory exec = ILiquidityVenue(leg.venue).executableLiquidity(tokenIn, tokenOut);
            if (leg.amountIn > exec.conditionalLiquidity) {
                revert ExecutableLiquidityShortfall(leg.venue, leg.amountIn, exec.conditionalLiquidity);
            }
            executable[i] = exec.conditionalLiquidity;
        }
    }

    /// @dev Price net of spread, scaled by BPS, used only to rank venues relative to each other.
    function _netPrice(ILiquidityVenue.VenueSnapshot memory s) private pure returns (uint256) {
        return s.referencePrice.applySpread(s.spreadBps);
    }

    /// @dev Expected output for `amountIn` at this snapshot's live price and spread.
    function _quoteOut(ILiquidityVenue.VenueSnapshot memory s, uint256 amountIn) private pure returns (uint256) {
        return (amountIn * s.referencePrice.applySpread(s.spreadBps)) / FixedPointMath.WAD;
    }
}
