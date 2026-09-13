# Conditional Liquidity Marketplace

Discovery, risk-aware routing, and atomic settlement across Aqua/SwapVM and Uniswap v4 - with one
governing rule: **no phantom liquidity**.

## The problem this solves

Aqua describes itself as enabling "shared liquidity access directly from maker wallets", and that
is literally how it works:

- `Aqua.ship(...)` records balances and **transfers no tokens**.
- `Aqua.pull(...)` settles with `IERC20(token).safeTransferFrom(maker, to, amount)`.

So an Aqua "balance" is an *allowance against a maker's wallet*, not custody. Three things can
make it undeliverable, and none of them emit an event:

1. the maker spends or moves their tokens elsewhere,
2. the maker reduces or revokes their ERC20 approval to Aqua,
3. the strategy's own conditional rules shrink what it is willing to quote.

Before this work, `AquaVenue.snapshot` derived `effectiveLiquidity` from the Aqua virtual balance
alone. A maker could therefore advertise 100 tokens while holding 1, the solver would route the
full 100, and settlement would revert inside `transferFrom`. That gap is *phantom liquidity*.

## Three layers of truth

Never collapsed. Each layer is allowed to be wrong without costing anyone money, except the last.

| Layer | Component | Authoritative for |
|---|---|---|
| 1 - Graph | `subgraph/`, `src/discovery/` | which venues exist, history, ranking hints |
| 2 - Solver | `src/solver/RiskAwareRanker.ts` | candidate ranking, split allocation |
| 3 - Chain | `contracts/solver/Solver.sol`, venue adapters | executable liquidity, slippage, settlement |

A malicious index, a stale snapshot or a buggy offchain ranker can cost a trader a *worse* route.
None of them can cost a trader a *failed* one, because layer 3 re-derives everything.

## Executable liquidity

`contracts/libraries/ExecutableLiquidityLib.sol`, pure integer arithmetic:

```
deliverableLiquidity   = min(virtualLiquidity, walletLiquidity, allowance)
conditionalLiquidity   = deliverableLiquidity * liquidityBps / 10000
coverageBps            = min(deliverableLiquidity * 10000 / virtualLiquidity, 10000)
```

Two ordering decisions matter:

- The conditional multiplier is applied to **deliverable**, not advertised, depth. Applying it to
  the advertisement would quote 25 against a wallet that can only pay 10.
- `coverageBps` is `0` when nothing is advertised, not `10000`. "Nothing to deliver" and "fully
  covered" must not share a number, or a UI will badge an empty maker as HEALTHY.

### Per-venue solvency models

| | Aqua | Uniswap v4 |
|---|---|---|
| `virtualLiquidity` | maker's Aqua balance (an allowance) | hook's conditionally-adjusted ceiling |
| `walletLiquidity` | maker's wallet balance | PoolManager's real reserves |
| `allowance` | maker → Aqua approval | `type(uint256).max` (pool holds its own reserves) |

A v4 pool is structurally solvent - its tokens are already in custody, with no third party to run
dry. A healthy pool naturally shows 100% coverage while a drained maker does not, and that
difference is a real property of the two backends, not a modelling artefact.

## Coverage bands

Presentation and analytics only (`src/analytics/coverage.ts`). Deliberately **not** an on-chain
enum - an enum there would invite treating a display bucket as a safety control.

| Coverage | Band |
|---|---|
| ≥ 9000 bps | HEALTHY |
| ≥ 7000 bps | DEGRADED |
| ≥ 3000 bps | FRAGILE |
| < 3000 bps | UNRELIABLE |

## Settlement path

`Solver.settle` does three independent things, in this order:

1. `route(request)` - re-reads every venue live. The caller's plan is never trusted.
2. `_revalidate(plan)` - re-reads `executableLiquidity` per leg **before any token moves**, and
   reverts `ExecutableLiquidityShortfall` if `allocated > executable`. Also rejects duplicate legs,
   which would let two individually-valid allocations sum past one venue's real depth.
3. Push-then-execute each leg, then enforce `minTotalAmountOut`.

Step 2 is not redundant with step 1. It is the only thing standing between a plan built one block
ago and a maker who has since drained their wallet. Checking up-front rather than per-leg means a
shortfall rejects the whole settlement atomically instead of half-filling a route.

## Historical reliability

`reliabilityBps = successfulFills * 10000 / attemptedFills`, from the index only.

The hard rule, enforced by `allocatableDepth` in `src/analytics/reliability.ts`: reliability can
only ever **de-rank**. A maker with 99% historical reliability and an empty wallet has zero
executable liquidity. Reliability describes the past; the past cannot pay for a trade.

A maker with no attempts reads as fully reliable rather than 0% - a fresh maker has not earned
distrust, and it costs traders nothing because solvency is enforced independently.

## Running the demo

**Live on Ethereum Sepolia.** Addresses, the audit that produced them, the liquidity breakdown and
every transaction hash: [`sepolia-deployment.md`](sepolia-deployment.md). The figures in
*Executable liquidity* above are not hypothetical there - the Aqua maker advertises ~104 DTB and can
deliver 8, and a real settlement split 5 DTB across both venues in
`0xb55c0a7d792fecc4ef264620022574737448f5621237ad78b282abec67272009`.

Locally, see **Local demo procedure (anvil)** in the top-level `README.md`, which deploys three
markets parked in three different regimes.
