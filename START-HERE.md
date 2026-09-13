# Start here

A live Ethereum Sepolia deployment of the Conditional Liquidity Marketplace, plus everything that
built it. **Nothing needs installing to see it run.**

## Run it

```bash
node start.mjs
```

Then open **http://127.0.0.1:5173**.

That is the whole setup. `start.mjs` imports nothing but Node's standard library, so there is no
`npm install`, no `node_modules`, no Foundry, no local blockchain and no configuration. Node 18 or
newer, and an internet connection - the app reads the live chain.

If Node is not installed: <https://nodejs.org> (LTS).

## What you can see immediately, without a wallet

Everything except signing. All of it is read live from Sepolia:

| Page | What it shows |
|---|---|
| **Liquidity** | Executable depth per source, the advertised figure struck through beside it, coverage, regime |
| **Swap** | Enter an amount (try `12`) - the Solver's real split appears, with **Why this route?** in plain sentences |
| **Strategy** | The maker's rules, decoded from the bytes the on-chain registry stores, plus the live regime and recovery timer |
| **Activity** | Settled trades, when an indexer is configured |

The product's one claim is visible on the first screen: Aqua **advertises ~104 DTB** and its maker
**can deliver 8**. The Solver routes against the 8.

## To actually trade

You need a Sepolia wallet holding DTB or DTA, plus a little Sepolia ETH for gas.

**The quickest path - the accounts are in this archive.** `.env` at the repository root holds two
private keys. Import `TRADER_PRIVATE_KEY` into MetaMask, switch to Sepolia, and you have a funded
account ready to swap:

```text
trader   0xcC2a17Bd2708b4c7A99A3a8cafAe85e1e128cC4d
         ~0.0079 ETH · 1 DTB · 6.7 DTA
```

> These are **disposable testnet keys**. They hold no value of any kind and control nothing on any
> real network. Do not reuse them for anything else, and do not send real funds to them.

**Or use your own address.** Both demo tokens are `MockERC20` with an unpermissioned `mint`, so any
address can self-serve:

```bash
cast send 0x246b76e37825a473Ae784Ce14A2Bb42733A8f922 \
  "mint(address,uint256)" <YOUR_ADDRESS> 10000000000000000000 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com --private-key <YOUR_KEY>
```

That needs Foundry (`cast`) and your own Sepolia ETH from a public faucet. The frontend deliberately
offers no token faucet on the public build - a trading interface with a "get tokens" button reads as
though the application issues assets.

## See the mechanism react

The interesting behaviour is conditional liquidity responding to market conditions. On the **Swap**
page open **Demo controls** and press **Shock Aqua maker** (needs a connected wallet; the control
writes to a project-deployed market-state provider that has no access control - which is what makes
it demonstrable, and why it is labelled as controlled market state).

Watch, within one block:

```text
Normal  ->  Defensive        volatility 20% -> 65%
liquidity capacity 100% -> 25%       executable 18 DTB -> 12 DTB
route  Aqua 8 / Uniswap 4   ->   Aqua 2 / Uniswap 10
```

A **What changed?** panel states the transition, what it cost, and why. It does not expire.

Returning to full size takes about ten real minutes of sustained calm - the recovery timer is
enforced on-chain, not in the interface, so it cannot be fast-forwarded.

## The deployment

```text
Network   Ethereum Sepolia (11155111)
Solver    0x5c8f7f0556a4935d6f0DbA4FB6e44F19e89Af354
Aqua      0x6334836551C4088f66127762a9968747266D0d3e
Uniswap   0x065CfB8B2241bEd17FC6d6a16c0432b8D0641Ca7   on Uniswap's own PoolManager 0xE03A1074...3543
Pair      DTB 0x246b76e37825a473Ae784Ce14A2Bb42733A8f922 / DTA 0xFE14a75D92e1A028ebb497dAc4D25bF2e08B3Af3
```

A real settlement across both backends at once:
[`0xb55c0a7d...72009`](https://sepolia.etherscan.io/tx/0xb55c0a7d792fecc4ef264620022574737448f5621237ad78b282abec67272009)
- 5 DTB in, 6.708 DTA out, split Aqua 4.000 (its entire executable depth) + Uniswap v4 1.000.

DTB and DTA are **project-created testnet tokens**. They carry no value and impersonate nothing.

## Working on the source

Only needed to build, test or redeploy - not to run the demo above.

```bash
npm install                     # root: contracts + compiler
cd app && npm install && cd ..  # frontend
curl -L https://foundry.paradigm.xyz | bash && foundryup   # Foundry, for contracts

npm test                        # 163 Solidity tests
npm run test:compiler           # 75 compiler/discovery tests
cd app && npm test              # 65 frontend tests
npm run test:fork:sepolia       # runs the deployment plan against a fork of live Sepolia
npm run sepolia:verify          # reads the live marketplace back, layer by layer
cd app && npm run dev           # frontend against the live deployment
```

## Where to read next

| Document | What it covers |
|---|---|
| [`README.md`](README.md) | The project, both environments, how to redeploy |
| [`docs/sepolia-deployment.md`](docs/sepolia-deployment.md) | The audit, the decision log, every transaction hash, the limitations |
| [`docs/architecture.md`](docs/architecture.md) | The system, Parts 1-8, contracts through frontend |
| [`docs/marketplace.md`](docs/marketplace.md) | Executable liquidity, coverage, the three layers of truth |

## What is in this archive

Everything except what a build step recreates. `node_modules/`, `out/`, `cache/` and
`subgraph/generated/` are omitted - run the install commands above to restore them. `app/dist/` is
included pre-built, which is what makes `node start.mjs` work with no install.

Git history, the `broadcast/` deployment records, the deployment manifests and the `.env` files are
all present.
