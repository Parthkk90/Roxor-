# Conditional Liquidity - Architecture

How the system is built, and why it is built that way. This documents what exists; for the
narrative explainer of the marketplace layer see [`marketplace.md`](./marketplace.md), and for
backend-specific notes see [`uniswap-v4.md`](./uniswap-v4.md) and
[`aqua-swapvm-production-fork.md`](./aqua-swapvm-production-fork.md).

## The system in one line

> A programmable conditional-liquidity system where one strategy controls liquidity across
> multiple execution venues, and a solver routes trades through the liquidity that **remains
> executable** under current market conditions.

Parts 1–5 build the conditional-liquidity infrastructure. Part 6 turns it into a marketplace with a
deterministic solver. Part 7 makes that marketplace *honest* - it distinguishes liquidity a venue
**advertises** from liquidity it can **actually deliver**, and makes routing against the difference
structurally impossible.

> **NO PHANTOM LIQUIDITY.**

Every part is additive. Parts 1–5 have never been rewritten.

```text
PART 1  Strategy Registry                                   DONE
PART 2  Strategy Validator                                  DONE
PART 3  Runtime State / State Machine                       DONE
PART 4  Strategy IR + Rule Engine + Aqua/SwapVM             DONE
PART 5  Uniswap v4 Conditional Liquidity Hook               DONE
PART 6  Solver + Venue Abstraction                          DONE
PART 7  Conditional Liquidity Marketplace                   DONE
```

---

# Part 1 - Strategy Registry

`contracts/core/ConditionalLiquidityRegistry.sol` ·
`contracts/core/interfaces/IConditionalLiquidityRegistry.sol`

The on-chain registry of conditional-liquidity strategies. It stores strategy definitions, tracks
ownership and active status, and provides lookup for the execution layer.

```text
ConditionalLiquidityRegistry
       |
       v
   Strategy + RuntimeState
```

**The `strategyId` is derived from the SwapVM order, not chosen by the caller.** This is the key
design decision: it guarantees the registry's `strategyId` equals the `orderHash` SwapVM presents
at execution time *and* Aqua's `strategyHash` for the same order. The three identifiers cannot
drift, because they are the same value by construction. `registerStrategy` requires
`msg.sender == order.maker`.

The compiled rule program is stored **in full**, not hashed, for data availability: any indexer or
solver can reproduce a strategy's behaviour from chain state alone.

Runtime state is writable only by the **state authority** (the engine). Makers and takers can never
write state directly - they can only cause a transition by executing a swap, which routes through
the engine.

Tested by `test/unit/ConditionalLiquidityRegistry.t.sol`.

---

# Part 2 - Strategy Validator

`contracts/core/StrategyValidator.sol` · `contracts/core/interfaces/IStrategyValidator.sol`

Validates a strategy is structurally and semantically sound before it can execute: parameters, rule
configuration, transition thresholds, liquidity and spread bounds, timing requirements.

The governing property: **invalid strategies must not reach the execution layer.** Validation
happens at registration, so the execution path never carries defensive checks for states the
validator already made unreachable.

Tested by `test/unit/StrategyValidator.t.sol`.

---

# Part 3 - Strategy / Runtime State Engine

`contracts/core/interfaces/IStrategyTypes.sol` · `contracts/engine/ConditionalLiquidityEngine.sol`

The immutable strategy definition is separated from its changing runtime state.

```text
Strategy (immutable)            RuntimeState (mutable)
├── thresholds                  ├── current mode
├── liquidity rules             ├── last transition
├── spread rules                ├── timestamps
├── hysteresis                  ├── cumulative volume
└── recovery conditions         └── armed rule + armedSince
```

## The state machine

```text
NORMAL
   |
   | market shock
   v
DEFENSIVE
   |
   | recovery condition (sustained)
   v
RECOVERY
   |
   | sustained recovery
   v
NORMAL
```

It respects hysteresis, sustained-duration conditions, recovery thresholds, and deterministic
transitions.

**Hysteresis uses two different thresholds, not one** - and that is the whole point. In the
canonical volatility-shield strategy, entering DEFENSIVE needs volatility ≥ 50%, but leaving it
needs volatility < 30%. Between 30% and 50% the strategy holds its current mode, so a market
oscillating around a single threshold cannot make it flap.

**Shocks fire immediately; recoveries must be sustained.** A crash should not wait out a timer, but
a single quiet sample is not evidence of calm. Leaving DEFENSIVE requires the calm condition to hold
continuously for a configured period, tracked by `armedRule`/`armedSince`.

## Engine split

