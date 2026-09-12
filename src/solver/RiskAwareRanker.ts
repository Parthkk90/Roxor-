/**
 * Risk-aware candidate ranking and route construction — LAYER 2 of the three layers of truth.
 *
 * This is the *offchain* solver. It is allowed a richer view than the on-chain one: it can weigh
 * coverage, regime and historical reliability alongside price and depth. What it is not allowed to
 * do is matter. Its output is a proposal — the on-chain `Solver` re-derives the route from live
 * state and re-validates solvency before moving a token, so a bug, a stale index or an outright
 * malicious ranking here can cost a trader a worse route, but never a phantom fill.
 *
 * All arithmetic is integer and deterministic. Not because this code runs on-chain (it does not),
 * but so that the same inputs always produce the same route: a ranker that drifts with floating
 * point rounding produces routes that cannot be reproduced when someone asks why a trade went the
 * way it did, which makes Feature 11's explanations unfalsifiable.
 */
import { coverageBand } from "../analytics/coverage.js";
import { allocatableDepth } from "../analytics/reliability.js";
import type { StrategyModeName, VerifiedCandidate } from "../discovery/types.js";

const BPS = 10_000n;
const WAD = 1_000_000_000_000_000_000n;

/** Weights for the risk penalty. Tuned to be legible, not clever — every term is explainable. */
export interface RankingWeights {
  /** Penalty applied per 1 bps of coverage shortfall below 100%. */
  coveragePenaltyBps: number;
  /** Penalty applied per 1 bps of reliability shortfall below 100%. */
  reliabilityPenaltyBps: number;
  /** Flat penalties by regime: a DEFENSIVE maker is signalling caution, and is ranked accordingly. */
  modePenaltyBps: Record<StrategyModeName, number>;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  // Coverage dominates. A maker who can only deliver 80% of what they advertise is the exact
  // failure this marketplace exists to price, so it outweighs a few bps of nominal spread.
  coveragePenaltyBps: 3000,
  // Reliability matters less than coverage: it describes the past, while coverage describes now.
  reliabilityPenaltyBps: 1000,
  modePenaltyBps: { NORMAL: 0, DEFENSIVE: 50, RECOVERY: 20 },
};

export interface RankedCandidate {
  candidate: VerifiedCandidate;
  /** Net-of-spread WAD price, before any risk adjustment. */
  effectivePrice: bigint;
  /** `effectivePrice` after the risk penalty. The value the ranking actually sorts on. */
  riskAdjustedScore: bigint;
  /** Depth this candidate may be allocated. Always the live on-chain figure. */
  executableDepth: bigint;
  riskPenaltyBps: number;
  excluded: boolean;
  exclusionReason?: string;
}

export interface ProposedLeg {
  venueAddress: string;
  strategyId: string;
  maker: string;
  venue: string;
  amountIn: bigint;
  expectedAmountOut: bigint;
  spreadBps: number;
  coverageBps: number;
  mode: StrategyModeName;
}

export interface RouteProposal {
  tokenIn: string;
  tokenOut: string;
  requestedAmount: bigint;
  /** Amount the ranker could actually cover. Equals `requestedAmount` when `routable`. */
  allocatedAmount: bigint;
  routable: boolean;
  legs: ProposedLeg[];
  ranked: RankedCandidate[];
  totalExecutableLiquidity: bigint;
  /** Human-readable reasons, in the order a person would want to read them (Feature 11). */
  explanations: string[];
}

/** Net-of-spread price: `referencePrice * (10000 - spreadBps) / 10000`. */
export function effectivePrice(referencePrice: bigint, spreadBps: number): bigint {
  const spread = BigInt(Math.max(0, Math.min(spreadBps, 10_000)));
  return (referencePrice * (BPS - spread)) / BPS;
}

/**
 * Total risk penalty in bps for one verified candidate.
 *
 * Deliberately additive and bounded rather than multiplicative: an additive penalty stays legible
 * in an explanation ("80 bps of which 60 came from coverage"), while a product of factors does not.
 */
export function riskPenaltyBps(candidate: VerifiedCandidate, weights: RankingWeights = DEFAULT_WEIGHTS): number {
  const coverageShortfall = Math.max(0, 10_000 - candidate.executable.coverageBps);
  const reliabilityShortfall = Math.max(0, 10_000 - candidate.candidate.historicalFillRateBps);

  const coverage = Math.floor((coverageShortfall * weights.coveragePenaltyBps) / 10_000);
  const reliability = Math.floor((reliabilityShortfall * weights.reliabilityPenaltyBps) / 10_000);
  const mode = weights.modePenaltyBps[candidate.mode] ?? 0;

  // Capped below 100%: a penalty may sink a venue to last place, but must never invert its price
  // into a negative number, which would make an unreliable venue look attractive again.
  return Math.min(9_999, coverage + reliability + mode);
}

