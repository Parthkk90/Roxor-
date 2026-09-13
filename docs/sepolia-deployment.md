# Ethereum Sepolia deployment

```text
Network   Ethereum Sepolia
Chain ID  11155111
Deployer  0x025e4Cd04a671C309572fA3E6dEc9A8C79b847F4
Label     Ethereum Sepolia · TESTNET
```

Every address, figure and transaction hash in this document was read back from Sepolia after the
fact. Nothing here is transcribed from a broadcast log or a screenshot. The scripts that produced
them are checked in under `scripts/audit/` and can be re-run against the live chain:

```bash
npm run sepolia:audit      # bytecode.mjs + bytecode-ci.mjs + official.mjs - §1's evidence
npm run sepolia:verify     # verify-live.mjs - the deployed marketplace, layer by layer
npm run sepolia:manifest   # regenerates deployments/11155111.json from chain
npm run sepolia:txs        # regenerates §7's transaction table from receipts

node scripts/audit/legacy-stack.mjs   # reproduces §1.2: what the superseded deployment does
node scripts/audit/pool.mjs           # Uniswap v4 pool + hook state
```

`deployments/11155111.json` is the machine-readable form of everything below. It is generated, not
hand-written: `script/DeploySepolia.s.sol` records the addresses it produced (a broadcast cannot
know its own transaction hashes), and `scripts/audit/manifest.mjs` then reads contracts, token
metadata, strategy state, the live liquidity breakdown and every receipt *back from Sepolia* to
complete it. `npm run sepolia:manifest -- --check` fails if it has drifted from the chain.

---

## 1. What the audit found

Sepolia already carried a deployment before this work. It was **not** discarded, and it was not
trusted either. Two prior broadcast runs were reconstructed from `broadcast/*/11155111/`, every
address they created was checked for code, and that code was compared against artifacts this
repository builds today.

### 1.1 The `DeploySolver` run is partly invalid

`AquaSwapVMRouter` compiles to **26,774 bytes** under this project's default profile
(`optimizer_runs = 44_444_444`), which is over the EIP-170 limit of 24,576. On anvil that is
invisible; on a real chain the deployment succeeds and the account is left with **empty code**.

That is exactly what happened. `0x302cd5b134a1005b4700e3687445d9825ede09ea` holds **0 bytes**. Every
contract built on it in that run - the strategy shipment, its `AquaVenue` - was therefore dead on
arrival. `script/DeployAquaFix.s.sol` was written to redeploy that half under `FOUNDRY_PROFILE=ci`
(`optimizer_runs = 700`), which brings the router to 20,442 bytes. The live router
`0x8FCF...EAEC` is exactly 20,442 bytes, matching `out-ci/` byte for byte in length.

### 1.2 The marketplace layer was obsolete

The three contracts that make up the marketplace itself predated the executable-liquidity work:

| Contract | On-chain size | Current artifact | Verdict |
|---|---|---|---|
| `AquaVenue` `0x47da...fCe1` | 5,365 B | 6,286 B | stale |
| `Solver` `0xD8F2...b57A` | 3,018 B | 4,756 B | stale |
| `UniswapV4Venue` `0x2936...B120` | 3,934 B | 4,920 B | stale |

Behaviour confirmed it. Against the current ABI (`node scripts/audit/legacy-stack.mjs`):

```text
aquaVenue.STRATEGY_ID()            -> 0xd4e2967…a2df      (the contract is reachable)
aquaVenue.snapshot(A,B)            -> Position 223 is out of bounds (0 < position < 192)
aquaVenue.executableLiquidity(A,B) -> reverted
```

Decoded against the shape those contracts *do* return, `snapshot` reads cleanly - which is what
proves this is a version mismatch and not an unreachable contract.

192 bytes is a six-field `VenueSnapshot`; the current one has seven (`coverageBps` was added with
the solvency work), and `executableLiquidity` did not exist on those contracts at all.

**The consequence is the finding that mattered.** The single property this product exists to
demonstrate - that the solver routes against liquidity which can actually execute, never against
advertised depth - was *absent from the public deployment*. The frontend read both venues as
permanently unavailable. `app/README.md` already said so; the audit confirmed it independently and
established precisely which contracts were at fault.

### 1.3 Everything else was current and was reused