`ConditionalLiquidityEngine` is a stateful shell around a pure core, and the split is deliberate:

- `RuleEngineLib` decides **what** the new state is. Pure, no I/O.
- The engine performs the I/O: read registry, read oracle, write registry.

Keeping the decision pure is what guarantees SwapVM's `quote()` (static context) and `swap()`
(mutating context) resolve to the same configuration. `preview()` is the read-only twin of `poke()`
and returns exactly what `poke()` would commit for the same block.

`poke()` is permissionless. Advancing the state machine is a pure function of oracle data and stored
state, so a caller cannot steer the outcome by calling at will - they can only pay gas to bring a
strategy up to date.

Tested by `test/unit/ConditionalLiquidityEngine.t.sol`, `test/integration/MarketShock.t.sol`.

---

# Part 4 - Strategy IR + Rule Engine + Aqua / SwapVM

The programmable conditional-liquidity execution layer.

## 4.1 RuleEngineLib

`contracts/libraries/RuleEngineLib.sol` · `contracts/libraries/RuleProgram.sol`

```text
MarketState + RuntimeState + Strategy
                  |
                  v
            RuleEngineLib   (pure)
                  |
                  +----> EffectiveLiquidity
                  +----> EffectiveSpread
                  +----> NextState
```

The result is deterministic. Rules are evaluated in order, so ordering encodes priority - a fresh
shock during RECOVERY is placed before the recovery timer specifically so relapse beats the clock.

## 4.2 Fixed-point convention

`contracts/libraries/FixedPointMath.sol`

Exactly two scales exist and they are never mixed implicitly:

- **BPS** (10,000 = 100%) for ratios: liquidity multipliers, spreads, volatility, price changes.
- **WAD** (1e18 = 1.0) for absolute prices.

One convention is what lets the DSL compiler, the Solidity engine, and the Python reference model
agree bit-for-bit. `mulBps` rounds **down** deliberately: every call site uses it to shrink an
amount, so rounding down always favours the maker.

## 4.3 TypeScript DSL / compiler

`src/compiler/` · `src/cli.ts` · `examples/volatility-shield.clf`

```text
TypeScript DSL  ->  Strategy IR  ->  +-- SwapVM
                                     +-- Uniswap v4
```

The property that matters:

> One strategy definition has one semantic meaning regardless of execution backend.

Lexer, parser, semantic analysis, and an optimizer lower a `.clf` file into `RuleProgram` bytecode.
Enum values in `src/types/index.ts` are part of the on-chain ABI and are emitted directly into
bytecode that `RuleProgram.sol` decodes - they must never be reordered.

## 4.4 Deterministic bytecode

The compiler produces deterministic bytecode, and the Solidity and TypeScript encoders produce
byte-identical results. A Python reference implementation lives in `sim/`.

Verified by `test/compiler/golden.test.ts` (golden bytecode fixtures) and
`test/unit/CompilerDifferential.t.sol`.

## 4.5 Aqua / SwapVM integration

`contracts/swapvm/ConditionalLiquidityExtruction.sol` ·
`contracts/swapvm/ConditionalLiquidityProgramLib.sol`

The execution layer runs as a SwapVM `Extruction` instruction and performs real ERC20 settlement
through Aqua. An oversized trade reverts with `ExceedsEffectiveLiquidity` rather than being silently
truncated - a truncated fill is a worse outcome than a rejected one, because the trader cannot tell
it happened.

Tested by `test/unit/ConditionalLiquidityExtruction.t.sol`;
`test/fork/AquaSwapVMMainnetFork.t.sol` runs against the real deployed Aqua on mainnet.

## 4.6 Market-shock E2E

`test/integration/MarketShock.t.sol` demonstrates NORMAL → shock → DEFENSIVE → RECOVERY → NORMAL
with real conditional-liquidity behaviour and real settlement.

## 4.7 Differential testing

`test/differential/ReferenceEngine.t.sol` · `test/differential/vectors.json`

The Python reference implementation and the Solidity implementation must agree across randomized
scenarios covering price, volatility, price change, volume, timestamp, current mode, previous
transition, and inventory. 100+ scenarios.

---

# Part 5 - Uniswap v4 Conditional Liquidity Hook

The **same Strategy IR and state engine**, executed through Uniswap v4.

```text
                 Strategy
                    |
              Strategy IR
                    |
               State Engine
                    |
             +------+------+
             |             |
       Aqua / SwapVM   Uniswap v4
                           |
                    Conditional Hook
                           |
                      PoolManager
```

> One strategy → one state engine → multiple execution backends.

See [`uniswap-v4.md`](./uniswap-v4.md) for the full backend notes. Summary of the design decisions:

