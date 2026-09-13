#!/usr/bin/env bash
# Walks the DUSDC/DDAI market (deployments/<chainId>.json market index 2) from NORMAL to
# RECOVERY, through the real conditional-liquidity rule program. Run once, right after
# `DeploySolver`, against the same anvil instance.
#
# Split across two `forge script` invocations with a real `evm_increaseTime`/`evm_mine` in
# between — see the docstring on `SeedRecoveryBase` in SeedRecovery.s.sol for why a single
# script can't do this itself: `vm.rpc` mutates the node's clock at simulation time, but every
# broadcast-tagged call in a script is deferred and sent as one batch only afterward, so a
# `vm.rpc` time-jump inside one `run()` lands on-chain before all of that run's transactions,
# not between them.
set -euo pipefail

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
CALM_PERIOD_SECONDS=660 # StrategyFixtures.CALM_PERIOD (10 min) plus a safety margin.

cd "$(dirname "$0")/.."

echo "== Phase 1: shock DUSDC/DDAI to DEFENSIVE, then arm the sustained-calm rule =="
forge script script/SeedRecovery.s.sol:SeedRecoveryShock \
  --rpc-url "$RPC_URL" --broadcast --disable-code-size-limit --slow --private-key "$PRIVATE_KEY"

echo "== Advancing chain time by ${CALM_PERIOD_SECONDS}s (anvil-only) =="
cast rpc evm_increaseTime "$CALM_PERIOD_SECONDS" --rpc-url "$RPC_URL"
cast rpc evm_mine --rpc-url "$RPC_URL"

echo "== Phase 2: poke again — sustained calm should now fire DEFENSIVE -> RECOVERY =="
forge script script/SeedRecovery.s.sol:SeedRecoveryFinalize \
  --rpc-url "$RPC_URL" --broadcast --disable-code-size-limit --slow --private-key "$PRIVATE_KEY"
