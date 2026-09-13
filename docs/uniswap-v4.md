# Uniswap v4 execution backend

Part 5 of Conditional Liquidity Functions: a real Uniswap v4 hook that enforces the exact same
strategy state machine the Aqua/SwapVM backend (Part 4) already enforces, for the same registered
strategy. This document explains why, how, and what's deliberately left out of the MVP.

For the research trail that led to these design decisions - the exact installed-version API survey
done before any hook code was written - see `docs/uniswap-v4-implementation-notes.md`.

## 1. Why Uniswap v4

The project's thesis is that a *strategy* - a compiled rule program plus the state machine that
evaluates it - should be portable across execution venues. Aqua/SwapVM proved the concept works
against a signature/virtual-balance settlement model. Uniswap v4 is the natural second venue to
prove it against: a completely different settlement model (concentrated-liquidity AMM, singleton
`PoolManager`, hook lifecycle callbacks) with its own capital base, its own liquidity providers, and
its own execution mechanics. If the same strategy produces the same mode/liquidity/spread decisions
on both, the "Strategy IR → RuleEngine → \{SwapVM, Uniswap v4\}" architecture is real, not aspirational.

## 2. Architecture

```
                    Strategy DSL (Part 3)
                            |
                            v
                      Strategy IR
                            |
                            v
              ConditionalLiquidityRegistry  (Part 1: definition + runtime state, one per strategy)
                            |
                            v
                ConditionalLiquidityEngine  (Part 2: RuleEngineLib.evaluate, the ONLY place
                            |                 the rule engine is ever invoked)
              +-------------+-------------+
              |                           |
              v                           v
   ConditionalLiquidityExtruction   HookStrategyAdapter
   (SwapVM Extruction instruction)         |
              |                            v
              v                  ConditionalLiquidityHook
            SwapVM                        (IHooks.beforeSwap)
              |                            |
              v                            v
             Aqua                     PoolManager
              |                            |
              v                            v
          Settlement                  Settlement
```

Neither `ConditionalLiquidityExtruction` nor `ConditionalLiquidityHook` contains any volatility
math, hysteresis, or liquidity/spread formula. Both call `ConditionalLiquidityEngine.poke`, which is
the only call site of `RuleEngineLib.evaluate` in the entire protocol. `test/integration/StrategyEquivalence.t.sol`
verifies this empirically: two fully independent deployments (separate registries, separate engines,
separate oracles, one driven only through Aqua/SwapVM swaps, the other only through Uniswap v4
swaps) stay in lockstep - same mode, same liquidityBps, same spreadBps - across the same volatility
sequence.

### New contracts

- `contracts/uniswap/interfaces/IHookStrategyAdapter.sol` / `HookStrategyAdapter.sol` - the
  PoolId ↔ strategyId association layer. Knows nothing about `IHooks`, hook permission bits, or
  `PoolManager`'s unlock/callback pattern. Its own registration check ends where a `PoolManager`
  dependency would begin (see §3).
- `contracts/uniswap/interfaces/IConditionalLiquidityHook.sol` / `ConditionalLiquidityHook.sol` -
  the actual `BaseHook` subclass. Implements exactly one callback, `beforeSwap`.
- `contracts/swapvm/ConditionalLiquidityProgramLib.sol` - unrelated to the hook; this is the
  SwapVM-side program builder from Part 4, referenced here only because the Aqua backend's fixtures
  use it in the cross-backend equivalence tests.

## 3. Pool → Strategy mapping

```solidity
function registerPoolStrategy(PoolKey calldata key, bytes32 strategyId, uint256 baseLiquidity0, uint256 baseLiquidity1) external;
```

Authorization mirrors `ConditionalLiquidityRegistry.registerStrategy`/`Aqua.ship`: only
`REGISTRY.getStrategy(strategyId).maker` may call this. Checks performed, in order:

1. `HookStrategyAdapter` (no `PoolManager` dependency):
   - the pool hasn't already been bound to a strategy (**immutable once set - no update/replace
     path exists in the MVP**),
   - `key.hooks == address(this)` (the pool actually uses this hook),
   - `msg.sender == strategy.maker`,
   - the strategy is active,
   - `key.currency0/currency1` match the strategy's `tokenA/tokenB` exactly.