## 5.1 The hook holds no strategy logic

`contracts/uniswap/ConditionalLiquidityHook.sol` · `contracts/uniswap/HookStrategyAdapter.sol`

The hook does **not** implement a second strategy engine. It reuses the existing `RuleEngineLib` and
conditional-liquidity engine, so volatility logic, hysteresis, recovery, sustained-duration,
liquidity and spread calculations exist in exactly one place. The Uniswap backend consumes the same
strategy semantics as Aqua/SwapVM, which is what makes cross-backend equivalence testable rather
than aspirational.

## 5.2 Pool → strategy association

`PoolId → bytes32 strategyId`, set by `registerPoolStrategy`, callable only by the strategy's
registered maker - the same authority model as `registerStrategy` and `Aqua.ship`. The binding is
immutable once set; the MVP offers no update path deliberately.

Because a v4 pool has no equivalent of Aqua's per-strategy virtual balance (pool liquidity is a
shared AMM invariant, not a maker-scoped balance), the maker **declares** the notional ceiling their
strategy governs, in each token's own units. See `uniswap-v4.md` §12 for the limitation this
implies.

## 5.3 Enforcement is real

The hook changes execution behaviour - it does not merely emit an event, log volatility, or update
unused storage.

| State | Effective liquidity |
|---|---:|
| NORMAL | 100% |
| DEFENSIVE | 25% |
| RECOVERY | 50% |

A swap exceeding the effective limit **reverts** with `ExceedsEffectiveLiquidity`.

A consequence worth stating explicitly: `ConditionalSwapRejected` is declared in the interface but
**can never be observed as a mined log**. Emitting it and then reverting unwinds the emission along
with everything else in the call frame. That is a fundamental EVM constraint, not an oversight.

## 5.4 Market state

`contracts/core/interfaces/IMarketStateProvider.sol` · `contracts/mocks/MockMarketStateProvider.sol`

Minimum state: price, volatility, priceChange5m, priceChange1h, volume, oracleConfidence, timestamp.
The hook does not blindly trust arbitrary user-supplied market state.

## 5.5 Real integration, not a fake PoolManager

Tests use a real `PoolManager`, real pool, real liquidity, real swaps, real ERC20 movement.

| Concern | Test |
|---|---|
| NORMAL / DEFENSIVE / RECOVERY enforcement | `test/unit/ConditionalLiquidityHook.t.sol` |
| Conditional liquidity over a real pool | `test/integration/UniswapConditionalLiquidity.t.sol` |
| Full shock → recovery cycle | `test/integration/UniswapMarketShock.t.sol` |
| Same strategy, both backends, identical state | `test/integration/StrategyEquivalence.t.sol` |
| Backend agrees with the Python reference | `test/differential/UniswapBackendDifferential.t.sol` |
| Cap never bypassed under fuzzing | `test/unit/ConditionalLiquidityHook.t.sol` (fuzz cases) |
| Real mainnet PoolManager | `test/fork/UniswapMainnetFork.t.sol` |
| Gas | `test/gas/HookGasReport.t.sol` |

Hook address mining (`HookMiner`) is required because v4 encodes permissions in the hook's address.

---

# Part 6 - Solver + Venue Abstraction

`contracts/solver/` · `contracts/venues/`

A deterministic router across a fixed set of venues for one token pair.

## 6.1 Venue abstraction

`contracts/solver/interfaces/ILiquidityVenue.sol`

A normalized view of one backend's currently-executable state, so the solver can compare
heterogeneous backends without knowing their internals:

```solidity
struct VenueSnapshot {
    address venue;
    bytes32 strategyId;
    StrategyMode mode;
    uint256 effectiveLiquidity;
    uint16  spreadBps;
    uint256 referencePrice;
    uint16  coverageBps;      // added in Part 7
}
```

**A venue holds no strategy logic of its own.** Every field is read straight from the existing
engine/registry (Aqua path) or the hook (Uniswap path).

**Snapshots must come from a live re-evaluation path** - `ENGINE.preview` or `HOOK.quoteSnapshot` -
never from last-committed registry state. `getCurrentMode`/`getEffectiveSpread` read committed state
and can be stale until the next swap or poke, so they are deliberately unused here.

## 6.2 Venue adapters

`contracts/venues/AquaVenue.sol` · `contracts/venues/UniswapV4Venue.sol`

Both settle for real through the same entrypoints the existing fixtures use
(`AquaSwapVMRouter.swap`, `PoolSwapTest.swap`), with the venue itself as taker - so the solver
pushes tokens to the venue before calling `execute`.

