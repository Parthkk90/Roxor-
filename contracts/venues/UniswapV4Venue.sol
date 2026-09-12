// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { BalanceDelta, BalanceDeltaLibrary } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { FullMath } from "@uniswap/v4-core/src/libraries/FullMath.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import { IUniswapV4Venue } from "./interfaces/IUniswapV4Venue.sol";
import { IExecutableLiquidity } from "./interfaces/IExecutableLiquidity.sol";
import { ILiquidityVenue } from "../solver/interfaces/ILiquidityVenue.sol";
import { ExecutableLiquidityLib } from "../libraries/ExecutableLiquidityLib.sol";
import { IHookStrategyAdapter } from "../uniswap/interfaces/IHookStrategyAdapter.sol";
import { FixedPointMath } from "../libraries/FixedPointMath.sol";

/// @title UniswapV4Venue
/// @notice {ILiquidityVenue} adapter over one Uniswap v4 pool governed by a
///         {ConditionalLiquidityHook}.
///
/// @dev Solvency model differs from Aqua's by construction and the difference is the point. Aqua
///      quotes against a maker's *wallet* via an allowance, so it can be structurally insolvent;
///      a v4 pool holds its reserves inside the {IPoolManager} itself, so the tokens backing a
///      quote are already in custody and there is no third party to run dry or revoke. `allowance`
///      is therefore reported as `type(uint256).max` (not applicable, never binding), and
///      `walletLiquidity` is the pool manager's real live balance of `tokenIn`. Coverage is still
///      computed the same way, which is what lets the marketplace rank a pool against a maker on
///      one honest scale — and why a healthy pool naturally shows 100% while a drained maker
///      does not.
///
/// @dev Holds no strategy/rule logic: `snapshot` reads mode/spread/effective-liquidity exclusively
///      through {IHookStrategyAdapter.quoteSnapshot} (a live, non-mutating read that already exists
///      on the hook) and the pool's live spot price through {StateLibrary.getSlot0}. `execute`
///      settles for real through `PoolSwapTest.swap`, exactly the pattern
///      `test/utils/UniswapExecutionFixture.sol::_swapXToY` already uses, with this contract itself
///      as `msg.sender` of the swap (so it must hold `amountIn` and approve the router first — see
///      {Solver.settle}'s push-then-execute custody flow).
contract UniswapV4Venue is IUniswapV4Venue {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable MANAGER;
    PoolSwapTest public immutable SWAP_ROUTER;
    IHookStrategyAdapter public immutable HOOK;
    PoolId public immutable POOL_ID;

    address private immutable _currency0;
    address private immutable _currency1;

    PoolKey private _poolKey;

    constructor(IPoolManager manager, PoolSwapTest swapRouter, IHookStrategyAdapter hook, PoolKey memory poolKey_) {
        MANAGER = manager;
        SWAP_ROUTER = swapRouter;
        HOOK = hook;
        _poolKey = poolKey_;
        POOL_ID = poolKey_.toId();
        _currency0 = Currency.unwrap(poolKey_.currency0);
        _currency1 = Currency.unwrap(poolKey_.currency1);
    }

    /// @inheritdoc ILiquidityVenue
    function snapshot(address tokenIn, address tokenOut) external view returns (VenueSnapshot memory) {
        _requirePair(tokenIn, tokenOut);

        IHookStrategyAdapter.PoolStrategy memory ps = HOOK.getPoolStrategy(POOL_ID);
        // `quoteSnapshot` is the hook's live re-evaluation path; `getCurrentMode`/`getEffectiveSpread`
        // read last-committed state and can be stale until the next swap or poke, so they are
        // deliberately not used here.
        (StrategyMode mode, uint16 spreadBps,,) = HOOK.quoteSnapshot(POOL_ID);
        IExecutableLiquidity.ExecutableLiquidity memory exec = _executable(tokenIn);

        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(MANAGER, POOL_ID);
        uint256 price0in1Wad = _sqrtPriceToWad(sqrtPriceX96); // price of currency0 in currency1, WAD
        uint256 referencePrice = tokenIn == _currency0 ? price0in1Wad : (1e36 / price0in1Wad);

        return VenueSnapshot({
            venue: address(this),
            strategyId: ps.strategyId,
            mode: mode,
            effectiveLiquidity: exec.conditionalLiquidity,
            spreadBps: spreadBps,
            referencePrice: referencePrice,
            coverageBps: exec.coverageBps
        });
    }

    /// @inheritdoc IExecutableLiquidity
    function executableLiquidity(address tokenIn, address tokenOut)
        external
        view
        returns (IExecutableLiquidity.ExecutableLiquidity memory)
    {
        _requirePair(tokenIn, tokenOut);
        return _executable(tokenIn);
    }

    /// @dev `quoteSnapshot` already returns the hook's conditionally-adjusted ceiling, so the
    ///      multiplier is *not* re-applied here (passing `BPS` below). Doing so would double-count
    ///      the haircut and under-quote the pool in DEFENSIVE mode.
    function _executable(address tokenIn) private view returns (IExecutableLiquidity.ExecutableLiquidity memory) {
        (,, uint256 amount0, uint256 amount1) = HOOK.quoteSnapshot(POOL_ID);
        uint256 conditionalCeiling = tokenIn == _currency0 ? amount0 : amount1;

        return ExecutableLiquidityLib.derive({
            virtualLiquidity: conditionalCeiling,
            // Real, in-custody reserves: what the pool manager is actually holding right now.
            walletLiquidity: IERC20(tokenIn).balanceOf(address(MANAGER)),
            allowance: type(uint256).max,
            liquidityBps: uint16(FixedPointMath.BPS)
        });
    }

    /// @inheritdoc ILiquidityVenue
    function execute(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    )
        external
        returns (uint256 amountOut)
    {
        _requirePair(tokenIn, tokenOut);

        bool zeroForOne = tokenIn == _currency0;
        IERC20(tokenIn).forceApprove(address(SWAP_ROUTER), amountIn);

        BalanceDelta delta = SWAP_ROUTER.swap(
            _poolKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );

        amountOut = zeroForOne ? uint256(uint128(delta.amount1())) : uint256(uint128(delta.amount0()));
        require(amountOut >= minAmountOut, InsufficientOutput(amountOut, minAmountOut));

        IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }

    error InsufficientOutput(uint256 amountOut, uint256 minAmountOut);

    function _requirePair(address tokenIn, address tokenOut) private view {
        bool matchesZeroForOne = tokenIn == _currency0 && tokenOut == _currency1;
        bool matchesOneForZero = tokenIn == _currency1 && tokenOut == _currency0;
        require(matchesZeroForOne || matchesOneForZero, UnknownPair(tokenIn, tokenOut));
    }

    /// @dev sqrtPriceX96 (Q64.96) -> WAD price of currency0 denominated in currency1.
    function _sqrtPriceToWad(uint160 sqrtPriceX96) private pure returns (uint256) {
        uint256 intermediate = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 96); // price * 2^96
        return FullMath.mulDiv(intermediate, 1e18, 1 << 96); // price, WAD
    }
}