2. `ConditionalLiquidityHook.registerPoolStrategy` (needs `PoolManager`, so it isn't in the adapter):
   - the pool is actually initialized (`StateLibrary.getSlot0(...).sqrtPriceX96 != 0`), checked
     *before* calling into the adapter, so a not-yet-initialized pool fails for that reason first.

### Why `baseLiquidity0`/`baseLiquidity1` are maker-declared

Aqua tracks a maker's committed balance per strategy directly (`Aqua.ship(app, strategy, tokens[],
amounts[])`). Uniswap v4 has no equivalent concept - pool liquidity is a shared AMM invariant
contributed by any number of independent LPs across arbitrary tick ranges, not a maker-scoped
balance. To keep the *same* cap formula (`cap = base * liquidityBps / BPS`) meaningful on both
backends, the pool's maker declares a notional ceiling per token side at registration time - exactly
the same kind of maker-declared number `Aqua.ship`'s `amounts[]` already is. See §11 for what a
production version of this would look like instead.

## 4. Market state flow

Unchanged from Part 2/4: `IMarketStateProvider.getMarketState(strategyId)` (a `MockMarketStateProvider`
in every test and the deploy script; a real oracle adapter in production) feeds
`ConditionalLiquidityEngine.poke`, which combines it with the registry's stored `RuntimeState` and
the strategy's compiled rule program through `RuleEngineLib.evaluate`. The hook never reads market
state directly and never constructs a `MarketState` itself - a taker-supplied "trust me, volatility
is low" value has no path into this system.

## 5. RuleEngine reuse

`ConditionalLiquidityHook._beforeSwap` calls `ENGINE.poke(strategyId)` - literally the same external
function `ConditionalLiquidityExtruction.extruction` calls on the SwapVM side, on the same
`ConditionalLiquidityEngine` contract type. Neither the hook nor the adapter imports
`RuleEngineLib`, `RuleProgram`, or any volatility/hysteresis constant.

## 6. Effective liquidity calculation

```solidity
bool exactIn = params.amountSpecified < 0;
uint256 requested = exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
bool capOnCurrency0 = exactIn ? params.zeroForOne : !params.zeroForOne;
uint256 base = capOnCurrency0 ? ps.baseLiquidity0 : ps.baseLiquidity1;
uint256 cap = base.mulBps(config.liquidityBps);
require(requested <= cap, ExceedsEffectiveLiquidity(poolId, strategyId, requested, cap));
```

This is a direct port of `ConditionalLiquidityExtruction`'s cap logic: exact-in caps the input side,
exact-out caps the output side, using `FixedPointMath.mulBps` - the same library function, not a
reimplementation. NORMAL/DEFENSIVE/RECOVERY resolve to 100%/25%/50% of the declared base exactly as
they do on the Aqua backend, because they're the same `liquidityBps` value read from the same
`RuntimeState`.

## 7. Hook enforcement mechanism

`_beforeSwap` is the only callback implemented. On every swap it:

1. Resolves the pool's strategy and requires it active.
2. Calls `ENGINE.poke(strategyId)` - commits any pending state transition atomically, in the same
   transaction as the swap it's gating.
3. Computes the cap (§6) and `require`s the requested amount doesn't exceed it - **a hard revert**,
   not a `BeforeSwapDelta`-based truncation. `docs/uniswap-v4-implementation-notes.md` explains why:
   v4 could let a hook silently shrink an oversized trade via custom accounting, but that would make
   the two backends disagree (Aqua refuses an oversized trade outright; a silently-shrunk v4 trade
   would not). Returning `BeforeSwapDeltaLibrary.ZERO_DELTA` on the success path keeps swap
   accounting completely untouched.
4. Returns a dynamic-fee override derived from the strategy's current `spreadBps` (`spreadBps *
   100`, converting protocol bps to v4's hundredths-of-a-bip fee units), with
   `LPFeeLibrary.OVERRIDE_FEE_FLAG` set. Applied only if the pool itself was created with
   `LPFeeLibrary.DYNAMIC_FEE_FLAG` - a static-fee pool silently ignores it, so it's always safe to
   return unconditionally.
5. Emits `HookStateTransition` (only on an actual mode change) and `ConditionalLiquidityApplied`
   (every allowed swap).

If the trade is rejected, the whole transaction reverts with `ExceedsEffectiveLiquidity`
(`PoolManager` wraps it in `CustomRevert.WrappedError`, v4's own ERC-7751-style hook-error wrapping -
see any `_expectExceedsEffectiveLiquidity` test helper for the exact wrapped shape). No state
changes persist, including the `engine.poke()` call that ran moments earlier in the same
transaction - Solidity's revert semantics undo the whole call frame.

`ConditionalSwapRejected` is declared in `IConditionalLiquidityHook` but can **never appear as a
persisted, mined log** - emitting it and then reverting (which `ExceedsEffectiveLiquidity` requires)
would unwind the emission along with everything else in that call frame. It's kept in the ABI for
indexer/tooling completeness (a trace-inspection tool can still see it in a *simulated*, non-mined
call) and documented here so nobody mistakes its absence from event logs for a bug.

## 8. Hook permissions

```solidity
function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
    return Hooks.Permissions({
        beforeSwap: true
        // every other field: false
    });
}
```

Only `beforeSwap`. No `afterSwap` (nothing needs to happen after settlement - the cap check and fee
override both belong before), no `beforeSwapReturnDelta`/`afterSwapReturnDelta` (no custom
accounting, see §7), no liquidity or donate callbacks (this hook doesn't gate LP position management
- see §11).

## 9. Hook deployment / mining

Uniswap v4 encodes which callbacks fire in the low 14 bits of the hook's own deployed address
(`Hooks.BEFORE_SWAP_FLAG = 1 << 7`). `BaseHook`'s constructor calls
`Hooks.validateHookPermissions`, which reverts if the address's bits don't match
`getHookPermissions()`'s declared set - so the hook cannot be deployed with a plain `new`; it must
land at a mined `CREATE2` address.

`@uniswap/v4-periphery`'s `HookMiner.find(deployer, flags, creationCode, constructorArgs)` (a
published `src/` library, not a private test helper) linearly searches salts until it finds one
producing an address with the right low bits and no existing code:

```solidity
uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG);
(address predicted, bytes32 salt) = HookMiner.find(deployer, flags, type(ConditionalLiquidityHook).creationCode, abi.encode(manager, engine, registry));
ConditionalLiquidityHook hook = new ConditionalLiquidityHook{salt: salt}(manager, engine, registry);
require(address(hook) == predicted);
```

`deployer` differs by context (per `HookMiner`'s own NatSpec): `address(this)` (the test contract)
in `forge test`; the canonical CREATE2 deployer proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C`
in `forge script --broadcast`, because Foundry's script broadcaster routes salted `new X{salt}(...)`
deployments through that proxy. `script/DeployUniswapHook.s.sol` and `script/DeploySepolia.s.sol`
both use the latter; `test/fork/SepoliaMarketplaceFork.t.sol` mines against `address(this)` for the
same reason `forge test` always does. Getting this wrong does not fail loudly - the mined salt simply
produces an address the hook never lands at, and construction reverts `HookAddressNotValid`.