`AquaVenue.referencePrice` comes from Aqua's **live reserve ratio**, not the oracle's
`MarketState.price`. The oracle price feeds the rule engine's volatility logic; it is not what the
underlying `XYCSwap` curve actually prices trades at. Using the real reserve ratio keeps the
solver's quote consistent with what `execute` will settle.

## 6.3 Deterministic routing

`contracts/solver/Solver.sol`

Venues are sorted by net-of-spread price, best first, then filled greedily up to each venue's live
`effectiveLiquidity` until the request is satisfied or venues run out. Greedy is *optimal* here -
these are flat-priced supply tranches, so taking as much as possible from the cheapest source first
is correct, and it needs no AI or search.

If the request exceeds total executable depth, the solver reverts `NoRoute` carrying the shortfall,
rather than inventing liquidity or partially filling.

Total executable depth is summed in **its own pass** over all snapshots. Accumulating it inside the
fill loop double-counts any venue the loop skips for zero depth - a real bug, caught by fuzzing in
Part 7, once insolvent makers made zero-depth venues common.

| Concern | Test |
|---|---|
| Venue discovery, state-aware depth, best venue, split routing | `test/unit/SolverRouting.t.sol` |
| Aqua snapshot correctness | `test/unit/AquaVenueSnapshot.t.sol` |
| Uniswap snapshot correctness | `test/unit/UniswapV4VenueSnapshot.t.sol` |
| Insufficient liquidity → `NoRoute` | `test/unit/SolverInsufficientLiquidity.t.sol` |
| Never allocates beyond live depth | `test/fuzz/SolverRouting.fuzz.t.sol` |
| Shock changes the route, end to end | `test/integration/SolverMarketShock.t.sol` |

---

# Part 7 - Conditional Liquidity Marketplace

Discovery through The Graph, risk-aware ranking, and atomic settlement across both backends - under
one governing rule: **no phantom liquidity**.

```text
                    THE GRAPH
                        |
               LIQUIDITY DISCOVERY
                        |
                RISK-AWARE SOLVER
                        |
          +-------------+-------------+
          |                           |
      Aqua/SwapVM                 Uniswap v4
          |                           |
          +-------------+-------------+
                        |
                ONCHAIN RECHECK
                        |
                 ATOMIC SETTLEMENT
```

## 7.0 The problem

This is not hypothetical hardening. It fixes a real defect.

Aqua enables "shared liquidity access directly from maker wallets", and that is literally how it is
built:

- `Aqua.ship(...)` records balances and **transfers no tokens**.
- `Aqua.pull(...)` settles with `IERC20(token).safeTransferFrom(maker, to, amount)`.

An Aqua balance is an **allowance against a maker's wallet**, not custody. Three things can make it
undeliverable, and **none of them emit an event**:

1. the maker moves or spends their tokens,
2. the maker reduces or revokes their ERC20 approval to Aqua,
3. the strategy's own conditional rules shrink what it will quote.

Before Part 7, `AquaVenue.snapshot` derived `effectiveLiquidity` from the Aqua virtual balance
alone. A maker could advertise 100 tokens while holding 1; the solver would route all 100; and
settlement would revert inside `transferFrom`. That gap is **phantom liquidity**.

## 7.1 Three layers of truth

Never collapsed.

| Layer | Component | Authoritative for | Never used for |
|---|---|---|---|
| 1 - Graph | `subgraph/`, `src/discovery/` | which venues exist, history, ranking hints | settlement |
| 2 - Solver | `src/solver/RiskAwareRanker.ts` | candidate ranking, split allocation | settlement |
| 3 - Chain | `contracts/solver/Solver.sol`, venue adapters | executable liquidity, slippage, settlement | - |

A malicious index, a stale snapshot, or an outright buggy offchain ranker can cost a trader a
*worse* route. None can cost them a *failed* one, because layer 3 re-derives everything. The
on-chain `Solver` cannot even see an offchain score - it has no parameter for one.

## 7.2 Real executable liquidity

`contracts/libraries/ExecutableLiquidityLib.sol` ·
`contracts/venues/interfaces/IExecutableLiquidity.sol`

Pure, deterministic integer arithmetic:

```text
deliverableLiquidity = min(virtualLiquidity, walletLiquidity, allowance)
conditionalLiquidity = deliverableLiquidity * liquidityBps / 10000
coverageBps          = min(deliverableLiquidity * 10000 / virtualLiquidity, 10000)
```

