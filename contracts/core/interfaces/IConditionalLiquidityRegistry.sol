// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { IStrategyTypes } from "./IStrategyTypes.sol";

/// @title IConditionalLiquidityRegistry
/// @notice Registry of conditional-liquidity strategies and their runtime state.
interface IConditionalLiquidityRegistry is IStrategyTypes {
    error StrategyAlreadyRegistered(bytes32 strategyId);
    error StrategyNotRegistered(bytes32 strategyId);
    error NotStrategyMaker(bytes32 strategyId, address caller);
    error NotStateAuthority(address caller);
    error StrategyInactive(bytes32 strategyId);
    error MakerMismatch(address orderMaker, address caller);
    error ZeroAddress();

    event StrategyRegistered(
        bytes32 indexed strategyId, address indexed maker, address indexed tokenA, address tokenB, bytes32 programHash
    );
    event StrategyActivated(bytes32 indexed strategyId);
    event StrategyDeactivated(bytes32 indexed strategyId);
    event StrategyStateChanged(
        bytes32 indexed strategyId, StrategyMode previousMode, StrategyMode newMode, uint16 liquidityBps, uint16 spreadBps
    );
    event StateAuthorityUpdated(address indexed previousAuthority, address indexed newAuthority);

    /// @notice Register a conditional-liquidity strategy for a SwapVM order.
    /// @dev The strategy id is derived from the order itself, so it cannot be chosen by the caller
    ///      and is guaranteed to equal the `orderHash` SwapVM will present at execution time.
    ///      `msg.sender` must be `order.maker`.
    /// @param order The SwapVM order this strategy governs.
    /// @param baseLiquidityBps Liquidity multiplier the strategy starts in.
    /// @param baseSpreadBps Spread the strategy starts in.
    /// @param ruleProgram Compiled rule program, stored in full for data availability so that any
    ///        indexer or solver can reproduce the strategy's behaviour from chain state alone.
    /// @return strategyId Canonical identifier, equal to Aqua's `strategyHash` for this order.
    function registerStrategy(
        ISwapVM.Order calldata order,
        uint16 baseLiquidityBps,
        uint16 baseSpreadBps,
        bytes calldata ruleProgram
    )
        external
        returns (bytes32 strategyId);

    /// @notice The compiled rule program registered for `strategyId`.
    function getRuleProgram(bytes32 strategyId) external view returns (bytes memory);

    function activateStrategy(bytes32 strategyId) external;

    function deactivateStrategy(bytes32 strategyId) external;

    function getStrategy(bytes32 strategyId) external view returns (Strategy memory);

    function getStrategyState(bytes32 strategyId) external view returns (RuntimeState memory);

    function isActive(bytes32 strategyId) external view returns (bool);

    function isRegistered(bytes32 strategyId) external view returns (bool);

    /// @notice Overwrite a strategy's runtime state.
    /// @dev Restricted to the state authority (the conditional-liquidity engine). Makers and
    ///      takers can never write state directly; they can only cause a transition by executing
    ///      a swap, which routes through the engine.
    function commitState(bytes32 strategyId, RuntimeState calldata newState) external;

    function stateAuthority() external view returns (address);
}
