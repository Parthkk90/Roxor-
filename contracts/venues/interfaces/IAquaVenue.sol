// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ILiquidityVenue } from "../../solver/interfaces/ILiquidityVenue.sol";

/// @title IAquaVenue
/// @notice {ILiquidityVenue} adapter wrapping one Aqua/SwapVM-backed conditional-liquidity
///         strategy. Holds no strategy/rule logic of its own.
interface IAquaVenue is ILiquidityVenue { }
