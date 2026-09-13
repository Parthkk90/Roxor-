// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ISolver
/// @notice Deterministic router across a fixed set of {ILiquidityVenue}s for a single token pair.
/// @dev Never invents liquidity: `route`/`settle` sum only each venue's live `effectiveLiquidity`
///      and revert {NoRoute} if that sum is short of the request, exactly like the underlying
///      backends hard-revert on `ExceedsEffectiveLiquidity` rather than silently truncating.
interface ISolver {
    /// @notice A trader's exact-in swap request.
    struct TraderRequest {
        address tokenIn;
        address tokenOut;
        uint256 amount;
        uint256 maxSlippageBps;
    }

    /// @notice One venue's slice of a route.
    struct RouteLeg {
        address venue;
        uint256 amountIn;
        uint256 expectedAmountOut;
        uint16 spreadBps;
    }

    /// @notice A fully-priced, ready-to-execute plan.
    struct ExecutionPlan {
        address tokenIn;
        address tokenOut;
        uint256 totalAmountIn;
        uint256 totalExpectedAmountOut;
        RouteLeg[] legs;
    }

    /// @notice Total effective liquidity across every registered venue for the pair is short of
    ///         `requested`. Carries the shortfall so callers/tests can assert on numbers.
    error NoRoute(address tokenIn, address tokenOut, uint256 requested, uint256 totalExecutable);

    /// @notice A leg would allocate more than the venue can actually settle *at settlement time*.
    /// @dev The no-phantom-liquidity invariant, enforced as a hard revert rather than a silent
    ///      truncation. Distinct from {NoRoute}: {NoRoute} means the market was never deep enough,
    ///      this means the market changed underneath a plan that was valid when it was built -
    ///      a maker's wallet drained, an approval was revoked, or the strategy shifted regime
    ///      between `route` and `settle`.
    error ExecutableLiquidityShortfall(address venue, uint256 allocated, uint256 executable);

    /// @notice A plan names the same venue in more than one leg.
    /// @dev Two legs against one venue each pass an individual solvency check while together
    ///      exceeding that venue's real depth, so duplicates are refused outright rather than
    ///      relied upon not to occur.
    error DuplicateRouteLeg(address venue);

    /// @notice The best executable plan's expected output falls short of the trader's stated
    ///         maximum slippage (`route`), or the actually-settled output falls short of the
    ///         caller's explicit floor (`settle`).
    error SlippageExceeded(uint256 expectedOrActualOut, uint256 minAcceptableOut);

    event PlanExecuted(address indexed trader, bytes32 indexed planHash, uint256 totalAmountIn, uint256 totalAmountOut);

    /// @notice One venue's slice of a settled plan, emitted per leg as it settles.
    /// @dev {PlanExecuted} alone reports only a total, which cannot be attributed back to the
    ///      venue that filled it. Reliability is a per-maker property, so the marketplace needs
    ///      per-leg attribution to compute it - hence a leg-level log alongside the plan-level one.
    ///      `executableLiquidity` is the venue's revalidated depth at settlement time, recorded so
    ///      an indexer can show how close each fill came to the venue's real ceiling without
    ///      having to re-derive it from an archive node.
    event LegExecuted(
        address indexed trader,
        address indexed venue,
        bytes32 indexed strategyId,
        uint256 amountIn,
        uint256 amountOut,
        uint256 executableLiquidity,
        uint16 spreadBps
    );

    /// @notice Compute the best executable plan for `request` across all registered venues.
    /// @dev Pure read/view computation: reverts {NoRoute} rather than returning a sentinel value,
    ///      and reverts {SlippageExceeded} if the plan's expected output is worse than
    ///      `request.maxSlippageBps` allows. Touches no state.
    function route(TraderRequest calldata request) external view returns (ExecutionPlan memory plan);

    /// @notice Compute and atomically execute the best plan in one transaction.
    /// @dev Always re-derives the plan from current on-chain state (never trusts a caller-supplied
    ///      plan), so the executed route is always consistent with reality at execution time.
    function settle(TraderRequest calldata request, uint256 minTotalAmountOut) external returns (uint256 totalAmountOut);
}