```solidity
struct ExecutableLiquidity {
    uint256 virtualLiquidity;      // advertised; never route on this alone
    uint256 walletLiquidity;       // what the settling party actually holds
    uint256 allowance;             // what they actually approved
    uint256 deliverableLiquidity;  // min of the three above
    uint256 conditionalLiquidity;  // after the multiplier - the ONLY routable figure
    uint16  coverageBps;           // deliverable / virtual, clamped
}
```

Two ordering decisions carry the safety property:

- The conditional multiplier applies to **deliverable**, not advertised, depth. Applying it to the
  advertisement would quote 25 against a wallet that can only pay 10.
- `coverageBps` is `0` when nothing is advertised, **not** `10000`. "Nothing to deliver" and "fully
  covered" must not share a number, or a UI will badge an empty maker as HEALTHY.

### Per-venue solvency models

| | Aqua | Uniswap v4 |
|---|---|---|
| `virtualLiquidity` | maker's Aqua balance (an allowance) | hook's conditionally-adjusted ceiling |
| `walletLiquidity` | maker's wallet balance | PoolManager's real reserves |
| `allowance` | maker → **Aqua** approval (not the router) | `type(uint256).max` - never binding |

A v4 pool is structurally solvent: its tokens are already in custody, with no third party to run dry
or revoke. A healthy pool naturally shows 100% coverage while a drained maker does not - a real
property of the two backends, not a modelling artefact. Computing coverage identically for both is
what lets the marketplace rank a pool against a maker on one honest scale.

**Nothing in Aqua or the RuleEngine was modified.** This lives entirely in the venue adapter layer.

## 7.3 No phantom liquidity

`VenueSnapshot.effectiveLiquidity` is now `conditionalLiquidity`, so the number the solver ranks on
is already solvency-bounded. A bound the router could ignore would be merely advisory.

`Solver.settle` then does three independent things, in order:

1. `route(request)` - re-reads every venue live. A caller-supplied plan is never trusted.
2. `_revalidate(plan)` - re-reads `executableLiquidity` per leg **before any token moves**, and
   reverts `ExecutableLiquidityShortfall(venue, allocated, executable)` if
   `allocated > executable`. It also rejects duplicate legs (`DuplicateRouteLeg`), which would let
   two individually-valid allocations sum past one venue's real depth.
3. Push-then-execute each leg, emit `LegExecuted` per leg, enforce `minTotalAmountOut`.

Step 2 is **not** redundant with step 1. It is the only thing standing between a plan built one
block ago and a maker who has since drained their wallet. Checking up-front rather than per-leg
means a shortfall rejects the whole settlement atomically, instead of half-filling a route and
leaving the trader with a partial position in a market that just proved itself unreliable.

| Concern | Test |
|---|---|
| Wallet / allowance / multiplier bounds, deactivation | `test/unit/AquaExecutableLiquidity.t.sol` |
| `allocated <= executable`, every leg, every regime | `test/unit/SolverNoPhantomLiquidity.t.sol` |
| Wallet drains between `route` and `settle` | `test/unit/SolverNoPhantomLiquidity.t.sol` |
| ∀ (virtual, wallet, allowance, liquidityBps, amount) | `test/fuzz/ExecutableLiquidity.fuzz.t.sol` |

## 7.4 Coverage

`coverageBps = deliverableLiquidity / virtualLiquidity`, clamped to 10,000.

| Coverage | Band |
|---|---|
| ≥ 9000 bps | HEALTHY |
| ≥ 7000 bps | DEGRADED |
| ≥ 3000 bps | FRAGILE |
| < 3000 bps | UNRELIABLE |

Bands live in `src/analytics/coverage.ts` and `app/src/market/coverage.ts`, and are
deliberately **not** an on-chain enum - an enum there would invite treating a display bucket as a
safety control.

Coverage tracks *solvency*, not regime. A DEFENSIVE maker who is good for everything they still
advertise is fully covered: cautious, not unreliable. Conflating the two would double-penalise a
well-behaved maker during a shock.

Tested by `test/unit/LiquidityCoverage.t.sol`.

## 7.5 The Graph subgraph

`subgraph/` - see [`subgraph/README.md`](../subgraph/README.md).

Entities: `Strategy`, `Maker`, `Venue`, `LiquiditySnapshot`, `StateTransition`, `Swap`,
`RouteExecution`, `RouteLeg`. Indexes registration/activation, state transitions, fills, and solver
executions across both the Aqua and Uniswap registry/engine pairs.

Two honesty constraints are baked into the mappings:

- **`failedFills` is always 0.** A reverted settlement's logs are unwound with the rest of its call
  frame, so a failed fill leaves nothing to index (§5.3). Rather than report an inferred number that
  *looks* measured, the counter stays zero and the README says why.