/** Rank verified candidates best-first. Excluded candidates are kept, so the UI can explain them. */
export function rankCandidates(
  candidates: VerifiedCandidate[],
  weights: RankingWeights = DEFAULT_WEIGHTS
): RankedCandidate[] {
  const ranked = candidates.map((candidate): RankedCandidate => {
    const depth = allocatableDepth(candidate.executable.conditionalLiquidity, candidate.candidate.historicalFillRateBps);
    const price = effectivePrice(candidate.referencePrice, candidate.spreadBps);
    const penalty = riskPenaltyBps(candidate);

    const base: RankedCandidate = {
      candidate,
      effectivePrice: price,
      riskAdjustedScore: (price * (BPS - BigInt(penalty))) / BPS,
      executableDepth: depth,
      riskPenaltyBps: penalty,
      excluded: depth <= 0n,
    };

    if (base.excluded) {
      base.exclusionReason = explainZeroDepth(candidate);
    }
    return base;
  });

  // Sort by risk-adjusted price descending (more tokenOut per tokenIn is better), with the venue
  // address as a tiebreak so two identically-priced venues always order the same way. Without the
  // tiebreak the route could flip between equal options run-to-run for no visible reason.
  return ranked.sort((a, b) => {
    if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
    if (a.riskAdjustedScore !== b.riskAdjustedScore) return a.riskAdjustedScore > b.riskAdjustedScore ? -1 : 1;
    return a.candidate.venueAddress.localeCompare(b.candidate.venueAddress);
  });
}

/** Why a candidate has no depth — the most common reason first, since they compound. */
function explainZeroDepth(candidate: VerifiedCandidate): string {
  const { executable } = candidate;
  const maker = shortAddress(candidate.candidate.maker);

  if (executable.walletLiquidity === 0n) {
    return `${maker} holds no ${"tokenIn"} in their wallet, so none of their advertised liquidity is deliverable.`;
  }
  if (executable.allowance === 0n) {
    return `${maker} has revoked their token approval, so Aqua cannot pull against their balance.`;
  }
  if (executable.virtualLiquidity === 0n) {
    return `${maker} has no liquidity shipped for this pair.`;
  }
  return `${maker} is currently quoting zero executable liquidity (mode ${candidate.mode}).`;
}

function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function formatAmount(amount: bigint, decimals = 18, precision = 2): string {
  const unit = 10n ** BigInt(decimals);
  const whole = amount / unit;
  const frac = ((amount % unit) * BigInt(10 ** precision)) / unit;
  return `${whole}.${frac.toString().padStart(precision, "0")}`;
}

/**
 * Build a greedy best-first route across ranked candidates.
 *
 * Greedy is correct here for the same reason it is on-chain: these are flat-priced supply tranches,
 * so taking as much as possible from the best-priced source before moving on is optimal. The
 * difference from the on-chain solver is only in the *ordering* — this one ranks on risk-adjusted
 * price rather than raw price — and that difference is exactly why the result is a proposal.
 */
export function buildRoute(
  tokenIn: string,
  tokenOut: string,
  requestedAmount: bigint,
  candidates: VerifiedCandidate[],
  weights: RankingWeights = DEFAULT_WEIGHTS,
  tokenInSymbol = "tokenIn"
): RouteProposal {
  const ranked = rankCandidates(candidates, weights);
  const explanations: string[] = [];
  const legs: ProposedLeg[] = [];

  let remaining = requestedAmount;
  let totalExecutable = 0n;

  for (const entry of ranked) {
    totalExecutable += entry.executableDepth;
  }

  for (const entry of ranked) {
    if (entry.excluded) {
      if (entry.exclusionReason) {
        explanations.push(entry.exclusionReason.replace("tokenIn", tokenInSymbol));
      }
      continue;
    }
    if (remaining <= 0n) {
      explanations.push(
        `${shortAddress(entry.candidate.candidate.maker)} was not needed: the request was already filled by better-ranked sources.`
      );
      continue;
    }

    const amountIn = remaining < entry.executableDepth ? remaining : entry.executableDepth;
    legs.push({
      venueAddress: entry.candidate.venueAddress,
      strategyId: entry.candidate.candidate.strategyId,
      maker: entry.candidate.candidate.maker,
      venue: entry.candidate.candidate.venue,
      amountIn,
      expectedAmountOut: (amountIn * entry.effectivePrice) / WAD,
      spreadBps: entry.candidate.spreadBps,
      coverageBps: entry.candidate.executable.coverageBps,
      mode: entry.candidate.mode,
    });

    explanations.push(explainSelection(entry, amountIn, tokenInSymbol));
    remaining -= amountIn;
  }

  const allocatedAmount = requestedAmount - remaining;
  const routable = remaining <= 0n;

  if (!routable) {
    explanations.push(
      `NO ROUTE: ${formatAmount(requestedAmount)} ${tokenInSymbol} requested but only ` +
        `${formatAmount(totalExecutable)} ${tokenInSymbol} is actually executable across all sources. ` +
        `The shortfall is real depth, not advertised depth — routing the difference would be phantom liquidity.`
    );
  }

  return {
    tokenIn,
    tokenOut,
    requestedAmount,
    allocatedAmount,
    routable,
    legs,
    ranked,
    totalExecutableLiquidity: totalExecutable,
    explanations,
  };
}

