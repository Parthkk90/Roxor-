// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// This file exists purely so `forge build` produces a `PoolManager` artifact.
//
// `PoolManager.sol` exact-pins `pragma solidity 0.8.26`, which cannot share a compiler invocation
// with the rest of this project (`^0.8.30`, matching 1inch's aqua/swap-vm exact `0.8.30` pin).
// Nothing imports this file — that is the point: keeping it unimported means its import graph
// (and therefore its pragma requirement) never merges with the 0.8.30 graph. Tests deploy the real
// `PoolManager` via `vm.deployCode("PoolManager.sol:PoolManager", abi.encode(owner))`, which reads
// the artifact this file causes to be built, with no Solidity-level import needed at the call site.
import "@uniswap/v4-core/src/PoolManager.sol";
