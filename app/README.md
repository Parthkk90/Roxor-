# Conditional Liquidity Marketplace — Frontend

A web UI for the conditional-liquidity marketplace (see [`../docs/architecture.md`](../docs/architecture.md)).
Connect a wallet via Privy, get test tokens, see live liquidity across the Aqua and Uniswap v4
venues, get a routed quote, and swap. A demo panel triggers a market shock so you can watch the
strategy state machine react live.

## Panels

**Liquidity marketplace** — the main screen. For each source it shows regime, executable depth,
coverage, spread and reliability, then the route the solver would build for your request and a
plain-English explanation of why.

Every number except reliability is read live from the venue adapters, i.e. the same functions the
on-chain Solver calls. Three details are deliberate:

- Advertised-but-undeliverable depth is shown **struck through** beside the real figure, so you can
  see the gap rather than just its absence.
- A source the solver cannot use is **dimmed, not hidden** — you should see it exists and is
  unusable, not wonder where it went.
- Reliability is the one figure not read from chain, so it shows **"—"** when no subgraph endpoint
  is configured. A plausible-looking placeholder next to chain-read numbers would be the only
  figure on the screen you could not verify.

**Live market** — raw venue snapshots. **Swap** — execute through the Solver. **Faucet** — test
tokens. **Simulate a market shock** — drive the oracle to move strategies between regimes.

## Setup

1. `npm install`
2. Create an app at https://dashboard.privy.io (free), enable Ethereum wallets, add your target
   chain to its allowed chains, and copy the App ID.
3. `cp .env.example .env.local` and set `VITE_PRIVY_APP_ID`.
4. `npm run dev`

## Configuration

All contract addresses have Sepolia defaults and can be overridden per environment.

> **The baked-in Sepolia deployment is stale and will not render live figures.** Its
> `ILiquidityVenue.snapshot` returns a six-field `VenueSnapshot`; the current contracts return
> seven (`coverageBps` was added afterwards), so `snapshot` and `executableLiquidity` fail to
> decode against the ABIs in `src/abis/`. The marketplace correctly reports both venues as
> *unavailable* and the verdict banner reads **UNVERIFIED** rather than asserting a pass it cannot
> support. `Solver.route` still decodes, so a route appears with no depth to check it against.
> Redeploy (`script/DeploySolver.s.sol`) and update `src/config/contracts.ts`, or run against a
> local anvil deployment as described below.

| Variable | Default | Purpose |
|---|---|---|
| `VITE_PRIVY_APP_ID` | — | Required. Privy app ID for wallet connection. |
| `VITE_CHAIN_ID` | `11155111` (Sepolia) | Set to `31337` to target a local anvil node. |
| `VITE_RPC_URL` | public Sepolia RPC / `http://127.0.0.1:8545` | RPC override. |
| `VITE_SOLVER` | Sepolia address | Solver contract. |
| `VITE_AQUA_VENUE` | Sepolia address | Aqua venue adapter. |
| `VITE_UNISWAP_V4_VENUE` | Sepolia address | Uniswap v4 venue adapter. |
| `VITE_TOKEN_A` / `VITE_TOKEN_B` | Sepolia addresses | Demo token pair. |
| `VITE_AQUA_ORACLE` / `VITE_UNI_ORACLE` | Sepolia addresses | Market state providers (shock controls only). |
| `VITE_AQUA_STRATEGY_ID` / `VITE_UNI_STRATEGY_ID` | Sepolia ids | Strategy ids (shock controls only). |
| `VITE_SUBGRAPH_URL` | unset | The Graph endpoint for historical reliability. Optional. |

Defaults live in `src/config/contracts.ts`; `src/config/wagmi.ts` registers both Sepolia and anvil
so either can be selected without a code change.

`.env.local` is gitignored. **`VITE_SUBGRAPH_URL` embeds a billable API key when using the
decentralised gateway — never commit it.**

### Running against a local chain

The Sepolia deployment may lag the current contracts. To run against a fresh local deployment,
follow the **Demo procedure** in the root [`../README.md`](../README.md): it starts anvil, deploys
via `../script/DeploySolver.s.sol`, and lists the env vars to copy across.

## Re-syncing ABIs

After any `forge build` in the parent project, run `npm run sync-abis` to refresh `src/abis/` from
the Foundry output in `../out/`. Required after any contract signature change — the marketplace
reads `snapshot` and `executableLiquidity`, both of which are decoded from these ABIs.

## Known limitations

**Recovery takes real time.** The on-chain DEFENSIVE → RECOVERY → NORMAL timer needs ~10 real
minutes of sustained calm plus at least one trade or poke during that window to arm and then
release. There's no way to fast-forward network time the way Foundry tests can. Shocking to
DEFENSIVE is instant; watching a full recovery cycle live takes real time.

**Reliability needs a subgraph.** Without `VITE_SUBGRAPH_URL` the reliability column shows `—`.
Everything else works, because everything else is a direct chain read.

**The default Sepolia addresses are behind the contracts.** See the note under *Configuration* —
the demo currently needs either a redeploy or a local anvil chain.