/** Feature 11: say *why* this source was chosen, in the terms a trader would ask about. */
function explainSelection(entry: RankedCandidate, amountIn: bigint, tokenInSymbol: string): string {
  const { candidate } = entry;
  const maker = shortAddress(candidate.candidate.maker);
  const amount = `${formatAmount(amountIn)} ${tokenInSymbol}`;
  const band = coverageBand(candidate.executable.coverageBps);

  const reasons: string[] = [`${(candidate.executable.coverageBps / 100).toFixed(0)}% coverage (${band})`];
  reasons.push(`${candidate.spreadBps} bps spread`);

  if (candidate.mode !== "NORMAL") {
    reasons.push(`${candidate.mode} mode`);
  }
  if (entry.riskPenaltyBps > 0) {
    reasons.push(`${entry.riskPenaltyBps} bps risk penalty applied`);
  }

  const capped = amountIn >= entry.executableDepth;
  const suffix = capped
    ? ` — filled to its full executable depth of ${formatAmount(entry.executableDepth)} ${tokenInSymbol}.`
    : ".";

  return `${maker} (${candidate.candidate.venue}) supplied ${amount}: ${reasons.join(", ")}${suffix}`;
}

/**
 * Explain a regime-driven change between two proposals, for the demo's before/after panel.
 *
 * Compares by strategy rather than by position, so a maker that dropped out of the route entirely
 * is still described instead of silently vanishing from the explanation.
 */
export function explainRouteChange(before: RouteProposal, after: RouteProposal, tokenInSymbol = "tokenIn"): string[] {
  const out: string[] = [];
  const beforeByStrategy = new Map(before.legs.map((leg) => [leg.strategyId, leg]));
  const afterByStrategy = new Map(after.legs.map((leg) => [leg.strategyId, leg]));

  for (const [strategyId, beforeLeg] of beforeByStrategy) {
    const afterLeg = afterByStrategy.get(strategyId);
    const maker = shortAddress(beforeLeg.maker);

    if (afterLeg == null) {
      out.push(
        `${maker} was excluded: it supplied ${formatAmount(beforeLeg.amountIn)} ${tokenInSymbol} before and nothing now.`
      );
      continue;
    }
    if (afterLeg.amountIn < beforeLeg.amountIn) {
      out.push(
        `${maker} was cut from ${formatAmount(beforeLeg.amountIn)} to ${formatAmount(afterLeg.amountIn)} ` +
          `${tokenInSymbol}${afterLeg.mode !== beforeLeg.mode ? ` after entering ${afterLeg.mode} mode` : ""}.`
      );
    } else if (afterLeg.amountIn > beforeLeg.amountIn) {
      out.push(
        `${maker} absorbed more flow, rising from ${formatAmount(beforeLeg.amountIn)} to ` +
          `${formatAmount(afterLeg.amountIn)} ${tokenInSymbol}.`
      );
    }
  }

  for (const [strategyId, afterLeg] of afterByStrategy) {
    if (!beforeByStrategy.has(strategyId)) {
      out.push(
        `${shortAddress(afterLeg.maker)} (${afterLeg.venue}) entered the route with ` +
          `${formatAmount(afterLeg.amountIn)} ${tokenInSymbol}.`
      );
    }
  }

  if (before.routable && !after.routable) {
    out.push(`The request is no longer fillable: executable depth fell to ${formatAmount(after.totalExecutableLiquidity)}.`);
  }

  return out;
}
