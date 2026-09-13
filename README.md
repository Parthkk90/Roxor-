# Conditional Liquidity

Stateful, market-reactive liquidity strategies compiled onto [1inch SwapVM/Aqua](https://github.com/1inch) and [Uniswap v4](https://github.com/Uniswap/v4-core).

Liquidity providers write strategies as small state machines - "pull back when volatility spikes, restore only after calm has held" - in a domain-specific language called **CLF** (Conditional Liquidity Functions). A compiler turns that into an on-chain rule program, which an execution engine evaluates against live market state to decide how liquidity should be positioned.

## How it fits together

```
strategy.clf  --[compiler]-->  RuleProgram bytecode  --[engine]-->  on-chain execution
                                                                       |
                                                    market state <-----+
                                                  (price, volatility, time)
```

- **CLF compiler** (`src/compiler/`) - lexer, parser, semantic analysis, and an optimizer that lower a `.clf` strategy file into `RuleProgram` bytecode. Run it with `npm run compile`.
- **Rule engine** (`contracts/libraries/RuleEngineLib.sol`, `contracts/libraries/RuleProgram.sol`) - evaluates compiled rule programs on-chain against current market conditions.
- **Core** (`contracts/core/`) - `ConditionalLiquidityRegistry` (registers strategies) and `StrategyValidator` (validates them before they go live).
- **Engine** (`contracts/engine/`) - `ConditionalLiquidityEngine`, the contract that ties a registered strategy to live execution.
- **SwapVM integration** (`contracts/swapvm/`) - adapts conditional liquidity strategies to run as 1inch SwapVM/Aqua programs.
- **Uniswap v4 integration** (`contracts/uniswap/`) - a v4 hook (`ConditionalLiquidityHook.sol`) and adapter that let the same strategies drive a Uniswap v4 pool.
- **Marketplace** (`contracts/solver/`, `contracts/venues/`, `subgraph/`, `src/discovery/`, `src/solver/`) - discovery via The Graph, risk-aware ranking, and a deterministic on-chain solver that routes atomically across both backends. See `docs/marketplace.md`.

### No phantom liquidity

Aqua balances are *allowances against a maker's wallet*, not custody: `Aqua.ship` transfers no tokens, and `Aqua.pull` settles with `safeTransferFrom(maker, …)`. A maker can advertise 100 tokens while holding 1. The marketplace therefore bounds every venue's quotable depth by

```
min(virtual balance, maker wallet balance, maker allowance) x conditional multiplier
```

and re-validates it on-chain immediately before settlement. The solver cannot route against liquidity that cannot actually execute. `docs/marketplace.md` has the full argument.

See `examples/volatility-shield.clf` for a complete example strategy. Documentation lives in `docs/`:

- [`docs/sepolia-deployment.md`](docs/sepolia-deployment.md) - the public Ethereum Sepolia deployment: what was audited, what was reused, what was replaced, and every transaction.
- [`docs/architecture.md`](docs/architecture.md) - how the whole system fits together, part by part, and why.
- [`docs/marketplace.md`](docs/marketplace.md) - the marketplace layer: executable liquidity, coverage, the three layers of truth.
- [`docs/uniswap-v4.md`](docs/uniswap-v4.md) - the v4 hook backend.
- [`docs/uniswap-v4-implementation-notes.md`](docs/uniswap-v4-implementation-notes.md) - the v4 design decisions, and what was deliberately left out.
- [`docs/aqua-swapvm-production-fork.md`](docs/aqua-swapvm-production-fork.md) - verification against real mainnet Aqua.
- [`subgraph/README.md`](subgraph/README.md) - the discovery index, and what it must never be used for.

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

`test/fork/SepoliaMarketplaceFork.t.sol` runs the entire Sepolia deployment plan against a fork of
the live network and then trades through it. It needs no configuration - `foundry.toml` points it
at a public endpoint - and it is what gates a real broadcast:

```bash
forge test --match-path "test/fork/SepoliaMarketplaceFork.t.sol" -vv
```

The subgraph builds separately. Its ABIs are generated from the Foundry output, so run a
`forge build` first and they can never drift from the deployed contracts:

```bash
cd subgraph && npm install && npm run sync-abis && npm run codegen && npm run build
```

There's also a Python reference implementation of the rule engine under `sim/`, used to generate differential test vectors (`test/differential/`) that check the Solidity engine and the TypeScript compiler agree with each other.

## Where it runs

Two environments, kept apart on purpose.

| | Public | Local |
|---|---|---|
| Network | **Ethereum Sepolia** | anvil |
| Chain ID | `11155111` | `31337` |
| Markets | one real market, `DTB/DTA` | three, `DWA/DUSDC` · `DWA/DDAI` · `DDAI/DUSDC` |
| Uniswap v4 | Uniswap's own Sepolia `PoolManager` | a `PoolManager` deployed by the script |
| Deployment record | `deployments/11155111.json` | `deployments/31337.json` |

The frontend defaults to Sepolia and only targets anvil when `VITE_CHAIN_ID=31337` is set
explicitly - a public build never falls back to `127.0.0.1:8545`. **anvil is a development
environment, not the deployment.**

## The Sepolia demonstration

Live now, no setup required beyond a wallet on Sepolia. Full audit trail, decision log, liquidity
breakdown, transaction hashes and limitations:
**[`docs/sepolia-deployment.md`](docs/sepolia-deployment.md)**.

```text
Solver          0x5c8f7f0556a4935d6f0DbA4FB6e44F19e89Af354
AquaVenue       0x6334836551C4088f66127762a9968747266D0d3e
UniswapV4Venue  0x065CfB8B2241bEd17FC6d6a16c0432b8D0641Ca7
Hook            0xa05d48D7b56759aeBdb73A3bB6ffF179bd74c080   on Uniswap's PoolManager 0xE03A1074…3543
Pair            DTB 0x246b76e37825a473Ae784Ce14A2Bb42733A8f922 / DTA 0xFE14a75D92e1A028ebb497dAc4D25bF2e08B3Af3
```

Those two tokens are **project-created Sepolia test tokens**, not any real asset, and the
market-state provider behind the strategies is **project-deployed demo infrastructure with no access
control** - not a production oracle. Official Sepolia USDC was evaluated first and rejected on
evidence; `docs/sepolia-deployment.md` §3 has the arithmetic.

A real settlement across both backends at once:

```text
0xb55c0a7d792fecc4ef264620022574737448f5621237ad78b282abec67272009   block 11695622
5 DTB in -> 6.708 DTA out, split Aqua 4.000 (its entire executable depth) + Uniswap v4 1.000
```

Aqua advertises ~104 DTB and its maker can deliver 8. The solver routes against the 8.

The maker-facing **Strategy** screen reads the deployed strategy's own rules back out of the
registry (`getRuleProgram`, decoded) alongside its live regime, multiplier, executable liquidity and
recovery timer - and lets a maker compile and register their own, through the project's real CLF
backend. That path has been exercised on chain too:
`0x244d24d0462b2dabb88599cf95fb53aebd16686852fcd43bc257bedcab4b665d`.

### Redeploying it

```bash
forge test --match-path "test/fork/SepoliaMarketplaceFork.t.sol" -vv   # verify the reused state first

forge script script/DeploySepolia.s.sol:DeploySepolia \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$SEPOLIA_PRIVATE_KEY" \
  --broadcast --disable-code-size-limit --slow

node scripts/audit/verify-live.mjs
```

`script/DeploySepolia.s.sol` deploys **only** the three marketplace contracts plus the hook, and
reuses every piece of infrastructure the audit proved is still valid - see `script/SepoliaReuse.sol`,
where each reused address carries the evidence that justified reusing it. Secrets live in a
gitignored `.env`; never commit a key, and use a disposable testnet wallet.

> **EIP-170.** `AquaSwapVMRouter` exceeds the 24,576-byte contract limit under this project's
> default `optimizer_runs`. A default-profile broadcast to a real chain deploys it with **empty
> code** and everything built on it is silently dead - which is exactly what happened to an earlier
> Sepolia run. Anything that deploys the router must use `FOUNDRY_PROFILE=ci`.

## Local demo procedure (anvil)

Runs the full marketplace against a local chain, including real ERC20 settlement through both
backends. Deploys **three** markets - `DWA/DUSDC`, `DWA/DDAI`, `DDAI/DUSDC` - each with its own
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
Market 2 (`DDAI/DUSDC`) is left NORMAL by the deploy script itself - run the seed script to walk it
through DEFENSIVE into RECOVERY via the real rule program (see `script/SeedRecovery.s.sol` for why
this needs a second script rather than one):

```bash
./script/seed-markets.sh
```

**3. Point the UI at it.** The addresses above are already baked into
`app/src/config/markets.ts` as the anvil defaults - redeploying gives you *different* addresses, so
update that file to match. Then set the chain:

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
  The strategy enters DEFENSIVE, depth collapses to 25%, spread widens, and the route re-splits -
  live, in the UI.
- **Phantom liquidity.** Transfer the maker's tokens out of their wallet. Aqua still advertises
  the original balance, but coverage collapses, the executable column drops, and the solver
  reallocates to Uniswap v4 rather than routing against liquidity that cannot pay. The advertised
  figure stays visible, struck through, next to the real one.
- **Recovery.** Return volatility to 20% and poke the engine after ten minutes of sustained calm
  to walk DEFENSIVE → RECOVERY → NORMAL - exactly what `seed-markets.sh` already did for market 2.

The same three stories run on Sepolia, against the single real market; the difference is that there
the ten minutes are ten actual minutes.

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
script/          Foundry deployment scripts (DeploySolver = anvil, DeploySepolia = public)
scripts/audit/   read-only Sepolia audit + verification scripts (see docs/sepolia-deployment.md)
src/
  compiler/      CLF lexer/parser/semantics/optimizer + bytecode backend
  discovery/     Graph-backed liquidity discovery (layer 1)
  analytics/     coverage, reliability, liquidity health API
  solver/        risk-aware offchain ranking + route explanation (layer 2)
  cli.ts         compiler CLI entrypoint
subgraph/        The Graph index: strategies, transitions, fills, route executions
app/             marketplace + swap frontend (React + wagmi) - see docs/architecture.md Part 8
  src/market/      normalized liquidity sources, derived figures, regime/route watchers
  src/trade/       quote, settlement state machine, error taxonomy
  src/strategy/    rule-program encode/decode, SwapVM order builder, live strategy reads
  src/components/  swap, liquidity, strategy, route and activity screens
  src/format.ts    token-decimal-aware amount formatting (required `decimals`, no default)
deployments/     per-chain deployment manifests (11155111.json is the public record)
test/            Foundry + Vitest test suites (unit, integration, differential, fork, gas)
sim/             Python reference engine used for differential testing
examples/        sample .clf strategies
docs/            architecture, marketplace, Uniswap v4, Aqua fork notes, Sepolia deployment
```

## License

MIT
