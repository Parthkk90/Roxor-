/**
 * Conditional Liquidity Marketplace - event handlers.
 *
 * LAYER 1 OF THREE. Everything written here is discovery, history and analytics. It is never a
 * settlement input, and two things follow from that which are easy to get wrong:
 *
 *   1. Indexed liquidity is an *advertisement*, not a balance. On the Aqua side a strategy's
 *      liquidity is an allowance against a maker's wallet, so a maker can go from "100 indexed"
 *      to "0 deliverable" without emitting anything at all. There is no event to index for that.
 *      Consumers must treat every liquidity field here as a lower-confidence hint and re-read the
 *      chain before acting.
 *
 *   2. Reliability is computed from what actually settled. A reverted settlement emits nothing -
 *      its logs are unwound with the rest of the call frame - so `failedFills` can only ever be
 *      inferred, never observed. It is therefore left at zero by the indexer and documented as
 *      such, rather than silently reported as a number that looks measured but is not.
 */
import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";

import {
  StrategyRegistered,
  StrategyActivated,
  StrategyDeactivated,
  StrategyStateChanged,
} from "../generated/AquaRegistry/ConditionalLiquidityRegistry";
import { StateTransition as StateTransitionEvent, LiquidityConfigurationChanged } from "../generated/AquaEngine/ConditionalLiquidityEngine";
import { ConditionalLiquidityApplied, HookStateTransition } from "../generated/ConditionalLiquidityHook/ConditionalLiquidityHook";
import { PlanExecuted, LegExecuted } from "../generated/Solver/Solver";

import { Strategy, Maker, Venue, LiquiditySnapshot, StateTransition, Swap, RouteExecution, RouteLeg } from "../generated/schema";

const BPS = BigInt.fromI32(10000);
const ZERO = BigInt.zero();

/** Mirrors `IStrategyTypes.StrategyMode`. The numeric values are part of the on-chain ABI. */
function modeLabel(mode: i32): string {
  if (mode == 0) return "NORMAL";
  if (mode == 1) return "DEFENSIVE";
  if (mode == 2) return "RECOVERY";
  return "UNKNOWN";
}

/** Deterministic child id: parent bytes + log index, so replays are stable. */
function eventId(event: ethereum.Event): Bytes {
  return event.transaction.hash.concatI32(event.logIndex.toI32());
}

function loadOrCreateMaker(address: Bytes, timestamp: BigInt): Maker {
  let maker = Maker.load(address);
  if (maker == null) {
    maker = new Maker(address);
    maker.attemptedFills = ZERO;
    maker.successfulFills = ZERO;
    maker.failedFills = ZERO;
    maker.volumeIn = ZERO;
    // No history yet is not evidence of unreliability. Seeding at 10000 keeps a brand-new maker
    // rankable on its live on-chain depth instead of being buried by a 0% score it never earned;
    // the executable-liquidity bound is what actually protects the trader either way.
    maker.reliabilityBps = BPS;
    maker.firstSeenAt = timestamp;
  }
  maker.lastActiveAt = timestamp;
  maker.save();
  return maker as Maker;
}

function loadOrCreateVenue(id: Bytes, kind: string): Venue {
  let venue = Venue.load(id);
  if (venue == null) {
    venue = new Venue(id);
    venue.kind = kind;
    venue.totalSwaps = ZERO;
    venue.volumeIn = ZERO;
    venue.save();
  }
  return venue as Venue;
}

/**
 * successfulFills * 10000 / attemptedFills, with no attempts reading as fully reliable.
 *
 * Ranking input only. A maker at 9910 with an empty wallet has zero executable liquidity, and the
 * solver must - and structurally does - treat them as unroutable regardless of this number.
 */
function recomputeReliability(maker: Maker): void {
  if (maker.attemptedFills.equals(ZERO)) {
    maker.reliabilityBps = BPS;
    return;
  }
  maker.reliabilityBps = maker.successfulFills.times(BPS).div(maker.attemptedFills);
}

/**
 * Record a point-in-time observation of a strategy's depth.
 *
 * `virtualLiquidity` is what the strategy advertises and `effectiveLiquidity` what the emitting
 * contract said was usable at that block. Where an event carries only one of the two (the registry
 * reports configuration, not amounts), the missing side is written as zero rather than guessed.
 */
function writeSnapshot(
  strategy: Strategy,
  virtualLiquidity: BigInt,
  effectiveLiquidity: BigInt,
  event: ethereum.Event
): void {
  const snapshot = new LiquiditySnapshot(eventId(event));
  snapshot.strategy = strategy.id;
  snapshot.maker = strategy.maker;
  snapshot.virtualLiquidity = virtualLiquidity;
  snapshot.effectiveLiquidity = effectiveLiquidity;
  snapshot.coverageBps = virtualLiquidity.equals(ZERO)
    ? ZERO
    : minBigInt(effectiveLiquidity.times(BPS).div(virtualLiquidity), BPS);
  snapshot.spreadBps = strategy.spreadBps;
  snapshot.mode = strategy.mode;
  snapshot.timestamp = event.block.timestamp;
  snapshot.block = event.block.number;
  snapshot.save();
}

