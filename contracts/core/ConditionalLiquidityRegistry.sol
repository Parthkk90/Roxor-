// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraits, MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import { IConditionalLiquidityRegistry } from "./interfaces/IConditionalLiquidityRegistry.sol";
import { IStrategyValidator } from "./interfaces/IStrategyValidator.sol";
import { StrategyLib } from "../libraries/StrategyLib.sol";

/// @title ConditionalLiquidityRegistry
/// @notice Canonical record of which SwapVM orders carry conditional-liquidity behaviour, plus the
///         runtime state each of those strategies has accumulated.
///
/// @dev SEPARATION OF DEFINITION AND STATE
///      `Strategy` answers "what should happen"; it is written once at registration and never
///      mutated. `RuntimeState` answers "what is happening right now"; it changes only through
///      {commitState}, which only the state authority may call.
///
/// @dev WRITE AUTHORITY
///      Three distinct roles, deliberately not collapsed:
///        - owner   sets the state authority (deployment/upgrade concern)
///        - maker   registers, activates and deactivates their own strategies
///        - engine  is the sole writer of runtime state
///      Nothing lets an arbitrary caller set `volatility`, a mode, or a liquidity multiplier.
contract ConditionalLiquidityRegistry is IConditionalLiquidityRegistry, Ownable {
    using StrategyLib for ISwapVM.Order;
    using MakerTraitsLib for MakerTraits;

    IStrategyValidator public immutable VALIDATOR;

    /// @inheritdoc IConditionalLiquidityRegistry
    address public stateAuthority;

    mapping(bytes32 strategyId => Strategy) private _strategies;
    mapping(bytes32 strategyId => RuntimeState) private _states;
    mapping(bytes32 strategyId => bytes) private _rulePrograms;

    modifier onlyStateAuthority() {
        require(msg.sender == stateAuthority, NotStateAuthority(msg.sender));
        _;
    }

    modifier onlyMaker(bytes32 strategyId) {
        address maker = _strategies[strategyId].maker;
        require(maker != address(0), StrategyNotRegistered(strategyId));
        require(maker == msg.sender, NotStrategyMaker(strategyId, msg.sender));
        _;
    }

    constructor(IStrategyValidator validator, address owner) Ownable(owner) {
        require(address(validator) != address(0), ZeroAddress());
        VALIDATOR = validator;
    }

    /// @notice Point the registry at the engine allowed to write runtime state.
    function setStateAuthority(address newAuthority) external onlyOwner {
        require(newAuthority != address(0), ZeroAddress());
        emit StateAuthorityUpdated(stateAuthority, newAuthority);
        stateAuthority = newAuthority;
    }

    /// @inheritdoc IConditionalLiquidityRegistry
    function registerStrategy(
        ISwapVM.Order calldata order,
        uint16 baseLiquidityBps,
        uint16 baseSpreadBps,
        bytes calldata ruleProgram
    )
        external
        returns (bytes32 strategyId)
    {
        require(order.maker == msg.sender, MakerMismatch(order.maker, msg.sender));

        strategyId = order.strategyId();
        require(_strategies[strategyId].maker == address(0), StrategyAlreadyRegistered(strategyId));

        // `order.data` is laid out as [tokenA:20][tokenB:20][hooks...][program]. We read the pair
        // straight out of it rather than taking it as a parameter, so the registered pair cannot
        // disagree with the pair the VM will actually swap.
        (address tokenA, address tokenB) = _readTokens(order);

        bytes calldata program = _readProgram(order);
        VALIDATOR.validate(tokenA, tokenB, baseLiquidityBps, baseSpreadBps, program);
        VALIDATOR.validateRuleProgram(ruleProgram);

        bytes32 programHash = keccak256(ruleProgram);
        _rulePrograms[strategyId] = ruleProgram;

        _strategies[strategyId] = Strategy({
            maker: msg.sender,
            tokenA: tokenA,
            tokenB: tokenB,
            baseLiquidityBps: baseLiquidityBps,
            baseSpreadBps: baseSpreadBps,
            programHash: programHash,
            createdAt: uint64(block.timestamp),
            active: true
        });

        _states[strategyId] = RuntimeState({
            mode: StrategyMode.NORMAL,
            referencePrice: 0,
            liquidityBps: baseLiquidityBps,
            spreadBps: baseSpreadBps,
            lastTransition: uint64(block.timestamp),
            lastExecution: 0,
            cumulativeVolume: 0,
            transitionCount: 0,
            armedRule: 0,
            armedSince: 0
        });

        emit StrategyRegistered(strategyId, msg.sender, tokenA, tokenB, programHash);
        emit StrategyActivated(strategyId);
    }

    /// @inheritdoc IConditionalLiquidityRegistry
    function activateStrategy(bytes32 strategyId) external onlyMaker(strategyId) {
        _strategies[strategyId].active = true;
        emit StrategyActivated(strategyId);
    }

    /// @inheritdoc IConditionalLiquidityRegistry
    function deactivateStrategy(bytes32 strategyId) external onlyMaker(strategyId) {
        _strategies[strategyId].active = false;
        emit StrategyDeactivated(strategyId);
    }

    /// @inheritdoc IConditionalLiquidityRegistry
    function commitState(bytes32 strategyId, RuntimeState calldata newState) external onlyStateAuthority {
        RuntimeState storage current = _states[strategyId];
        require(_strategies[strategyId].maker != address(0), StrategyNotRegistered(strategyId));

        StrategyMode previousMode = current.mode;
        _states[strategyId] = newState;

        if (previousMode != newState.mode) {
            emit StrategyStateChanged(strategyId, previousMode, newState.mode, newState.liquidityBps, newState.spreadBps);
        }
    }

    /// @inheritdoc IConditionalLiquidityRegistry
    function getStrategy(bytes32 strategyId) external view returns (Strategy memory strategy) {
        strategy = _strategies[strategyId];
        require(strategy.maker != address(0), StrategyNotRegistered(strategyId));
    }

    /// @inheritdoc IConditionalLiquidityRegistry
    function getStrategyState(bytes32 strategyId) external view returns (RuntimeState memory) {
        require(_strategies[strategyId].maker != address(0), StrategyNotRegistered(strategyId));
        return _states[strategyId];
    }

    /// @inheritdoc IConditionalLiquidityRegistry
    function getRuleProgram(bytes32 strategyId) external view returns (bytes memory) {
        require(_strategies[strategyId].maker != address(0), StrategyNotRegistered(strategyId));
        return _rulePrograms[strategyId];
    }

    /// @inheritdoc IConditionalLiquidityRegistry
    function isActive(bytes32 strategyId) external view returns (bool) {
        return _strategies[strategyId].active;
    }

    /// @inheritdoc IConditionalLiquidityRegistry
    function isRegistered(bytes32 strategyId) external view returns (bool) {
        return _strategies[strategyId].maker != address(0);
    }

    /// @dev Delegates to SwapVM's own accessors rather than reimplementing the `order.data`
    ///      layout. If 1inch changes that encoding, this follows automatically instead of
    ///      silently decoding the wrong bytes.
    function _readTokens(ISwapVM.Order calldata order) private pure returns (address tokenA, address tokenB) {
        return order.traits.tokens(order.data);
    }

    function _readProgram(ISwapVM.Order calldata order) private pure returns (bytes calldata) {
        return order.traits.program(order.data);
    }
}