Verified end-to-end twice: against local Anvil, and on Ethereum Sepolia, where the live hook
`0xa05d48D7b56759aeBdb73A3bB6ffF179bd74c080` decodes to exactly `BEFORE_SWAP_FLAG` (`0x...4080`) and
nothing else.

## 10. Which PoolManager - tests versus the live deployment

Worth separating, because the two are deliberately different.

**Tests and the local demo deploy their own `PoolManager`.** A local chain has no Uniswap on it, so
there is nothing to reuse; `vm.deployCode` puts one there.

**The Sepolia deployment uses Uniswap's own** (`0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`, owner
Uniswap's, not this project's). An earlier Sepolia run had deployed a *private* PoolManager - a
duplicate of protocol infrastructure that genuinely exists on that network - which made the "runs on
Uniswap v4" claim weaker than it needed to be. A v4 hook binds to its manager at construction, so
moving to the real one meant a freshly mined hook; the strategy behind the pool is the one that was
already registered. `docs/sepolia-deployment.md` §2 records the decision and the evidence, and
`test/fork/SepoliaMarketplaceFork.t.sol` proved Uniswap's Sepolia `PoolManager`, `PoolSwapTest` and
`PoolModifyLiquidityTest` are ABI-compatible with the v4-core version this repository compiles
against *before* anything was broadcast.

### Local test architecture

`PoolManager.sol` exact-pins `pragma solidity 0.8.26`, which cannot share a compiler invocation with
this project's `^0.8.30` files (1inch's aqua/swap-vm exact-pin `0.8.30` the same way). Rather than
downgrading the whole project, `test/utils/deployers/PoolManagerImport.sol` is an isolated,
unimported file whose only job is to make `forge build` produce a `PoolManager` artifact; tests and
scripts deploy it via `vm.deployCode("PoolManager.sol:PoolManager", abi.encode(owner))`, which needs
no Solidity-level import at the call site. `foundry.toml` accordingly has no forced `solc_version`
(auto-detected per file) and matches Uniswap's own `optimizer_runs = 44_444_444` (their
`PoolManager.swap()` hits a genuine Yul "variable too deep in the stack" failure at lower run
counts under `via_ir`).

