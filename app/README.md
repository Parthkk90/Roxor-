# Conditional Liquidity Marketplace - Frontend

A web UI for the conditional-liquidity marketplace (see [`../docs/architecture.md`](../docs/architecture.md)).
Connect a wallet via Privy, get test tokens, see live liquidity across the Aqua and Uniswap v4
venues, configure a conditional strategy, get a routed quote, and swap. A demo panel triggers a
market shock so you can watch the strategy state machine react live.

**Defaults to Ethereum Sepolia** (chain ID `11155111`), against the deployment documented in
[`../docs/sepolia-deployment.md`](../docs/sepolia-deployment.md). It targets anvil only when
`VITE_CHAIN_ID=31337` is set explicitly, and never falls back to `127.0.0.1:8545` on its own. Every
screen carries an `Ethereum Sepolia · TESTNET` chip, because every figure on every screen is a
testnet figure.

## What a first-time reader should take away

The interface is built around one claim, and the layout is the argument for it:

1. **Market conditions** - the regime, the volatility driving it, and how much of what sources
   *could* deliver they are currently willing to quote.
2. **Aqua strategy** - the conditional-liquidity mechanism itself, on the main screen rather than
   only behind a drawer: its state, its current multiplier, and one sentence on what that means.
3. **Your route** - how the Solver split *this* order, above the source cards rather than below
   them. "Why this route?" opens with the explanation in plain sentences ("Aqua is in normal mode
   and can execute 8 DTB - the Solver filled 8 DTB here, its entire executable depth"), with the
   decomposed reasoning underneath for anyone who wants it.
4. **Available liquidity** - the sources the route was built from, each showing executable depth
   with its advertised figure struck through beside it.

When the market moves, a **What changed?** panel states the transition and what it cost: `Normal ->
Defensive`, `18 -> 12 DTB`, and why. It does not expire on a timer - the regime change is the single
most important event this product has to show, and an explanation that vanishes after thirty seconds
is no use to someone who looked away.

## Panels

**Liquidity marketplace** - the main screen. For each source it shows regime, executable depth,
coverage, spread and reliability, then the route the solver would build for your request and a
plain-English explanation of why.

Every number except reliability is read live from the venue adapters, i.e. the same functions the
on-chain Solver calls. Three details are deliberate:

- Advertised-but-undeliverable depth is shown **struck through** beside the real figure, so you can
  see the gap rather than just its absence.
- A source the solver cannot use is **dimmed, not hidden** - you should see it exists and is
  unusable, not wonder where it went.
- Reliability is the one figure not read from chain, so it shows **"-"** when no subgraph endpoint
  is configured. A plausible-looking placeholder next to chain-read numbers would be the only
  figure on the screen you could not verify.

**Conditional strategy** - the maker's screen. The top half is read entirely from chain: current
regime and liquidity multiplier from `ConditionalLiquidityEngine.preview` (a live re-evaluation, not
last-committed state), executable liquidity from the venue, market conditions from the market-state
provider, and the strategy's own rules **decoded from the rule-program bytes the registry stores**
(`getRuleProgram`) rather than from anything this app remembers. The recovery timer is driven by
`RuntimeState.armedSince`, the timestamp the engine recorded when the duration-gated rule first
evaluated true - so it shows nothing when calm has not actually held.

The bottom half is the builder. A maker sets the five parameters the protocol actually supports -
defensive volatility threshold, defensive liquidity %, recovery threshold, calm duration, normal
liquidity % (plus the per-mode spreads) - and they are compiled by **the project's own CLF backend**
(`../src/compiler/backends/ruleProgram.ts`, the same encoder the Solidity differential test pins) into
real rule-program bytecode, then registered through `ConditionalLiquidityRegistry.registerStrategy`.
Nothing about a regime is decided in React.

Two things make that honest rather than hopeful:

- The SwapVM order builder is pinned by `src/strategy/order.test.ts` against the strategy already
  registered on Sepolia. It has to reproduce `0xd4e2967…a2df` from public inputs alone, which it
  could not do if a single trait bit or program byte were wrong.
- Before anything is signed, the deployed `StrategyValidator` is asked to validate the bytes and
  `registerStrategy` itself is simulated, so the admission rules applied are the chain's, at their
  deployed version.

**Swap** - execute through the Solver, with each wallet signature and each network wait as its own
labelled step and the explorer link surfaced the moment a hash exists.

**Demo controls** - drive the market-state provider to move strategies between regimes. They move
the **Aqua maker's** conditions only and leave the Uniswap pool alone, which is both the more
realistic scenario and the more informative one: moving both at once collapses the market's depth
together and the viewer just sees an error, where moving one shows the Solver reallocating the order
onto the pool.

There is **no token faucet on the public testnet build**. `MockERC20.mint` is unpermissioned on both
deployments, so the button would work - which is exactly why it is gated to anvil rather than merely
hidden. A public trading interface with a "get tokens" button invites the reading that the
application issues assets. Testnet users get the pair's token contracts, linked, instead.

## Setup

1. `npm install`
2. Create an app at https://dashboard.privy.io (free), enable Ethereum wallets, add your target
   chain to its allowed chains, and copy the App ID.
3. `cp .env.example .env.local` and set `VITE_PRIVY_APP_ID`.
4. `npm run dev`

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `VITE_PRIVY_APP_ID` | - | Required. Privy app ID for wallet connection. |
| `VITE_CHAIN_ID` | `11155111` (Sepolia) | Set to `31337` to target a local anvil node. |
| `VITE_RPC_URL` | public Sepolia RPC / `http://127.0.0.1:8545` | RPC override. |
| `VITE_SUBGRAPH_URL` | unset | The Graph endpoint for historical reliability. Optional. |

Contract addresses are **not** environment variables. Each market has its own Solver and its own
venue pair, so a flat `VITE_SOLVER` stopped being expressible once there was more than one market;
they live in `src/config/markets.ts`, which mirrors `../deployments/<chainId>.json`. Network
selection lives in `src/config/contracts.ts`, and `src/config/wagmi.ts` registers both Sepolia and
anvil so either can be selected without a code change.

`.env.local` is gitignored. **`VITE_SUBGRAPH_URL` embeds a billable API key when using the
decentralised gateway - never commit it.**

### Running against a local chain

Sepolia carries one market; anvil carries three, each parked in a different regime, which is useful
when you want to see NORMAL, DEFENSIVE and RECOVERY side by side without waiting out a real
ten-minute timer. Follow **Local demo procedure (anvil)** in the root
[`../README.md`](../README.md): it starts anvil, deploys via `../script/DeploySolver.s.sol`, and
lists the env vars to copy across.

## Re-syncing ABIs

After any `forge build` in the parent project, run `npm run sync-abis` to refresh `src/abis/` from
the Foundry output in `../out/`. Required after any contract signature change - the marketplace
reads `snapshot` and `executableLiquidity`, both of which are decoded from these ABIs.

The same script also generates `src/abis/swapVmOpcodes.ts` from 1inch's own `OpcodeList.sol`. The
strategy builder has to emit the same SwapVM program `ConditionalLiquidityProgramLib.build` does,
and an opcode is one byte with no runtime error if it is wrong - the order would simply hash to an
id nobody has liquidity behind. Generating it removes that failure mode.

## Known limitations

**Recovery takes real time.** The on-chain DEFENSIVE → RECOVERY → NORMAL timer needs ~10 real
minutes of sustained calm plus at least one trade or poke during that window to arm and then
release. There's no way to fast-forward network time the way Foundry tests can. Shocking to
DEFENSIVE is instant; watching a full recovery cycle live takes real time.

**Reliability needs a subgraph.** Without `VITE_SUBGRAPH_URL` the reliability column shows `-`.
Everything else works, because everything else is a direct chain read.

**Sepolia liquidity is deliberately thin.** The Uniswap pool holds roughly 20 of each token and the
Aqua maker single digits, because the deployment spends the minimum testnet ETH that still proves
the mechanism. Trades beyond a handful of tokens will move the price noticeably or fail to route.

**Market conditions are not an oracle.** The Sepolia market-state provider is project-deployed demo
infrastructure with no access control - anyone can set volatility, which is what makes the regime
machine demonstrable. It is labelled as controlled market state wherever it is exposed, and no
figure it reports relates to any real market.

**The tokens are project test tokens.** `DTA` and `DTB` are this project's own Sepolia ERC-20s with
an unpermissioned `mint`. They carry no value and impersonate nothing.
