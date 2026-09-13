# Uniswap v4 - implementation notes

> **What this file is.** Four places in this repository point here for "the API survey done before
> any hook code was written": `contracts/uniswap/ConditionalLiquidityHook.sol`'s NatSpec,
> `docs/uniswap-v4.md` §0 and §7, and `docs/aqua-swapvm-production-fork.md`. Those original working
> notes were never committed, and the file sat empty - so every one of those pointers led nowhere.
>
> Rather than leave four dangling references, this is the **decision record** they were reaching
> for: the choices the survey produced, each stated against the code that implements it and the
> installed package version it was checked against. It is reconstructed from the implementation and
> the surviving prose in `docs/uniswap-v4.md`, not from the original session - so it records *what
> was decided and why*, and does not pretend to reproduce the exploration that got there.

Checked against `@uniswap/v4-core@1.0.2` and `@uniswap/v4-periphery@1.0.3`, the versions pinned in
`package.json`.

---

## 1. Which callbacks the hook implements

**Decision: `beforeSwap` only.**

`getHookPermissions()` enables exactly one flag and declares every other permission `false`
(`contracts/uniswap/ConditionalLiquidityHook.sol`). v4 validates that declaration against the low 14
bits of the hook's own address at construction, so the set is not merely documented - a hook whose
address disagrees with it cannot be deployed at all (§4 below).

Conditional liquidity is a constraint on *how much may be swapped*, evaluated immediately before the
swap happens. `beforeSwap` is the only callback positioned to answer that question. Adding liquidity
callbacks would mean the hook had opinions about LP positions, which is a different product;
`afterSwap` would mean acting on a trade already committed.

## 2. Revert versus truncation - the decision that mattered most

**Decision: reject an oversized trade with a hard revert. Never silently shrink it.**

v4 offers both. A hook holding `BEFORE_SWAP_RETURNS_DELTA_FLAG` may return a non-zero
`BeforeSwapDelta` and take part in swap accounting, which would let this hook quietly reduce an
oversized swap to the cap instead of refusing it. That capability exists in the installed version
(`Hooks.sol` carries `beforeSwapReturnDelta` in its permissions struct, and
`Hooks.beforeSwap` returns `amountToSwap`), so declining it was a choice, not a limitation.

It was declined because **the two backends must behave identically for the same registered
strategy**, and the Aqua/SwapVM backend cannot truncate: `ConditionalLiquidityExtruction` reverts
`ExceedsEffectiveLiquidity` when a request exceeds the strategy's effective liquidity. A v4 pool that
silently filled a smaller amount would make one strategy mean two different things depending on
which venue executed it - and a trader could not tell which they had got without reconciling the
receipt. So `beforeSwapReturnDelta` stays `false`, the success path returns
`BeforeSwapDeltaLibrary.ZERO_DELTA`, and swap accounting is left completely untouched.

The cost is accepted deliberately: a trader who asks for more than the cap gets nothing rather than
a partial fill. That is the same answer Aqua gives, which is the point.

## 3. Where the strategy state lives

**Decision: the hook holds no rule logic, and no copy of the state machine.**

`RuleEngineLib` is invoked from exactly one place in the entire protocol -
`ConditionalLiquidityEngine`. The hook reaches it through `ENGINE.poke(strategyId)`, the same
permissionless state advance the SwapVM path drives through `ConditionalLiquidityExtruction`. The
association from `PoolId` to strategy lives in `HookStrategyAdapter`, which deliberately has no
`PoolManager` dependency at all, so it can be reasoned about and tested without v4 in the picture.

This is what makes "one strategy, two venues" true rather than aspirational:
`test/integration/StrategyEquivalence.t.sol` drives both backends from one registered strategy and
asserts they agree.

`poke` running inside the swap transaction has a consequence worth stating: if the trade is then
rejected, the state advance is undone with it. Solidity's revert semantics unwind the whole call
frame, so a refused swap leaves no trace - including no committed mode transition.

## 4. Address mining

**Decision: mine with `HookMiner`; never `new` the hook directly.**

v4 encodes a hook's permissions in the low 14 bits of its address, and `BaseHook`'s constructor calls
`Hooks.validateHookPermissions`, which reverts when those bits disagree with `getHookPermissions()`.
A plain `new ConditionalLiquidityHook(...)` therefore cannot work.

`@uniswap/v4-periphery` publishes `HookMiner` under `src/` (not as a test-only helper), so it is a
supported dependency rather than a vendored copy. The one sharp edge is that its `deployer` argument
differs by context, and getting it wrong produces an address mismatch rather than a useful error -
see `docs/uniswap-v4.md` §9 for the three cases and which script uses which.

## 5. Fee override

**Decision: always return the override; let the pool decide whether it applies.**

The hook returns `spreadBps * 100 | LPFeeLibrary.OVERRIDE_FEE_FLAG`, converting protocol basis points
to v4's hundredths-of-a-bip fee units. `PoolManager` ignores an override on a pool that was not
created with `LPFeeLibrary.DYNAMIC_FEE_FLAG`, so returning it unconditionally is safe and keeps the
hook usable on both kinds of pool without branching on pool configuration it does not own.

The live Sepolia pool *is* dynamic-fee, so the strategy's spread is genuinely in force there - see
`docs/sepolia-deployment.md`.

## 6. What was left out of the MVP

Stated so the absences read as decisions rather than oversights:

- **No liquidity-lifecycle callbacks.** The hook governs swap size, not LP positions.
- **No custom accounting.** See §2.
- **No oracle inside the hook.** Market conditions arrive through `IMarketStateProvider`, the same
  interface the Aqua backend reads, so the two venues cannot diverge on what "the market" is.
- **No per-pool rule programs.** A pool is bound to a strategy that already exists in the registry;
  the hook does not compile, store or interpret rules of its own.

## Related

- `docs/uniswap-v4.md` - the full backend walkthrough: enforcement, caps, mining, test architecture.
- `docs/architecture.md` Part 5 - where this sits in the system.
- `docs/sepolia-deployment.md` - the live deployment, running on Uniswap's own Sepolia `PoolManager`.
