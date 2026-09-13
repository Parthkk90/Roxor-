# Conditional Liquidity Marketplace - subgraph

Discovery index for conditional-liquidity strategies across Aqua/SwapVM and Uniswap v4.

## What this is, and what it is not

This subgraph is **layer 1 of three**, and the boundary is the whole point of the design:

| Layer | Source | Used for | Never used for |
|---|---|---|---|
| 1 | This subgraph | discovery, history, analytics, ranking hints | settlement |
| 2 | Offchain solver (`src/solver/`) | candidate ranking, split allocation | settlement |
| 3 | On-chain `Solver` + venue adapters | executable liquidity, slippage, settlement | - |

**Indexed liquidity is an advertisement, not a balance.** On the Aqua side a strategy's liquidity
is an *allowance* against the maker's wallet - `Aqua.ship` transfers no tokens, and `Aqua.pull`
settles with `safeTransferFrom(maker, …)`. A maker can therefore go from "100 indexed" to "0
deliverable" by moving their own tokens, **emitting no event at all**. There is nothing to index
for that, which is exactly why the solver re-reads the chain before it moves anything.

If you are reading a number from this subgraph and about to act on it financially, you have
skipped a layer.

## Entities

- `Strategy` - a registered conditional-liquidity strategy, with its current regime and config.
- `Maker` - a liquidity provider, with lifetime fill counters and `reliabilityBps`.
- `Venue` - a backend (`aqua` / `uniswap-v4`) or venue adapter, with aggregate flow.
- `LiquiditySnapshot` - point-in-time advertised vs effective depth, plus coverage.
- `StateTransition` - a NORMAL/DEFENSIVE/RECOVERY change, with the volatility that triggered it.
- `Swap` - one fill.
- `RouteExecution` / `RouteLeg` - one solver settlement and its per-venue split.

### On `failedFills`

It is almost always `0`, and that is honest rather than broken. A reverted settlement's logs are
unwound with the rest of its call frame, so a failed fill leaves nothing for an indexer to see.
The hook's `ConditionalSwapRejected` event exists for trace tooling and **can never be mined** -
see `IConditionalLiquidityHook`. Rather than report an inferred number that looks measured, the
mappings leave the counter at zero and document why. Supply real failure counts from a solver's own
attempt log if you need them.

### On `reliabilityBps` for new makers

A maker with no attempts reads as `10000`, not `0`. A fresh maker has not earned distrust, and
burying them under a score they never earned would entrench incumbents - while costing traders
nothing, because solvency is enforced independently at layer 3.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your Graph Studio credentials. `.env` is gitignored;
never commit a deploy key or query API key.

## Build

ABIs are generated from the Foundry build, so they can never drift from the deployed contracts:

```bash
cd .. && forge build && cd subgraph && npm run sync-abis
```

```bash
npm run codegen && npm run build
```

## Deploy

`subgraph.yaml` is pointed at the live Ethereum Sepolia deployment recorded in
`../deployments/11155111.json` (see `../docs/sepolia-deployment.md`), with each `startBlock` set to
the block its contract was created in. Re-point every data source before deploying against any
other chain - a manifest left pointing here would silently index the wrong deployment.

```bash
npm run auth      # uses GRAPH_DEPLOY_KEY
npm run deploy    # uses GRAPH_SUBGRAPH_SLUG
```

Local Graph Node:

```bash
npm run create-local && npm run deploy-local
```

## Querying

The frontend and `src/discovery/GraphLiquidityDiscovery.ts` both read through
`VITE_SUBGRAPH_URL` / an injected transport. Query documents live in `src/discovery/queries.ts`.

Both consumers degrade to empty results if this index is unreachable - deliberately. An index
outage must never block a trade the chain could still settle.
