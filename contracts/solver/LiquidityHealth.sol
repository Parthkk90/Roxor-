// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ILiquidityVenue } from "./interfaces/ILiquidityVenue.sol";
import { ISolver } from "./interfaces/ISolver.sol";
import { IExecutableLiquidity } from "../venues/interfaces/IExecutableLiquidity.sol";

/// @title LiquidityHealthLens
/// @notice Batched, stateless read of every venue's live depth, price, regime and solvency for one
///         token pair - the on-chain half of the Liquidity Health API.
///
/// @dev Deliberately a *lens*, not a component. It holds no storage, has no owner, no
///      initialiser and no privileged caller; it can only call `view` functions on venues the
///      caller names. Nothing in the protocol routes through it, so it cannot become a second
///      source of truth: deleting it would change no settlement behaviour. It exists purely so a
///      frontend or indexer can read what would otherwise be `2 * venues + 1` separate RPC round
///      trips - reads that must come from the *same block* to be coherent, which separate round
///      trips cannot guarantee.
///
/// @dev The values it returns are the same ones the Solver acts on, read the same way, which is
///      what lets the UI claim "this is what the solver sees" honestly rather than approximately.
contract LiquidityHealthLens {
    /// @notice One venue's complete public health record at the current block.
    /// @param snapshot The venue's live routing snapshot: depth, price, spread, regime, coverage.
    /// @param executable The solvency breakdown behind `snapshot.effectiveLiquidity`.
    /// @param healthy Whether the venue can currently absorb any flow at all. A convenience for
    ///        callers that just want to grey out a row; the numbers above are the real answer.
    struct VenueHealth {
        ILiquidityVenue.VenueSnapshot snapshot;
        IExecutableLiquidity.ExecutableLiquidity executable;
        bool healthy;
    }

    /// @notice Health records for every venue in `venues`, for `tokenIn -> tokenOut`.
    /// @dev A venue that reverts (unknown pair, docked strategy, a backend that has gone away) is
    ///      returned zeroed rather than being allowed to revert the whole batch. A marketplace
    ///      that goes blank because one maker misbehaved is worse than one that shows that maker
    ///      as offline - and "offline" is exactly what zero depth already means to the router.
    function health(ILiquidityVenue[] calldata venues, address tokenIn, address tokenOut) external view returns (VenueHealth[] memory out) {
        out = new VenueHealth[](venues.length);

        for (uint256 i = 0; i < venues.length; ++i) {
            try venues[i].snapshot(tokenIn, tokenOut) returns (ILiquidityVenue.VenueSnapshot memory snap) {
                out[i].snapshot = snap;
                out[i].healthy = snap.effectiveLiquidity > 0;
            } catch {
                out[i].snapshot.venue = address(venues[i]);
            }

            try venues[i].executableLiquidity(tokenIn, tokenOut) returns (IExecutableLiquidity.ExecutableLiquidity memory exec) {
                out[i].executable = exec;
            } catch { }
        }
    }

    /// @notice Total depth the marketplace can currently actually settle for this pair.
    /// @dev Sums `conditionalLiquidity`, never `virtualLiquidity`: the headline "market depth"
    ///      figure a UI shows must be the one a trader could really fill against, or the interface
    ///      itself becomes a source of phantom liquidity.
    function totalExecutableLiquidity(
        ILiquidityVenue[] calldata venues,
        address tokenIn,
        address tokenOut
    )
        external
        view
        returns (uint256 total)
    {
        for (uint256 i = 0; i < venues.length; ++i) {
            try venues[i].executableLiquidity(tokenIn, tokenOut) returns (IExecutableLiquidity.ExecutableLiquidity memory exec) {
                total += exec.conditionalLiquidity;
            } catch { }
        }
    }

    /// @notice Ask the solver for a plan without reverting, for quote-as-you-type UIs.
    /// @dev Returns `routable = false` instead of bubbling {ISolver.NoRoute}, so a frontend can
    ///      show "no route" as a state rather than having to parse a revert. The plan returned on
    ///      success is the real one the solver would build - but it is a *quote*, not a promise:
    ///      settlement re-derives and re-validates it against state at execution time.
    function tryRoute(
        ISolver solver,
        ISolver.TraderRequest calldata request
    )
        external
        view
        returns (bool routable, ISolver.ExecutionPlan memory plan)
    {
        try solver.route(request) returns (ISolver.ExecutionPlan memory p) {
            return (true, p);
        } catch {
            return (false, plan);
        }
    }
}