| Component | Address | Evidence |
|---|---|---|
| `MockERC20` "Demo Token B" (DTB) | `0x246b76e37825a473Ae784Ce14A2Bb42733A8f922` | 2,687 B, 99.96% identical to artifact (remainder: immutable `_DECIMALS`) |
| `MockERC20` "Demo Token A" (DTA) | `0xFE14a75D92e1A028ebb497dAc4D25bF2e08B3Af3` | as above |
| `Aqua` | `0xB9e780c07B3d36Af0090B011bd0233Ca8b212844` | 2,678 B, **100.00%** identical to the `ci` artifact |
| `AquaSwapVMRouter` | `0x8FCF7D68df61a9FCf2009e606ff632E97BdDEAEC` | 20,442 B, 98.01% identical (remainder: constructor immutables) |
| `StrategyValidator` | `0xfB60848dA80E110836959714bB9AF4ABa17CC5ec` | 2,291 B, **100.00%** identical |
| `ConditionalLiquidityRegistry` (Aqua) | `0x9888e8C6CffBEbF792C6B0B3d1085B7B11Da61a7` | 5,303 B, 99.24% identical; `stateAuthority` = the engine below |
| `ConditionalLiquidityEngine` (Aqua) | `0x1ee607310423099D47F3B35d59F8BB66690EC952` | 4,920 B, 97.12% identical; `REGISTRY`/`ORACLE` point where they should |
| `ConditionalLiquidityExtruction` | `0xb21Bf6e48FbcFDf83a7685924A244510Db08bC75` | 1,795 B, 94.26% identical |
| `MockMarketStateProvider` (Aqua) | `0x40b30ECEF85Ea5E850373544ba3A6D02bd7b49a2` | 705 B, **100.00%** identical |
| `ConditionalLiquidityRegistry` (Uniswap) | `0x738b102E559EEBE23F5a67cC61798CBcB14284dB` | 7,569 B, 99.47% identical to the default-profile artifact |
| `ConditionalLiquidityEngine` (Uniswap) | `0x4670CC0Ab2322F5aFcaa9ec91ee3fbE0d35A2D55` | 5,980 B, 97.64% identical |
| `MockMarketStateProvider` (Uniswap) | `0xD0b139BF9c0576A96b48C3b9c3C5b0ed336cabF4` | 880 B, **100.00%** identical |

Where a figure is below 100%, every differing byte is an immutable or a constructor argument -
those are baked into deployed code, so an exact match is only expected for contracts that have
none, and all four such contracts match exactly.

**The Aqua strategy is live and funded.** `registry.isActive` is true, `getStrategy` returns
maker = the deployer and the DTB/DTA pair, and `Aqua.safeBalances` reports real shipped depth.
`script/DeploySepolia.s.sol` reconstructs the SwapVM order from first principles and asserts the
resulting id equals `0xd4e2967…a2df`, which is the only way to prove the reconstruction is exact.

### 1.4 A stale address in the shipped frontend

`app/src/config/markets.ts` carried the Aqua oracle as `0x40b30ecEf85eA5e850373544Ba3a6d02BD7b49A2`
- a **mis-checksummed** spelling of the real address (`0x40b30ECEF85Ea5E850373544ba3A6D02bd7b49a2`).
viem validates a mixed-case address against its checksum before it will send the call, so that read
threw in the browser regardless of what was deployed behind it. The last section of
`legacy-stack.mjs` demonstrates both spellings side by side. Corrected.

---

## 2. Deployment decision log