function minBigInt(a: BigInt, b: BigInt): BigInt {
  return a.lt(b) ? a : b;
}

/* ------------------------------------------------------------------ registry */

export function handleStrategyRegistered(event: StrategyRegistered): void {
  const id = event.params.strategyId;
  const maker = loadOrCreateMaker(event.params.maker, event.block.timestamp);
  const venue = loadOrCreateVenue(event.address, "aqua");

  const strategy = new Strategy(id);
  strategy.maker = event.params.maker;
  // The pair is stored sorted and direction-agnostic on-chain (tokenA < tokenB); direction is
  // chosen by the taker at execution time. `tokenIn`/`tokenOut` here therefore mean "side A" and
  // "side B", not a fixed trade direction - discovery queries must filter on the unordered pair.
  strategy.tokenIn = event.params.tokenA;
  strategy.tokenOut = event.params.tokenB;
  strategy.venue = venue.kind;
  strategy.mode = "NORMAL";
  strategy.active = true;
  strategy.baseLiquidityBps = ZERO;
  strategy.baseSpreadBps = ZERO;
  strategy.liquidityBps = ZERO;
  strategy.spreadBps = ZERO;
  strategy.createdAt = event.block.timestamp;
  strategy.updatedAt = event.block.timestamp;
  strategy.makerEntity = maker.id;
  strategy.venueEntity = venue.id;
  strategy.attemptedFills = ZERO;
  strategy.successfulFills = ZERO;
  strategy.failedFills = ZERO;
  strategy.volumeIn = ZERO;
  strategy.save();
}

export function handleStrategyActivated(event: StrategyActivated): void {
  const strategy = Strategy.load(event.params.strategyId);
  if (strategy == null) return;
  strategy.active = true;
  strategy.updatedAt = event.block.timestamp;
  strategy.save();
}

export function handleStrategyDeactivated(event: StrategyDeactivated): void {
  const strategy = Strategy.load(event.params.strategyId);
  if (strategy == null) return;
  strategy.active = false;
  strategy.updatedAt = event.block.timestamp;
  strategy.save();
}

export function handleStrategyStateChanged(event: StrategyStateChanged): void {
  const strategy = Strategy.load(event.params.strategyId);
  if (strategy == null) return;

  strategy.mode = modeLabel(event.params.newMode);
  strategy.liquidityBps = BigInt.fromI32(event.params.liquidityBps);
  strategy.spreadBps = BigInt.fromI32(event.params.spreadBps);
  strategy.updatedAt = event.block.timestamp;
  strategy.save();
}

/* ------------------------------------------------------------------ engine */

export function handleStateTransition(event: StateTransitionEvent): void {
  const strategy = Strategy.load(event.params.strategyId);
  if (strategy == null) return;

  const transition = new StateTransition(eventId(event));
  transition.strategy = strategy.id;
  transition.previousMode = modeLabel(event.params.previousMode);
  transition.newMode = modeLabel(event.params.newMode);
  transition.triggerVolatilityBps = event.params.triggerVolatilityBps;
  transition.timestamp = event.block.timestamp;
  transition.block = event.block.number;
  transition.txHash = event.transaction.hash;
  transition.save();

  strategy.mode = transition.newMode;
  strategy.updatedAt = event.block.timestamp;
  strategy.save();
}

export function handleLiquidityConfigurationChanged(event: LiquidityConfigurationChanged): void {
  const strategy = Strategy.load(event.params.strategyId);
  if (strategy == null) return;

  strategy.liquidityBps = BigInt.fromI32(event.params.liquidityBps);
  strategy.spreadBps = BigInt.fromI32(event.params.spreadBps);
  strategy.updatedAt = event.block.timestamp;
  strategy.save();

  writeSnapshot(strategy as Strategy, ZERO, ZERO, event);
}

/* ------------------------------------------------------------------ uniswap v4 hook */

export function handleConditionalLiquidityApplied(event: ConditionalLiquidityApplied): void {
  const strategy = Strategy.load(event.params.strategyId);
  if (strategy == null) return;

  strategy.mode = modeLabel(event.params.currentMode);
  strategy.spreadBps = BigInt.fromI32(event.params.effectiveSpreadBps);
  strategy.venue = "uniswap-v4";
  strategy.attemptedFills = strategy.attemptedFills.plus(BigInt.fromI32(1));
  strategy.successfulFills = strategy.successfulFills.plus(BigInt.fromI32(1));
  strategy.volumeIn = strategy.volumeIn.plus(event.params.requestedAmount);
  strategy.updatedAt = event.block.timestamp;
  strategy.save();

  const maker = loadOrCreateMaker(strategy.maker, event.block.timestamp);
  maker.attemptedFills = maker.attemptedFills.plus(BigInt.fromI32(1));
  maker.successfulFills = maker.successfulFills.plus(BigInt.fromI32(1));
  maker.volumeIn = maker.volumeIn.plus(event.params.requestedAmount);
  recomputeReliability(maker);
  maker.save();

  // The hook reports the requested amount and the ceiling it was checked against, not an output
  // amount - pricing happens inside the pool, not in the conditional layer. `amountOut` is left
  // at zero rather than being back-derived from a spread, which would be a fabricated number.
  const swap = new Swap(eventId(event));
  swap.strategy = strategy.id;
  swap.trader = event.transaction.from;
  swap.tokenIn = strategy.tokenIn;
  swap.tokenOut = strategy.tokenOut;
  swap.amountIn = event.params.requestedAmount;
  swap.amountOut = ZERO;
  swap.venue = "uniswap-v4";
  swap.timestamp = event.block.timestamp;
  swap.block = event.block.number;
  swap.txHash = event.transaction.hash;
  swap.save();

  writeSnapshot(strategy as Strategy, event.params.effectiveLiquidity, event.params.effectiveLiquidity, event);
}