Everything else is real, official infrastructure: `PoolManager` itself, `PoolSwapTest` /
`PoolModifyLiquidityTest` (Uniswap's own unlock-callback test routers, used by Uniswap's own test
suite - not a bespoke `IUnlockCallback` implementation), `TickMath` for full-range positions and
initial price. `test/utils/UniswapExecutionFixture.sol` assembles all of it plus the
conditional-liquidity protocol stack; every integration test in `test/integration/Uniswap*.t.sol`
and `test/unit/ConditionalLiquidityHook.t.sol` builds on it.

## 11. Mainnet fork setup

`test/fork/UniswapMainnetFork.t.sol` is additive, never required: every test in the file checks
`RPC_URL` via a `vm.skip(true)` modifier and skips cleanly (not a failure) when it's unset, so
`forge test` never needs network access to pass.

**This has actually been run against Ethereum mainnet**, not just designed to be runnable:

```bash
RPC_URL=https://ethereum-rpc.publicnode.com npm run test:fork
```

```
Ran 2 tests for test/fork/UniswapMainnetFork.t.sol:UniswapMainnetForkTest
[PASS] test_Fork_HookEnforcesEffectiveLiquidityAgainstRealPoolManager() (gas: 28687737)
[PASS] test_Fork_PoolManagerIsDeployedAtDocumentedAddress() (gas: 8544)
Suite result: ok. 2 passed; 0 failed; 0 skipped
```

Verified directly against the fork: chain ID 1, code present at the documented mainnet
`PoolManager` address `0x000000000004444c5dc75cB358380D2e3dE08A90` (re-confirmed against Uniswap's
developer documentation the day this was run, not assumed from memory), our
`ConditionalLiquidityHook` mined and deployed via the real `HookMiner` against that real
`PoolManager`, a fresh pool created and initialized, the volatility-shield strategy registered and
bound to it, real liquidity seeded, a real NORMAL-mode swap settled, a real volatility shock
committing the DEFENSIVE transition via another real swap, and a real oversized swap reverting with
`ExceedsEffectiveLiquidity` - against production Uniswap v4 infrastructure, at whatever block was
current at test time (~25,910,000).

**`FORK_BLOCK` and free-tier RPC archive limits.** `publicnode.com`'s free endpoint rejects *any*
explicit block number - including one only 100 blocks behind the tip - with `"Archive requests
require a personal token"`; only unpinned (`"latest"`) queries are served for free. This was
verified directly (both the current tip and tip-100 were tried and both got HTTP 403) before
concluding it wasn't a bug in the test. `_fork()`'s existing fallback
(`vm.createSelectFork(rpcUrl)` when `FORK_BLOCK` is 0/unset) already handles this correctly with no
code changes needed - with a free-tier RPC, leave `FORK_BLOCK` unset and the suite still runs, just
against whatever block is current rather than a pinned one. Set `FORK_BLOCK` (see `.env.example`)
if you have an archive-capable RPC (Alchemy, Infura, your own node) and want exact reproducibility.

No RPC credentials are hardcoded anywhere in the repo; `RPC_URL` above is a public endpoint, passed
via the environment, not committed.

## 12. Known limitations

- **Declared, not live, base liquidity** (§3). A production hook would size the cap from the pool's
  actual reserves - e.g. `StateLibrary.getLiquidity` plus a tick-range-aware conversion to token
  amounts at the current price - rather than a number the maker asserts at registration time. The
  MVP's declared-ceiling model is simpler, cheaper, and structurally identical to how Aqua's own
  `ship()` amounts work, but it does mean a maker could in principle declare a ceiling detached from
  what's actually seeded in the pool. Nothing prevents fixing this later without touching the rule
  engine: only `HookStrategyAdapter`'s cap-source would change.
- **No LP-side gating.** The hook doesn't implement `beforeAddLiquidity`/`beforeRemoveLiquidity` -
  conditional liquidity governs *trade size*, not who may provide or withdraw liquidity, mirroring
  Aqua (a maker can `dock()` unilaterally; that isn't Extruction's concern either).
- **Immutable pool→strategy binding, no update path.** Deliberate for the MVP (see §3); a
  maker who wants different strategy parameters must use a new pool.
- **`ConditionalSwapRejected` cannot be a persisted event** (§7) - a fundamental EVM constraint
  (revert unwinds logs), not a gap to close later.
- **Single dynamic-fee mechanism assumed.** If a pool is created with a *static* fee, the strategy's
  spread is enforced only through the liquidity cap, not through pricing - spread has no effect on a
  static-fee pool. Every test pool in this repo uses `LPFeeLibrary.DYNAMIC_FEE_FLAG` specifically so
  spread enforcement is exercised.