```text
Component:      Demo Token A / Demo Token B (DTA / DTB)
Decision:       REUSED
Address:        0xFE14a75D92e1A028ebb497dAc4D25bF2e08B3Af3 / 0x246b76e37825a473Ae784Ce14A2Bb42733A8f922
Reason:         Valid, clearly-labelled project test tokens already on Sepolia, already shipped
                into Aqua. Redeploying would have cost gas to arrive back where the chain was.
Dependencies:   none
Verification:   name/symbol/decimals read from chain; bytecode matches artifact

Component:      Aqua, AquaSwapVMRouter
Decision:       REUSED (the DeployAquaFix instances)
Address:        0xB9e780c07B3d36Af0090B011bd0233Ca8b212844 / 0x8FCF7D68df61a9FCf2009e606ff632E97BdDEAEC
Reason:         Compiled under FOUNDRY_PROFILE=ci, so the router is under EIP-170 and actually has
                code. The DeploySolver-run router does not.
Dependencies:   MockWETH 0x8D302A3123b6C710f9ee5D858e3B06AB0b6f478D
Verification:   20,442 bytes on chain == 20,442 bytes in out-ci/; safeBalances answers

Component:      AquaSwapVMRouter 0x302cd5b134a1005b4700e3687445d9825ede09ea
Decision:       INVALID / REPLACED
Reason:         Deployed with EMPTY code - the EIP-170 failure described above.
Verification:   eth_getCode returns 0x

Component:      ConditionalLiquidityRegistry / StrategyValidator / Engine / Extruction / oracle
Decision:       REUSED (both the Aqua set and the Uniswap set)
Reason:         Bytecode matches current source; strategies registered, active, correctly wired.
Verification:   see the table in §1.3; stateAuthority, REGISTRY and ORACLE all read back correct

Component:      Uniswap v4 PoolManager
Decision:       REUSED - Uniswap's own, NOT the project's copy
Address:        0xE03A1074c86CFeDd5C142C4F04F1a1536e203543
Reason:         The earlier run deployed a second, private PoolManager (0x7C88...Ba21, owner = this
                project's deployer). That is duplicate protocol infrastructure. Uniswap publishes a
                real one on Sepolia, and a hook that claims to be a Uniswap v4 integration should
                run on it.
Dependencies:   official PoolSwapTest 0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe,
                official PoolModifyLiquidityTest 0x0C478023803a644c94c4CE1C1e7b9A087e411B0A
Verification:   24,009 bytes; extsload answers; owner() = 0x5b73C549... (Uniswap's, not ours).
                ABI compatibility with this repo's @uniswap/v4-core 1.0.2 was proven by running the
                whole deployment against a Sepolia fork before broadcasting - see §5.

Component:      Project PoolManager 0x7C881eb559C77d67c94287Ca9AdEE7944D43ba21
Decision:       NOT USED (left in place, not referenced)
Reason:         A privately-owned duplicate of protocol infrastructure that genuinely exists on this
                network. Its pool still holds ~1,000,000 of each token, which is also far more
                artificial depth than this demonstration needs.

Component:      ConditionalLiquidityHook
Decision:       REDEPLOYED
Address:        0xa05d48D7b56759aeBdb73A3bB6ffF179bd74c080
Reason:         A v4 hook binds to its PoolManager at construction, so moving onto Uniswap's manager
                necessarily means a new hook. Its address is CREATE2-mined to carry the BEFORE_SWAP
                permission bit v4 requires. The *strategy* behind it is the one already registered.
Dependencies:   the reused Uniswap-side registry + engine
Verification:   getPoolStrategy/quoteSnapshot answer for the new pool; beforeSwap fires on the
                settlement transaction

Component:      AquaVenue
Decision:       REDEPLOYED
Address:        0x6334836551C4088f66127762a9968747266D0d3e
Reason:         The deployed one had no executableLiquidity() and a six-field snapshot - i.e. no
                no-phantom-liquidity enforcement at all.
Dependencies:   reused Aqua, router, registry, engine, strategy id
Verification:   executableLiquidity returns the full solvency breakdown; snapshot.effectiveLiquidity
                is byte-equal to its conditionalLiquidity

Component:      UniswapV4Venue
Decision:       REDEPLOYED
Address:        0x065CfB8B2241bEd17FC6d6a16c0432b8D0641Ca7
Reason:         Same staleness, plus it had to be rebound to the official PoolManager.
Verification:   as above, against the new pool

Component:      Solver
Decision:       REDEPLOYED
Address:        0x5c8f7f0556a4935d6f0DbA4FB6e44F19e89Af354
Reason:         The deployed one predates settlement-time revalidation and per-leg LegExecuted
                attribution.
Verification:   a real settle() split across both venues and emitted both LegExecuted events

Component:      Official Sepolia USDC
Decision:       EVALUATED, NOT USED
Address:        0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
Reason:         See §3.
```

---

## 3. Token policy: why not USDC

The requirement is to prefer legitimate public Sepolia assets, and to fall back to project-created
test tokens only if the demonstration cannot be made self-sufficient with them. It was checked
rather than assumed.

Circle's official Sepolia USDC exists at `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (verified on
chain: `USDC`, 6 decimals, real supply). **The deployer holds 2.000000 USDC of it.**

Two USDC cannot fund this demonstration, and the shortfall is structural rather than cosmetic. The
marketplace needs, simultaneously:

1. an Aqua maker holding inventory on *both* sides of the pair;
2. a Uniswap v4 pool holding real reserves on *both* sides;
3. headroom above the maker's deliverable depth, or there is no phantom-liquidity gap to show;
4. a trader with a balance that is not the maker's balance.