- **A maker with no attempts reads `10000`, not `0`.** A fresh maker has not earned distrust, and
  burying them under a score they never earned would entrench incumbents - while costing traders
  nothing, because solvency is enforced independently at layer 3.

`LegExecuted` was added to `Solver` for this: `PlanExecuted` reports only a total, which cannot be
attributed back to the venue that filled it, and reliability is a per-maker property.

ABIs are generated from the Foundry build (`npm run sync-abis`), so they cannot drift from the
deployed contracts.

## 7.6 Liquidity discovery

`src/discovery/` - `GraphLiquidityDiscovery.ts`, `queries.ts`, `types.ts`.

The type system enforces the layer boundary: `discover()` returns `LiquidityCandidate`s whose depth
fields are all named `reported*`, and only a live chain read produces the `conditionalLiquidity` a
route may allocate against. If a `reported*` value reaches settlement code, the prefix is telling
you a layer was collapsed.

Discovery **degrades rather than fails**: an unreachable subgraph returns `[]`, and unknown maker
history defaults to fully reliable. An index outage must never block a trade the chain could still
settle, and must never silently de-rank every maker in the market.

Stale rows are dropped before ranking, because an Aqua maker can go insolvent without emitting
anything - old data is not merely imprecise, it can be wrong in the direction that hurts.

The pair is queried **unordered**. Strategies are stored sorted (`tokenA < tokenB`) and are
direction-agnostic; filtering on a directed pair would silently hide every maker willing to trade
the other way.

Tested by `test/offchain/discovery.test.ts` against mocked Graph responses - the contract tests
never depend on a running Graph node, and neither do these.

## 7.7 Risk-aware ranking

`src/solver/RiskAwareRanker.ts` - the offchain solver (layer 2).

```text
riskAdjustedScore = effectivePrice * (10000 - riskPenaltyBps) / 10000

riskPenaltyBps = coverageShortfall    * 3000 / 10000
               + reliabilityShortfall * 1000 / 10000
               + modePenalty(NORMAL 0 | RECOVERY 20 | DEFENSIVE 50)
```

- **Integer arithmetic only** - not because this runs on-chain (it does not), but so the same inputs
  always produce the same route. A ranker that drifts with floating-point rounding produces routes
  that cannot be reproduced when someone asks why a trade went the way it did, which makes the
  explanations in §7.11 unfalsifiable.
