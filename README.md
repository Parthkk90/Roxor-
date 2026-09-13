# Conditional Liquidity

Stateful, market-reactive liquidity strategies compiled onto [1inch SwapVM/Aqua](https://github.com/1inch) and [Uniswap v4](https://github.com/Uniswap/v4-core).

Liquidity providers write strategies as small state machines — "pull back when volatility spikes, restore only after calm has held" — in a domain-specific language called **CLF** (Conditional Liquidity Functions). A compiler turns that into an on-chain rule program, which an execution engine evaluates against live market state to decide how liquidity should be positioned.

## How it fits together

```
strategy.clf  --[compiler]-->  RuleProgram bytecode  --[engine]-->  on-chain execution
                                                                       |
                                                    market state <-----+
                                                  (price, volatility, time)
```

- **CLF compiler** (`src/compiler/`) — lexer, parser, semantic analysis, and an optimizer that lower a `.clf` strategy file into `RuleProgram` bytecode. Run it with `npm run compile`.
- **Rule engine** (`contracts/libraries/RuleEngineLib.sol`, `contracts/libraries/RuleProgram.sol`) — evaluates compiled rule programs on-chain against current market conditions.
- **Core** (`contracts/core/`) — `ConditionalLiquidityRegistry` (registers strategies) and `StrategyValidator` (validates them before they go live).
- **Engine** (`contracts/engine/`) — `ConditionalLiquidityEngine`, the contract that ties a registered strategy to live execution.
- **SwapVM integration** (`contracts/swapvm/`) — adapts conditional liquidity strategies to run as 1inch SwapVM/Aqua programs.
- **Uniswap v4 integration** (`contracts/uniswap/`) — a v4 hook (`ConditionalLiquidityHook.sol`) and adapter that let the same strategies drive a Uniswap v4 pool.
- **Marketplace** (`contracts/solver/`, `contracts/venues/`, `subgraph/`, `src/discovery/`, `src/solver/`) — discovery via The Graph, risk-aware ranking, and a deterministic on-chain solver that routes atomically across both backends. See `docs/marketplace.md`.

### No phantom liquidity

Aqua balances are *allowances against a maker's wallet*, not custody: `Aqua.ship` transfers no tokens, and `Aqua.pull` settles with `safeTransferFrom(maker, …)`. A maker can advertise 100 tokens while holding 1. The marketplace therefore bounds every venue's quotable depth by

```
min(virtual balance, maker wallet balance, maker allowance) x conditional multiplier
```

and re-validates it on-chain immediately before settlement. The solver cannot route against liquidity that cannot actually execute. `docs/marketplace.md` has the full argument.

See `examples/volatility-shield.clf` for a complete example strategy. Documentation lives in `docs/`:

- [`docs/architecture.md`](docs/architecture.md) — how the whole system fits together, part by part, and why.
- [`docs/marketplace.md`](docs/marketplace.md) — the marketplace layer: executable liquidity, coverage, the three layers of truth.
- [`docs/uniswap-v4.md`](docs/uniswap-v4.md) — the v4 hook backend.
- [`docs/aqua-swapvm-production-fork.md`](docs/aqua-swapvm-production-fork.md) — verification against real mainnet Aqua.
- [`subgraph/README.md`](subgraph/README.md) — the discovery index, and what it must never be used for.

## Getting started

Requires [Foundry](https://book.getfoundry.sh/) and Node.js >= 20.

On Windows, Foundry was installed and run under WSL for this project (`wsl -d Ubuntu-22.04`), since
`foundryup` targets a POSIX shell. Everything else runs natively.

```bash
npm install
npm run build          # forge build
npm run compile        # compile a .clf strategy (src/cli.ts)
```

Copy `.env.example` to `.env` and fill in an RPC URL if you plan to run fork tests.

## Testing

```bash
npm test               # forge test (Solidity unit/integration tests)
npm run test:compiler  # vitest (TypeScript compiler + discovery/ranking tests)
npm run test:all       # both
npm run test:fork      # mainnet fork tests (needs RPC_URL in .env)
npm run typecheck      # tsc --noEmit over src/ and test/offchain/
npm run fmt:check      # forge fmt --check
```

The subgraph builds separately. Its ABIs are generated from the Foundry output, so run a
`forge build` first and they can never drift from the deployed contracts:

```bash
cd subgraph && npm install && npm run sync-abis && npm run codegen && npm run build
```

There's also a Python reference implementation of the rule engine under `sim/`, used to generate differential test vectors (`test/differential/`) that check the Solidity engine and the TypeScript compiler agree with each other.

## Demo procedure

Runs the full marketplace against a local chain, including real ERC20 settlement through both
backends. Deploys **three** markets — `DWA/DUSDC`, `DWA/DDAI`, `DDAI/DUSDC` — each with its own
`Solver` and Aqua + Uniswap v4 venue pair, at NORMAL / DEFENSIVE / RECOVERY respectively, so a
judge can switch markets and immediately see different liquidity conditions. Requires Foundry and
Node >= 20.

**1. Start a local node.** The Uniswap `PoolManager` exceeds EIP-170, so raise the limit:

```bash
anvil --code-size-limit 120000
```

**2. Deploy the stack.** `--disable-code-size-limit` is needed for the same reason, and `--slow`
avoids a batching race against anvil's automine (some nodes stall queuing many transactions at
once otherwise):

```bash
forge script script/DeploySolver.s.sol:DeploySolver \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --broadcast --disable-code-size-limit --slow
```

This writes every market's addresses to `deployments/31337.json` and prints them to the console.
Market 2 (`DDAI/DUSDC`) is left NORMAL by the deploy script itself — run the seed script to walk it
through DEFENSIVE into RECOVERY via the real rule program (see `script/SeedRecovery.s.sol` for why
this needs a second script rather than one):

```bash
./script/seed-markets.sh
```

**3. Point the UI at it.** The addresses above are already baked into
`app/src/config/markets.ts` as the anvil defaults — redeploying gives you *different* addresses, so
update that file to match (mirroring how the previous single-market build documented updating
`config/contracts.ts`). Then just set the chain:

```
VITE_CHAIN_ID=31337
VITE_RPC_URL=http://127.0.0.1:8545
```

```bash
cd app && npm install && npm run dev
```

**4. Walk the story.** Open the Liquidity page: three markets, three different risk states, read
live from chain. Switch between them and watch executable depth, coverage and route allocation
change with each. On any market:

- **Market shock.** Use the Demo controls panel on the Swap page (`Shock market`), or set
  volatility directly on either oracle
  (`cast send $ORACLE "setVolatility(bytes32,uint256,uint256)" $STRATEGY_ID 6500 4000000000000000000000`).
  The strategy enters DEFENSIVE, depth collapses to 25%, spread widens, and the route re-splits —
  live, in the UI.
- **Phantom liquidity.** Transfer the maker's tokens out of their wallet. Aqua still advertises
  the original balance, but coverage collapses, the executable column drops, and the solver
  reallocates to Uniswap v4 rather than routing against liquidity that cannot pay. The advertised
  figure stays visible, struck through, next to the real one.
- **Recovery.** Return volatility to 20% and poke the engine after ten minutes of sustained calm
  to walk DEFENSIVE → RECOVERY → NORMAL — exactly what `seed-markets.sh` already did for market 2.

## Project layout

```
contracts/
  core/          registry + strategy validation
  engine/        execution engine
  libraries/     fixed-point math, rule engine, rule program encoding
  swapvm/        1inch SwapVM/Aqua integration
  uniswap/       Uniswap v4 hook integration
  solver/        deterministic router + liquidity health lens
  venues/        Aqua / Uniswap v4 venue adapters
  mocks/         test doubles (ERC20, WETH, market state provider)
src/
  compiler/      CLF lexer/parser/semantics/optimizer + bytecode backend
  discovery/     Graph-backed liquidity discovery (layer 1)
  analytics/     coverage, reliability, liquidity health API
  solver/        risk-aware offchain ranking + route explanation (layer 2)
  cli.ts         compiler CLI entrypoint
subgraph/        The Graph index: strategies, transitions, fills, route executions
app/             marketplace + swap frontend (React + wagmi)
test/            Foundry + Vitest test suites (unit, integration, differential, fork, gas)
sim/             Python reference engine used for differential testing
examples/        sample .clf strategies
docs/            integration notes
```

## License

MIT