More USDC is only obtainable from Circle's faucet, which is a human, browser-gated action. Pairing
USDC against WETH would additionally require spending the deployer's remaining Sepolia ETH, which is
the one resource here that cannot be replaced either.

So: **project test tokens, and the ones that already exist.**

| Token | Address | Provenance | Decimals | Used |
|---|---|---|---|---|
| Demo Token B (`DTB`) | `0x246b76e37825a473Ae784Ce14A2Bb42733A8f922` | Project-created, Sepolia | 18 | yes - `tokenIn` |
| Demo Token A (`DTA`) | `0xFE14a75D92e1A028ebb497dAc4D25bF2e08B3Af3` | Project-created, Sepolia | 18 | yes - `tokenOut` |
| USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | Circle, official Sepolia | 6 | no - see above |

Neither token is named, styled or described as any real asset. `MockERC20.mint` is unpermissioned on
these deployments, which is what lets any visitor self-serve a balance; the UI says so in the same
place it offers the faucet.

---

## 4. The deployed market

**One market, not three.** The anvil demo deploys three because a local chain's tokens and gas are
free. On a public testnet a second and third market would demonstrate no property the first does
not, at the cost of real Sepolia ETH.

| Component | Address | Reused / New | Deployment tx | Verified |
|---|---|---|---|---|
| Solver | `0x5c8f7f0556a4935d6f0DbA4FB6e44F19e89Af354` | New | `0x27e6385…e1f7` | yes |
| AquaVenue | `0x6334836551C4088f66127762a9968747266D0d3e` | New | `0x6dfdceb…52c5` | yes |
| UniswapV4Venue | `0x065CfB8B2241bEd17FC6d6a16c0432b8D0641Ca7` | New | `0xb04ef42…1c89` | yes |
| ConditionalLiquidityHook | `0xa05d48D7b56759aeBdb73A3bB6ffF179bd74c080` | New | `0x586e8f8…6f66` | yes |
| Aqua | `0xB9e780c07B3d36Af0090B011bd0233Ca8b212844` | Reused | (prior run) | yes |
| AquaSwapVMRouter | `0x8FCF7D68df61a9FCf2009e606ff632E97BdDEAEC` | Reused | (prior run) | yes |
| Registry (Aqua) | `0x9888e8C6CffBEbF792C6B0B3d1085B7B11Da61a7` | Reused | (prior run) | yes |
| Engine (Aqua) | `0x1ee607310423099D47F3B35d59F8BB66690EC952` | Reused | (prior run) | yes |
| Extruction | `0xb21Bf6e48FbcFDf83a7685924A244510Db08bC75` | Reused | (prior run) | yes |
| Market-state provider (Aqua) | `0x40b30ECEF85Ea5E850373544ba3A6D02bd7b49a2` | Reused | (prior run) | yes |
| Registry (Uniswap) | `0x738b102E559EEBE23F5a67cC61798CBcB14284dB` | Reused | (prior run) | yes |
| Engine (Uniswap) | `0x4670CC0Ab2322F5aFcaa9ec91ee3fbE0d35A2D55` | Reused | (prior run) | yes |
| Market-state provider (Uniswap) | `0xD0b139BF9c0576A96b48C3b9c3C5b0ed336cabF4` | Reused | (prior run) | yes |
| PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` | Reused (Uniswap's) | n/a | yes |
| PoolSwapTest | `0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe` | Reused (Uniswap's) | n/a | yes |
| PoolModifyLiquidityTest | `0x0C478023803a644c94c4CE1C1e7b9A087e411B0A` | Reused (Uniswap's) | n/a | yes |

| Pair | Aqua | Uniswap v4 | Strategy | Status |
|---|---|---|---|---|
| DTB / DTA | yes, shipped | yes, dynamic-fee pool, tick spacing 60 | volatility shield | live |

Pool id `0xb2917d9aa516adc6ffa78f862ba4282aa025b43cb746562da0c7e8f926d96ad9`.

| Market | Condition | Defensive % | Recovery | Current state |
|---|---|---|---|---|
| DTB/DTA (Aqua) | volatility ≥ 50% | 25% at 90 bps | < 30% for 10 min → 50% at 50 bps, then 10 min → 100% | NORMAL |
| DTB/DTA (Uniswap v4) | volatility ≥ 50% | 25% | same program | NORMAL |

Both strategies run the same rule program; they are driven by *separate* market-state providers on
purpose, so one venue can be shocked while the other stays calm and the solver's reallocation is
visible.

### Liquidity, as the chain reports it

Read with `node scripts/audit/verify-live.mjs`, DTB side:

```text
Aqua / SwapVM
  advertised  104.0002      (Aqua virtual balance - an allowance, not custody)
  wallet        8.000000    (what the maker actually holds)
  allowance       MAX
  deliverable   8.000000    = min(advertised, wallet, allowance)
  executable    8.000000    = deliverable x 100%   (NORMAL)
  coverage          769 bps