export function handleHookStateTransition(event: HookStateTransition): void {
  const strategy = Strategy.load(event.params.strategyId);
  if (strategy == null) return;

  const transition = new StateTransition(eventId(event));
  transition.strategy = strategy.id;
  transition.previousMode = modeLabel(event.params.previousMode);
  transition.newMode = modeLabel(event.params.newMode);
  transition.triggerVolatilityBps = ZERO; // the hook does not carry the trigger value
  transition.timestamp = event.block.timestamp;
  transition.block = event.block.number;
  transition.txHash = event.transaction.hash;
  transition.save();

  strategy.mode = transition.newMode;
  strategy.updatedAt = event.block.timestamp;
  strategy.save();
}

/* ------------------------------------------------------------------ solver */

/**
 * A settlement is exactly one `Solver.settle` call, so the transaction hash is its natural id.
 *
 * The legs are emitted *before* the plan-level event within that same transaction, which means
 * whichever handler runs first has to be the one that creates the entity. Both therefore
 * load-or-create against the same id and fill in only their own half - ordering-independent by
 * construction rather than by assumption.
 */
function loadOrCreateExecution(event: ethereum.Event): RouteExecution {
  let execution = RouteExecution.load(event.transaction.hash);
  if (execution == null) {
    execution = new RouteExecution(event.transaction.hash);
    execution.trader = event.transaction.from;
    execution.planHash = Bytes.empty();
    execution.totalAmountIn = ZERO;
    execution.totalAmountOut = ZERO;
    execution.legCount = ZERO;
    execution.timestamp = event.block.timestamp;
    execution.block = event.block.number;
    execution.txHash = event.transaction.hash;
    execution.save();
  }
  return execution as RouteExecution;
}

export function handlePlanExecuted(event: PlanExecuted): void {
  const execution = loadOrCreateExecution(event);
  execution.trader = event.params.trader;
  execution.planHash = event.params.planHash;
  execution.totalAmountIn = event.params.totalAmountIn;
  execution.totalAmountOut = event.params.totalAmountOut;
  execution.save();
}

export function handleLegExecuted(event: LegExecuted): void {
  const venue = loadOrCreateVenue(event.params.venue, "solver-leg");
  venue.totalSwaps = venue.totalSwaps.plus(BigInt.fromI32(1));
  venue.volumeIn = venue.volumeIn.plus(event.params.amountIn);
  venue.save();

  const execution = loadOrCreateExecution(event);
  execution.legCount = execution.legCount.plus(BigInt.fromI32(1));
  execution.save();

  const leg = new RouteLeg(eventId(event));
  leg.execution = execution.id;
  leg.venue = event.params.venue;
  leg.amountIn = event.params.amountIn;
  leg.amountOut = event.params.amountOut;
  leg.save();

  const strategy = Strategy.load(event.params.strategyId);
  if (strategy == null) return;

  strategy.attemptedFills = strategy.attemptedFills.plus(BigInt.fromI32(1));
  strategy.successfulFills = strategy.successfulFills.plus(BigInt.fromI32(1));
  strategy.volumeIn = strategy.volumeIn.plus(event.params.amountIn);
  strategy.updatedAt = event.block.timestamp;
  strategy.save();

  const maker = loadOrCreateMaker(strategy.maker, event.block.timestamp);
  maker.attemptedFills = maker.attemptedFills.plus(BigInt.fromI32(1));
  maker.successfulFills = maker.successfulFills.plus(BigInt.fromI32(1));
  maker.volumeIn = maker.volumeIn.plus(event.params.amountIn);
  recomputeReliability(maker);
  maker.save();

  const swap = new Swap(eventId(event));
  swap.strategy = strategy.id;
  swap.trader = event.params.trader;
  swap.tokenIn = strategy.tokenIn;
  swap.tokenOut = strategy.tokenOut;
  swap.amountIn = event.params.amountIn;
  swap.amountOut = event.params.amountOut;
  swap.venue = strategy.venue;
  swap.timestamp = event.block.timestamp;
  swap.block = event.block.number;
  swap.txHash = event.transaction.hash;
  swap.save();

  // `executableLiquidity` is the revalidated ceiling at settlement time, so this snapshot records
  // real solvency rather than an advertisement - the highest-confidence liquidity observation the
  // index ever gets, and still not a quote.
  writeSnapshot(strategy as Strategy, event.params.executableLiquidity, event.params.executableLiquidity, event);
}
