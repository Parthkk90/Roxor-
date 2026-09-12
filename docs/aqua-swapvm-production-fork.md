# Real Aqua + SwapVM production fork test

`test/fork/AquaSwapVMMainnetFork.t.sol` — the Aqua/SwapVM counterpart to
`test/fork/UniswapMainnetFork.t.sol`. Verifies this project's Parts 1–4 implementation against the
actual deployed 1inch Aqua and AquaSwapVMRouter contracts on Ethereum mainnet, not a local
redeployment.

## Reproduce

```bash
RPC_URL=https://ethereum-rpc.publicnode.com npm run test:fork:aqua
```

Same free-tier archive limitation as the Uniswap fork test applies here (see
`docs/uniswap-v4.md` §11): leave `FORK_BLOCK` unset with a free-tier RPC, since it rejects any
explicit block number. Last verified passing at block **~25,910,622**, chain ID **1**.

## Production addresses (verified, not invented)

| Contract | Address | Verified via |
|---|---|---|
| Aqua | `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` | Official `1inch/aqua` README; `eth_getCode` on-chain |
| AquaSwapVMRouter | `0x111111338c5091E8440b67B168bAe16a668AC0De` | Official `1inch/swap-vm` README; `eth_getCode` on-chain |
| WETH9 | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | `symbol()` returned `"WETH"` on-chain |
| Lido stETH | `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84` | Lido's own docs (`docs.lido.fi/contracts/lido`); `symbol()` returned `"stETH"` on-chain |

Both 1inch addresses are deterministic — identical across every chain 1inch has deployed to.

## What's real, what's ours, what's test-only

- **Real production, unmodified:** Aqua (all of `ship`/`pull`/`push`/`safeBalances`/`rawBalances`),
  WETH9, Lido stETH. No mock tokens, no mock Aqua, no `vm.store`/`vm.etch` on any of these.
- **Our own code, unmodified from Parts 1–4:** `StrategyValidator`, `ConditionalLiquidityRegistry`,
  `ConditionalLiquidityEngine`, `ConditionalLiquidityExtruction`, `ConditionalLiquidityProgramLib`,
  `MakerTraitsLib.build` (the pinned `@1inch/swap-vm` package's own encoder). `MockMarketStateProvider`
  is our own oracle stand-in, exactly as in every other test in this repo.
- **One test-only technique, clearly bounded:** `vm.prank(ROUTER_ADDR)` around the `Aqua.push`/
  `Aqua.pull` calls that settle a trade. This does not touch any contract's storage or bytecode —
  it only asserts which address a call originates from, standard Foundry fork-testing practice. It
  exists because of the limitation below.

## The genuine limitation: SwapVM version drift

This project's `@1inch/swap-vm` dependency is pinned to a `main` commit newer than any tagged
release (see `docs/uniswap-v4-implementation-notes.md`'s note on why: the mainnet-deployed contract
predates that commit). Diagnosed directly, not assumed:

- `swap()`/`quote()` selectors computed from the pinned package's signature
  (`(Order,uint256,bytes)`) do not appear anywhere in the deployed router's bytecode.
- Selectors computed from the last tagged release's signature instead
  (`v1.0.2`: `(Order,address tokenIn,address tokenOut,uint256,bytes)`) **do** appear — the live
  router matches that older, explicit-tokenIn/tokenOut calling convention.
- `v1.0.2`'s `TakerTraitsLib` has no `isAToB`/`allowPartialFill` bits that the pinned package's
  encoder produces — even calling the right function wouldn't produce compatible calldata.
- The router's opcode dispatch differs too: `v1.0.2` assigns `XYCSwap`/`Extruction` array-index
  opcodes `0x12`/`0x21`; the pinned package assigns them enum-slot opcodes `0x50`/`0x04`. A program
  built with `ConditionalLiquidityProgramLib` would dispatch to the wrong instruction (or an
  out-of-bounds one) if submitted to the live router's `swap()`.
- Aqua itself has **not** drifted: all six of its selectors (`ship`, `dock`, `pull`, `push`,
  `safeBalances`, `rawBalances`) matched the deployed bytecode exactly.

**Consequence:** this project's existing `ConditionalLiquidityExtruction`/
`ConditionalLiquidityProgramLib` cannot be driven through the live router's `swap()` entrypoint
without either re-pinning `@1inch/swap-vm` to the older release and reshaping `SwapRegisters`/opcode
encoding to match (out of scope — that's rewriting Parts 1–4), or deploying a second, differently
coded router and calling it "production" (explicitly disallowed). The test calls
`ConditionalLiquidityExtruction` directly instead — exactly the pattern already used in
`test/unit/ConditionalLiquidityExtruction.t.sol` — and settles the resulting amounts through the
real Aqua under the router-address prank described above.

## Relationship to the marketplace solvency bound

The marketplace layer now bounds Aqua-backed depth by `min(virtual balance, maker wallet balance,
maker allowance)` — see `docs/architecture.md` §7.2. That bound does **not** weaken this test's
"real Aqua, unmodified" claim: it lives entirely in `contracts/venues/AquaVenue.sol`, an adapter
*above* Aqua, and reads only `balanceOf`/`allowance`. Aqua itself is still called exactly as
deployed, and this test exercises `ConditionalLiquidityExtruction` directly rather than through the
venue adapter, so it is unaffected either way.

If anything this test is the evidence for why that bound exists: it is what confirmed that
`Aqua.pull` settles out of the maker's own wallet rather than from custody.

## Test coverage

1. Chain ID 1, real code at all four addresses.
2. Register + ship real WETH/stETH to real Aqua; strategyHash matches the registry's strategyId.
3. NORMAL: a real 1 WETH trade settles, real balance changes on both sides (WETH exact,
   stETH within ±2 wei — see below).
4. DEFENSIVE: a real volatility shock (via a small real trade) commits the transition; an
   oversized trade reverts with the real, unmodified `ExceedsEffectiveLiquidity` error; no balance
   moves on the rejected trade; a smaller trade still settles.
5. Full recovery cycle: DEFENSIVE → (sustained calm) → RECOVERY → (recovery period) → NORMAL,
   each step driven by a real settled trade.

**stETH ±2 wei tolerance:** Lido's stETH is a real shares-based rebasing token — `transferFrom`
converts the requested amount to internal shares and back, which can differ from the requested
amount by a wei or two (visible directly in the test's trace via stETH's own `TransferShares`
event). This is genuine stETH behavior, not a bug in this project's contracts, so WETH balance
deltas are asserted exactly and stETH deltas are asserted with `assertApproxEqAbs(..., 2)`.