Uniswap v4
  advertised   10.000000    (the hook's conditional ceiling)
  wallet       20.999999    (the PoolManager's real reserves)
  allowance       MAX       (a pool holds its own reserves; nobody can revoke)
  deliverable  10.000000
  executable   10.000000
  coverage       10000 bps
```

The maker's wallet was deliberately trimmed to a fraction of what Aqua advertises. That is the whole
demonstration: an advertised 104 that can only pay 8, and a solver that routes against the 8.

---

## 5. Testing

Run before broadcasting anything:

```bash
forge test                 # 163 passed, 0 failed
npm run test:compiler      # 75 passed, 0 failed  (vitest)
npm run typecheck          # clean
npm run fmt:check          # clean
cd app && npx tsc -b && npm test   # clean; 52 passed, 0 failed
```

And the gate that actually decided whether to spend testnet ETH:

```bash
forge test --match-path "test/fork/SepoliaMarketplaceFork.t.sol" -vv
```

That suite runs the entire deployment plan against a fork of live Sepolia and then trades through
it. It is the only thing that could answer the questions a local test cannot:

```text
[PASS] test_ReconstructedOrderMatchesTheStrategyAlreadyShippedIntoAqua
[PASS] test_ReusedAquaStrategyIsLiveAndShipped
[PASS] test_BothVenuesExposeExecutableLiquidityBoundedByRealSolvency
[PASS] test_SolverNeverRoutesBeyondExecutableLiquidity
[PASS] test_SettlesARealSwapAcrossTheLiveSepoliaStack
[PASS] test_PhantomLiquidityPushesTheRouteOntoUniswap
[PASS] test_ShockingTheOracleCollapsesExecutableDepthOnChain
```

In particular it proved that Uniswap's own Sepolia `PoolManager`, `PoolSwapTest` and
`PoolModifyLiquidityTest` are ABI-compatible with the v4-core version this repository compiles
against, *before* the migration was broadcast.

---

## 6. Real Sepolia execution

### The swap

Trader `0xcC2a17Bd2708b4c7A99A3a8cafAe85e1e128cC4d` (a second account, so the maker's wallet balance
can be constrained without starving the trader), 5 DTB in:

```text
route quote      5.000000000000000000 DTB
                 -> Aqua      4.000000000000000000 DTB   (its entire executable depth)
                 -> Uniswap   1.000000000000000000 DTB
                 expected out 6.985976072023760000 DTA

settle           0xb55c0a7d792fecc4ef264620022574737448f5621237ad78b282abec67272009
block            11695622      gas 1,161,142      status success
actual out       6.708236463559693850 DTA
```

The two `LegExecuted` events the settlement emitted:

```text
venue 0x6334...0d3e  strategyId 0xd4e2967…a2df  in 4.000000  out 5.757669742919632892  executable 4.000000  spread 20bps
venue 0x065C...1Ca7  strategyId 0xacdbaa7…d911  in 1.000000  out 0.950566720640060958  executable 10.000000 spread 20bps
```

`executable` on the Aqua leg is exactly the amount routed. The invariant
`route amount <= executable liquidity` held with equality - the solver filled Aqua to its real
ceiling and put the remainder on the pool, which is precisely the behaviour the product claims.

Realised output came in below quote because both backends price with slippage the flat reference
price does not model: the first attempt at a 6.8 DTA floor was **rejected on-chain** with
`SlippageExceeded(6.708…, 6.800…)` before being re-sent at a floor the market could meet. That
rejection is worth recording - the floor is enforced by the contract, not by the interface.

### The strategy builder

The frontend's configuration surface was exercised on chain, not just typechecked. Using the same
modules the browser loads - `app/src/strategy/order.ts` for the SwapVM order and the project's own
CLF backend for the rule program - a **second maker** registered a strategy with thresholds of their
own (defensive at 40% volatility, recovery below 15%, five-minute calm gate, 15% defensive
liquidity):

```text
maker        0xcC2a17Bd2708b4c7A99A3a8cafAe85e1e128cC4d
strategyId   0x24f93d68f6c9770aa87cc147fd524cd79ef9d387f12c03ffcec3bb010ab6c726
tx           0x244d24d0462b2dabb88599cf95fb53aebd16686852fcd43bc257bedcab4b665d
block        11695893      gas 716,536      status success
```

`ConditionalLiquidityRegistry.getRuleProgram` reads the stored bytes back **byte-identical** to what
the browser emitted, and `getStrategy` shows the registry derived `tokenA`/`tokenB` from the order's
own data - so the encoding is right for a fresh order, not just for the one it was pinned against.

The strategy is registered but not funded: no depth has been shipped into Aqua behind it, so it
honestly reports zero executable liquidity. That is the no-phantom-liquidity rule applying to a
brand-new strategy exactly as it does to an old one.

### The state machine

Driven entirely by the deployed rule program reacting to the deployed market-state provider. React
was not involved, and no state was written directly.

```text
NORMAL      liquidity 10000 bps, spread 20 bps
  volatility -> 65%, Engine.poke
DEFENSIVE   liquidity  2500 bps, spread 90 bps    executable 8.000 -> 2.000
  solver reallocates: 5 DTB becomes Aqua 2.000 + Uniswap 3.000  (was Aqua 4 + Uniswap 1)
  volatility -> 24%, Engine.poke
DEFENSIVE   armedRule = 2, armedSince recorded - the 10-minute calm gate starts
  10 real minutes later, Engine.poke
RECOVERY    liquidity  5000 bps, spread 50 bps    transitionCount 2
  10 more real minutes, Engine.poke
NORMAL      liquidity 10000 bps, spread 20 bps    transitionCount 3
```

---

## 7. Every transaction

| Purpose | Transaction hash | Block | To | Value (ETH) | Gas used | Result |
|---|---|---|---|---|---|---|
| Deploy AquaVenue | `0x6dfdcebb3c7d207ef4a2d7465e215bd95ec2ccf64ecceec511a9222df21e52c5` | 11695586 | (contract creation) | 0 | 1,929,638 | success |
| Deploy ConditionalLiquidityHook (CREATE2, mined) | `0x586e8f84d75baaef4f350e008332bc889bb344fbcf087309acefd02c04356f66` | 11695588 | 0x4e59b44847b379578588920ca78fbf26c0b4956c | 0 | 2,040,339 | success |
| PoolManager.initialize (Uniswap's own Sepolia manager) | `0x192bfae1197318e90acc6214aefc7f6b0b87d3259ff0baeab7007f61d3e80bef` | 11695589 | 0xe03a1074c86cfedd5c142c4f04f1a1536e203543 | 0 | 51,699 | success |
| Hook.registerPoolStrategy (binds the existing strategy to the new pool) | `0x6a6b2e211a30333684aded100593817e9a3fa1ff15e9f37787c9edf77024485e` | 11695590 | 0xa05d48d7b56759aebdb73a3bb6fff179bd74c080 | 0 | 115,758 | success |
| Mint 25 DTB to fund the pool position | `0x7eeaa19aab6b1c58d21a7d3dbfd10f2f71cac04f871023301e93b06360f74c5e` | 11695592 | 0x246b76e37825a473ae784ce14a2bb42733a8f922 | 0 | 33,882 | success |
| Mint 25 DTA to fund the pool position | `0xf3f4ff56939ddd7a805478c7de648a766262db1a7cd922180a4764c09a4a8f67` | 11695593 | 0xfe14a75d92e1a028ebb497dac4d25bf2e08b3af3 | 0 | 33,882 | success |
| Approve DTB to the v4 liquidity router | `0xbc056129adad57374e2a2ddd3e137f37c65b3aedb08188bf9586223092dc9601` | 11695594 | 0x246b76e37825a473ae784ce14a2bb42733a8f922 | 0 | 45,942 | success |
| Approve DTA to the v4 liquidity router | `0xab75e94a2441278615615e808d8a91ab6f9e20017b2faddf74db677af6644c56` | 11695595 | 0xfe14a75d92e1a028ebb497dac4d25bf2e08b3af3 | 0 | 45,942 | success |
| Add full-range liquidity (20e18) | `0xe6f8b2db62f3acf617546d589d9dc861ccbd2bafa26579e542fa313eee734086` | 11695596 | 0x0c478023803a644c94c4ce1c1e7b9a087e411b0a | 0 | 299,810 | success |
| Deploy UniswapV4Venue | `0xb04ef42493c4d4b31782630d386c828437e78f4d17f1299ffcf6791c4b811c89` | 11695597 | (contract creation) | 0 | 1,195,366 | success |
| Deploy Solver | `0x27e638535920b8ff69ee5d749cfee2f63edde3b09ab3c939296da0d49a90e1f7` | 11695598 | (contract creation) | 0 | 1,175,803 | success |
| Fund the trader account with 0.01 ETH | `0xeaef5a62424c8c255c43970e39baefa50d608e3f9fd570334965f653f055a0e0` | 11695608 | 0xcc2a17bd2708b4c7a99a3a8cafae85e1e128cc4d | 0.01 | 21,000 | success |
| Trim the maker's DTB wallet to 4 (makes the solvency bound bind) | `0x960c2a208790c77a45f92b24dfe33d74ec0a03f119930f876f39fb5c2bd514b3` | 11695609 | 0x246b76e37825a473ae784ce14a2bb42733a8f922 | 0 | 51,127 | success |
| Trim the maker's DTA wallet to 200 | `0x9ce8bf3694cb50e263646ea6a7e9ff2e8b442a9226f00c115602dff3e2a2f61a` | 11695610 | 0xfe14a75d92e1a028ebb497dac4d25bf2e08b3af3 | 0 | 51,127 | success |
| Mint 6 DTB to the trader | `0xfd32d294dec12b77df0c49340dfd1e0d377362e9ae03ff48e0a21445219187dd` | 11695612 | 0x246b76e37825a473ae784ce14a2bb42733a8f922 | 0 | 50,970 | success |
| Trader approves the Solver for 5 DTB | `0x37ddbc19db4e7e4fa5db5146fc901e29aaf784abe218f564725d6373d6b04468` | 11695618 | 0x246b76e37825a473ae784ce14a2bb42733a8f922 | 0 | 45,930 | success |
| REAL SWAP: Solver.settle, 5 DTB -> 6.708 DTA across both venues | `0xb55c0a7d792fecc4ef264620022574737448f5621237ad78b282abec67272009` | 11695622 | 0x5c8f7f0556a4935d6f0dba4fb6e44f19e89af354 | 0 | 1,161,142 | success |
| Oracle: volatility 65% (shock) | `0x061caccfec374cd59230e48be87f679751f121486cb345d1eb345347d36a9346` | 11695628 | 0x40b30ecef85ea5e850373544ba3a6d02bd7b49a2 | 0 | 36,580 | success |
| Engine.poke -> NORMAL to DEFENSIVE | `0xd64095a11d83f9a36e29838c5c31ce9973adc08e8b0929c3e7048a6caf8a81d7` | 11695629 | 0x1ee607310423099d47f3b35d59f8bb66690ec952 | 0 | 197,823 | success |
| Oracle: volatility 24% (calm) | `0x55ee3690865caef0b8481aa3524d05e49f81d2d2a4e472bca9c49df36157e988` | 11695634 | 0x40b30ecef85ea5e850373544ba3a6d02bd7b49a2 | 0 | 36,580 | success |
| Engine.poke -> arms the 10-minute calm gate | `0x9c9123189ac67a4c8bbb70147f17e00d1c7210e6c02e611caffb4dcea5975b74` | 11695635 | 0x1ee607310423099d47f3b35d59f8bb66690ec952 | 0 | 134,911 | success |
| Engine.poke -> DEFENSIVE to RECOVERY (after 10 minutes of calm) | `0x8ba966ad034d13db0895ad482c63537054e551749d34c27b85277bc98fca28ec` | 11695689 | 0x1ee607310423099d47f3b35d59f8bb66690ec952 | 0 | 146,837 | success |
| Engine.poke -> RECOVERY to NORMAL (after 10 more minutes) | `0xaabc3f66e4427e0f88624f29adfa11c0f7141c4bc4c1d8802ae74f271a8b6bba` | 11695737 | 0x1ee607310423099d47f3b35d59f8bb66690ec952 | 0 | 148,808 | success |
| Strategy registered from the frontend's builder path (a second maker, their own thresholds) | `0x244d24d0462b2dabb88599cf95fb53aebd16686852fcd43bc257bedcab4b665d` | 11695893 | 0x9888e8c6cffbebf792c6b0b3d1085b7b11da61a7 | 0 | 716,536 | success |
| UI check: volatility 65% (shock) | `0x1dd556a0e91434722b8c031ff6604e9b27f1e0f99d240c9e9fdc9bd033c13f74` | 11696036 | 0x40b30ecef85ea5e850373544ba3a6d02bd7b49a2 | 0 | 36,580 | success |
| UI check: volatility 24% | `0xcbf45dc412b92bce4785a65cd5c368a9c8c77234b498f25d4a71c5721aa04f4a` | 11696052 | 0x40b30ecef85ea5e850373544ba3a6d02bd7b49a2 | 0 | 36,580 | success |
| UI check: volatility 65% (shock) | `0x707f29137d8d98891d9e40583ba12026daf36b14b493ba439a31506f716ede0b` | 11696056 | 0x40b30ecef85ea5e850373544ba3a6d02bd7b49a2 | 0 | 36,580 | success |
| UI check: volatility 20% (restored to calm) | `0x1abc061cef80f54ea20ddad9ee9170c2622bf6a3f5a178e1b2486ff71ff9491c` | 11696093 | 0x40b30ecef85ea5e850373544ba3a6d02bd7b49a2 | 0 | 36,580 | success |

Total: 28 transactions, 9,913,752 gas, 0.010447113729068951 ETH in fees.

Of the deployer's starting `0.0958` ETH, `0.0100` was transferred to the trader account (which then
paid for the swap and the strategy registration out of it). Across both accounts the whole exercise
- deployment, configuration, a real swap, a strategy registration and the market-state changes used
to verify the interface - burned roughly **0.011 ETH of gas**.

---

## 8. Reproducing this

```bash
# 1. Verify the reused state is still what this document says it is.
forge test --match-path "test/fork/SepoliaMarketplaceFork.t.sol" -vv

# 2. Deploy only what is missing. Writes deployments/11155111.json.
forge script script/DeploySepolia.s.sol:DeploySepolia \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$SEPOLIA_PRIVATE_KEY" \
  --broadcast --disable-code-size-limit --slow

# 3. Read the result back from chain and rewrite the manifest from it.
npm run sepolia:verify
npm run sepolia:manifest

# 4. Point the UI at it: copy the addresses from deployments/11155111.json into
#    app/src/config/markets.ts (SEPOLIA_MARKETS), then
cd app && npm install && npm run dev
```

`SEPOLIA_PRIVATE_KEY` is read from a `.env` file that is gitignored and must never be committed.
Use a dedicated disposable testnet wallet; before broadcasting, confirm the key resolves to the
expected deployer.

---

## 9. Limitations

These are real and are not worked around anywhere in the UI.

**The market-state provider is not an oracle.** `MockMarketStateProvider` is project-deployed demo
infrastructure with **no access control**: any address can call `setVolatility`. That is deliberate
- it is what makes the regime machine demonstrable to a visitor - and it is labelled *controlled
market state* wherever it is exposed. It must never be read as production risk data. No price,
volatility or confidence figure in this deployment has any relationship to a real market.

**The tokens are project test tokens.** DTA and DTB are this project's own Sepolia ERC-20s with an
unpermissioned `mint`. They carry no value and impersonate nothing. Their total supply is
absurdly large because an earlier deployment minted `type(uint128).max` to seed a pool; the figures
that matter - what Aqua advertises, what the maker holds, what the pool holds - are all small and
deliberate.

**Maker, liquidity provider and deployer are one account.** A separate account is used for the
trader, because the phantom-liquidity demonstration requires constraining the maker's wallet
without starving the trader. Everything else is one EOA, which a real deployment would not do.

**Sepolia liquidity is thin by design.** The Uniswap pool holds roughly 20 of each token and the
Aqua maker holds single digits. Trades beyond a handful of tokens will move the price noticeably or
fail to route at all. That is the minimum-spend policy working, not a bug: the point is to prove the
mechanism, not to simulate depth.

**The recovery cycle takes real time.** DEFENSIVE → RECOVERY → NORMAL needs ten real minutes of
sustained calm and then ten more, enforced on-chain. There is no way to fast-forward a public
network's clock. A shock is instant; a full recovery is a twenty-minute wait plus two pokes.

**Historical reliability needs an indexer.** `subgraph/subgraph.yaml` is pointed at this deployment
with real start blocks, but the subgraph has not been deployed - that needs a Graph Studio account.
Until it is, and without `VITE_SUBGRAPH_URL`, the reliability column reads `-`. A plausible
placeholder next to chain-read figures would be the only number on the screen a reader could not
verify, so there is none.

**Contracts are not Etherscan-verified.** Source verification was not performed; the bytecode
comparison in §1 is the evidence offered instead, and it is reproducible with
`node scripts/audit/bytecode.mjs`.