- **Additive, not multiplicative**, so a penalty stays legible in an explanation ("80 bps, of which
  60 from coverage") rather than being a product of opaque factors.
- **Capped below 100%**, so a penalty may sink a venue to last place but can never invert its price
  into a negative score and make an unreliable venue look attractive again.
- **Coverage outweighs spread**, because a maker who can only deliver 80% of what they advertise is
  the exact failure this marketplace exists to price.
- **Deterministic tie-break** on venue address, so two identically-priced venues never flip
  run-to-run for no visible reason.

Excluded candidates are kept in the result, not filtered out, so the UI can explain *why* a source
was dropped.

Tested by `test/offchain/ranking.test.ts`.

## 7.8 Market regime routing

Strategy state feeds routing directly and immediately, because `VenueSnapshot` is built from a live
re-evaluation path (§6.1).

`test/integration/MarketRegimeRouting.t.sol` walks the full narrative with real settlement through
real Aqua/SwapVM and a real v4 pool: NORMAL → trade settles → volatility spike → DEFENSIVE → depth
collapses, spread widens, route re-splits → oversized request becomes impossible → sustained calm →
RECOVERY → depth restored → routes again → maker drains wallet → solver allocates the real 2, not
the advertised depth.

One finding worth recording: by the RECOVERY step the earlier *real* fills have walked Aqua's
constant-product reserve ratio from 1.5 down below Uniswap's deep ~1.0 pool, so the solver switches
venues on price. Asserting "Aqua still wins" there would be asserting that trades leave no market
impact.

## 7.9 Historical reliability

`src/analytics/reliability.ts`

```text
reliabilityBps = successfulFills * 10000 / attemptedFills
```

The hard rule, enforced by `allocatableDepth`: reliability can only ever **de-rank**. It can never
raise executable depth above what the chain says is deliverable.

> A maker with **99% historical reliability** and **0 current wallet balance** has
> **0 executable liquidity**.

Reliability describes the past; the past cannot pay for a trade. `smoothedReliabilityBps` also damps
small samples toward a prior, so a single lucky fill cannot out-rank a long honest record.

## 7.10 Liquidity Health API

`src/analytics/health.ts` - `toHealthRecord` / `toMarketHealth`.

Every amount serialises as a **decimal string**, never a JSON number: JSON numbers cannot hold
18-decimal token amounts without silently losing precision, and a health endpoint that rounds
balances is a health endpoint that lies.

The aggregate regime is the **worst** among active sources, not an average. One maker going
defensive is exactly the signal a trader needs; averaging would hide it.

On-chain counterpart: `contracts/solver/LiquidityHealth.sol` (`LiquidityHealthLens`) - a stateless
lens with no storage, no owner, no privileged caller. Nothing routes through it, so it cannot become
a second source of truth; deleting it would change no settlement behaviour. It exists so a frontend
reads `2 × venues + 1` values from the **same block**, which separate RPC round trips cannot
guarantee. A venue that reverts is returned zeroed rather than failing the whole batch - a
marketplace that goes blank because one maker misbehaved is worse than one showing that maker
offline.

## 7.11 Marketplace UI and route explanation

`app/src/components/market/MarketPage.tsx`, `app/src/components/swap/LiquidityDiscovery.tsx`

Every figure is read live from the venue adapters - the same functions the Solver itself calls. That
is what makes the "NO PHANTOM LIQUIDITY" badge a claim rather than a slogan: the page cannot show a
depth the solver would refuse to route against.

- Advertised-but-undeliverable depth renders **struck through** beside the real figure, so the gap
  is visible rather than merely absent.
- A source the solver cannot use is **dimmed, not hidden** - a trader should see that it exists and
  is unusable rather than wonder where it went.
- Reliability is the one number not read from chain, so it renders **"-"** when the index is
  unconfigured or unreachable. A fabricated percentage beside chain-read numbers would be the only
  figure on the screen a trader could not verify.

Explanations are derived entirely from what is on screen, so they can never claim a reason the
numbers above do not support.

## 7.12 Inventory-aware pricing

**Deferred, not implemented.** It was explicitly gated on "only if the core system is already
stable", and was judged less valuable than verified depth on the rest of Part 7 - it would touch
pricing, and a second pricing engine was disallowed. When added, it belongs as an additive strategy
rule, not a new engine.

---

# Part 8 - Frontend

`app/` is a React + wagmi client with one job: make the mechanism above legible without asking
anyone to read this document. It is not a separate model of the protocol - it holds no rule logic,
no regime arithmetic, and no second opinion about depth.

## 8.1 One block, one truth

Every on-chain read in the app keys on a single observed block (`app/src/chain/ObservedBlockContext.tsx`),
and there is exactly one normalized `LiquiditySource[]` (`app/src/market/useMarket.ts`) that the swap
screen, the marketplace and the strategy screen all render.

That is structural, not stylistic. The claim this product makes is "the route was checked against
depth that can actually settle it" - and a route computed at block N displayed beside depth summed
at block N-1 does not support that claim. Keying every read on the same token makes the mismatch
unrepresentable rather than merely unlikely. After a swap confirms, `advanceTo(receipt.blockNumber)`
moves the token forward, so the refresh cannot be served by a node that has not yet seen the trade.

## 8.2 Four levels of disclosure

The screens are layered so a trader and a protocol engineer can both stop at the right depth:

| Level | Where | What it answers |
|---|---|---|
| 1 | Swap card | What am I trading, and what will I get? |
| 2 | Market conditions, Aqua strategy card, Your route | What state is the market in, and how was my order split? |
| 3 | "Why this route?", source drawers | Why that split? What can each source actually pay? |
| 4 | Strategy screen, "Technical details" | What rules is the maker running, and at what addresses? |

`Your route` sits **above** the source cards: the split is the answer, the per-source depth is the
working behind it.

## 8.3 What the frontend is not allowed to do

Three rules, each of which has a counter-example in the code that enforces it:

- **Never invent a figure.** A value that cannot be read renders `-`, never `0` and never a
  plausible default. Historical reliability shows `-` when no indexer is configured, because a
  placeholder beside chain-read numbers would be the one figure on screen nobody could verify.
- **Never decide a regime.** `snapshot.mode` comes from `ENGINE.preview`, a live re-evaluation of
  the deployed rule program. React renders it; it does not compute it.
- **Never round a token amount by guesswork.** `app/src/format.ts` takes each token's own `decimals()`, read
  from chain, as a *required* argument - so a non-18-decimal token cannot silently render a million
  times too large.

## 8.4 Strategy configuration

The strategy screen (`app/src/components/strategy/`) both reads and writes the protocol.

**Reading** is the authoritative half. Regime and multiplier come from `ENGINE.preview`; the
strategy's own thresholds are decoded from the rule-program bytes the registry stores
(`REGISTRY.getRuleProgram`), so what is displayed is the program that will actually execute rather
than anything the app remembers. The recovery timer is driven by `RuntimeState.armedSince` - the
timestamp the *engine* recorded when the duration-gated rule first evaluated true - compared against
the chain's block timestamp, not the browser clock.

**Writing** compiles the maker's parameters with the project's own CLF backend
(`src/compiler/backends/ruleProgram.ts`, imported directly from `app/` through a small Vite resolver
rather than reimplemented), builds the SwapVM order, and calls
`ConditionalLiquidityRegistry.registerStrategy`. Before anything is signed the deployed
`StrategyValidator` is asked to validate the bytes and the registration is simulated, so the
admission rules applied are the chain's at their deployed version.

The order builder is the part that could fail silently, so it is pinned by equality rather than by
assertion: `app/src/strategy/order.test.ts` requires it to reproduce the strategy id already
registered on Sepolia from public inputs alone. A single wrong trait bit or program byte hashes to
something else, so the test cannot pass by accident. That path has also been exercised on-chain - see
`docs/sepolia-deployment.md` §6.

## 8.5 Deployment targets

The app defaults to Ethereum Sepolia and registers **only** the configured chain with wagmi. An
earlier build registered both Sepolia and anvil "for free"; wagmi opened a transport for each, and a
Sepolia build polled `http://127.0.0.1:8545` several hundred times a minute. A public build must not
reach for localhost at all, even unsuccessfully.

Contract addresses live in `app/src/config/markets.ts`, mirroring `deployments/<chainId>.json`.
They are not environment variables: each market has its own Solver and its own venue pair, so a flat
`VITE_SOLVER` stopped being expressible once there was more than one market.

---

# Where to pick up next

1. **Inventory-aware pricing** (§7.12) - as an additive strategy rule or strategy configuration.
   Do not build a second pricing engine.
2. **Subgraph deployment.** `subgraph/subgraph.yaml` now carries the live Sepolia addresses and
   real start blocks, but the subgraph itself has not been deployed - that needs a Graph Studio
   account. Until it is, the frontend's reliability column honestly reads `-`.
3. **Etherscan source verification** for the Sepolia deployment. The deployed contracts are
   currently evidenced by bytecode comparison against locally-built artifacts
   (`scripts/audit/bytecode.mjs`), which is reproducible but is not the same as published source.
4. **Live-sourced v4 base liquidity** - see `uniswap-v4.md` §12; only `HookStrategyAdapter`'s
   cap-source would change.

---

# Testing

```bash
npm test                # forge test - Solidity unit/integration/fuzz/differential
npm run test:compiler   # vitest - compiler, discovery, ranking
npm run typecheck       # tsc --noEmit
npm run test:fork       # mainnet fork tests (needs RPC_URL)
```

```bash
forge test --match-path "test/fork/SepoliaMarketplaceFork.t.sol" -vv
```

The last of those runs the whole Sepolia deployment plan against a fork of the live network and
trades through it. It is the gate on a real broadcast: it is the only place that can prove the
*reused* Sepolia state is what an audit concluded it is, and that Uniswap's own Sepolia v4
contracts are ABI-compatible with the v4-core version this repository compiles against.

Current state: **163 Solidity tests (7 of them the Sepolia fork suite), 75 offchain compiler tests,
52 frontend tests, 0 failures.**

On Windows, Foundry was run under WSL for this project; see the root `README.md`.

---

# The public deployment

`docs/sepolia-deployment.md` is the record of what actually runs on Ethereum Sepolia: the on-chain
audit of what was already there, the decision log for every component (reused / redeployed / not
used / invalid), the token-provenance argument, the live liquidity breakdown, every transaction hash
and the limitations. The short version of the architecture-relevant parts:

- The marketplace layer (`Solver`, `AquaVenue`, `UniswapV4Venue`) was redeployed because the
  previous Sepolia deployment predated `IExecutableLiquidity` - it had no `executableLiquidity()`
  and a six-field `VenueSnapshot`, so the no-phantom-liquidity property was absent from the public
  chain entirely.
- The Uniswap v4 leg was re-pointed from a privately-deployed `PoolManager` onto **Uniswap's own**
  Sepolia deployment. A v4 hook binds to its manager at construction, so that migration brought a
  freshly CREATE2-mined `ConditionalLiquidityHook` with it; the strategy behind the pool is the one
  already registered.
- Everything else - tokens, Aqua, `AquaSwapVMRouter`, both registry/validator/engine/extruction
  sets, both market-state providers, both registered strategies - was reused after on-chain
  verification.
