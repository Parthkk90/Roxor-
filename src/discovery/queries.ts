/**
 * GraphQL documents for the discovery layer.
 *
 * Kept as plain strings in one file so they can be linted against `subgraph/schema.graphql` by eye
 * and reused by both the CLI and the frontend without pulling in a codegen step.
 */

/**
 * Active strategies for one unordered token pair.
 *
 * The pair is stored sorted on-chain (`tokenA < tokenB`) and is direction-agnostic - the taker
 * picks the direction at execution time - so this matches on the sorted pair and lets the caller
 * decide which side they are selling. Filtering on a *directed* pair here would silently hide
 * every maker willing to trade the other way.
 */
export const ACTIVE_STRATEGIES_FOR_PAIR = /* GraphQL */ `
  query ActiveStrategiesForPair($tokenA: Bytes!, $tokenB: Bytes!, $first: Int!) {
    strategies(
      where: { tokenIn: $tokenA, tokenOut: $tokenB, active: true }
      first: $first
      orderBy: updatedAt
      orderDirection: desc
    ) {
      id
      maker
      tokenIn
      tokenOut
      venue
      mode
      active
      liquidityBps
      spreadBps
      baseLiquidityBps
      baseSpreadBps
      updatedAt
      attemptedFills
      successfulFills
      volumeIn
      makerEntity {
        id
        reliabilityBps
        attemptedFills
        successfulFills
        volumeIn
      }
      snapshots(first: 1, orderBy: timestamp, orderDirection: desc) {
        virtualLiquidity
        effectiveLiquidity
        coverageBps
        spreadBps
        mode
        timestamp
      }
    }
  }
`;

/** Recent regime changes for one strategy, for the UI timeline and relapse detection. */
export const STRATEGY_TRANSITIONS = /* GraphQL */ `
  query StrategyTransitions($strategyId: Bytes!, $first: Int!) {
    stateTransitions(
      where: { strategy: $strategyId }
      first: $first
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      previousMode
      newMode
      triggerVolatilityBps
      timestamp
    }
  }
`;

/** Coverage history for one strategy - the raw material for reliability trend charts. */
export const STRATEGY_SNAPSHOTS = /* GraphQL */ `
  query StrategySnapshots($strategyId: Bytes!, $since: BigInt!, $first: Int!) {
    liquiditySnapshots(
      where: { strategy: $strategyId, timestamp_gte: $since }
      first: $first
      orderBy: timestamp
      orderDirection: desc
    ) {
      virtualLiquidity
      effectiveLiquidity
      coverageBps
      spreadBps
      mode
      timestamp
    }
  }
`;

/** Fill history for one maker, used to compute reliability over a bounded window. */
export const MAKER_FILL_HISTORY = /* GraphQL */ `
  query MakerFillHistory($maker: Bytes!, $since: BigInt!, $first: Int!) {
    maker(id: $maker) {
      id
      attemptedFills
      successfulFills
      failedFills
      volumeIn
      reliabilityBps
    }
    swaps(where: { trader_not: null, timestamp_gte: $since }, first: $first, orderBy: timestamp, orderDirection: desc) {
      id
      amountIn
      amountOut
      venue
      timestamp
      strategy {
        id
        maker
      }
    }
  }
`;

/** Recent settlements with their legs, for the route-history panel. */
export const RECENT_ROUTE_EXECUTIONS = /* GraphQL */ `
  query RecentRouteExecutions($first: Int!) {
    routeExecutions(first: $first, orderBy: timestamp, orderDirection: desc) {
      id
      trader
      planHash
      totalAmountIn
      totalAmountOut
      legCount
      timestamp
      legs {
        venue
        amountIn
        amountOut
      }
    }
  }
`;
