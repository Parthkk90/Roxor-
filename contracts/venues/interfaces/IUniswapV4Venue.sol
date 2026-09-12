// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ILiquidityVenue } from "../../solver/interfaces/ILiquidityVenue.sol";

/// @title IUniswapV4Venue
/// @notice {ILiquidityVenue} adapter wrapping one Uniswap v4 pool governed by a
///         {ConditionalLiquidityHook}. Holds no strategy/rule logic of its own.
interface IUniswapV4Venue is ILiquidityVenue { }
