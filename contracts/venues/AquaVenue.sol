// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { IAquaVenue } from "./interfaces/IAquaVenue.sol";
import { IExecutableLiquidity } from "./interfaces/IExecutableLiquidity.sol";
import { ILiquidityVenue } from "../solver/interfaces/ILiquidityVenue.sol";
import { ExecutableLiquidityLib } from "../libraries/ExecutableLiquidityLib.sol";
import { IConditionalLiquidityEngine } from "../engine/interfaces/IConditionalLiquidityEngine.sol";
import { IConditionalLiquidityRegistry } from "../core/interfaces/IConditionalLiquidityRegistry.sol";
import { FixedPointMath } from "../libraries/FixedPointMath.sol";

/// @title AquaVenue
/// @notice {ILiquidityVenue} adapter over one Aqua/SwapVM-backed conditional-liquidity strategy.
///
/// @dev Holds no strategy/rule logic: `snapshot` reads live state exclusively through
///      {IConditionalLiquidityEngine.preview}/{IConditionalLiquidityEngine.effectiveLiquidity} and
///      Aqua's own {IAqua.safeBalances}, exactly mirroring the proven pattern in
///      `test/utils/ExecutionFixture.sol::_currentCapA`. `execute` settles for real through the
///      same `AquaSwapVMRouter.swap` entrypoint `test/utils/ExecutionFixture.sol::_swapAToB` uses,
///      with this contract itself acting as the taker (so it must hold `amountIn` and approve the
///      router before `execute` is called - see {Solver.settle}'s push-then-execute custody flow).
///
/// @dev Solvency: Aqua's virtual balance is an *allowance*, not custody. `Aqua.ship` transfers no
///      tokens, and `Aqua.pull` settles with `safeTransferFrom(maker, to, amount)` out of the
///      maker's own wallet. A maker can therefore advertise a large virtual balance while holding
///      nothing, or after revoking their ERC20 approval to Aqua. `snapshot` here consequently
///      reports `effectiveLiquidity` bounded by `min(virtual, makerWallet, makerAllowance)` via
///      {ExecutableLiquidityLib}, so the solver is structurally unable to route against liquidity
///      Aqua could not actually deliver. {executableLiquidity} exposes the same breakdown
///      unaggregated, for the settlement re-check, discovery and the UI.
///
/// @dev `referencePrice` is derived from Aqua's own live reserve ratio (`balanceOut/balanceIn`),
///      NOT from the oracle's `MarketState.price`: the oracle price only feeds the rule engine's
///      volatility/threshold logic, it is not what the underlying `XYCSwap` curve actually prices
///      trades at. Using the real reserve ratio keeps the solver's quote consistent with what
///      `execute` will actually settle.
contract AquaVenue is IAquaVenue {
    using SafeERC20 for IERC20;
    using FixedPointMath for uint256;
    using ExecutableLiquidityLib for uint256;

    IAqua public immutable AQUA;
    AquaSwapVMRouter public immutable ROUTER;
    IConditionalLiquidityEngine public immutable ENGINE;
    IConditionalLiquidityRegistry public immutable REGISTRY;
    bytes32 public immutable STRATEGY_ID;

    address private immutable _tokenA;
    address private immutable _tokenB;

    ISwapVM.Order private _order;

    constructor(
        IAqua aqua,
        AquaSwapVMRouter router,
        IConditionalLiquidityEngine engine,
        IConditionalLiquidityRegistry registry,
        bytes32 strategyId,
        ISwapVM.Order memory order
    ) {
        AQUA = aqua;
        ROUTER = router;
        ENGINE = engine;
        REGISTRY = registry;
        STRATEGY_ID = strategyId;
        _order = order;

        IConditionalLiquidityRegistry.Strategy memory strategy = registry.getStrategy(strategyId);
        _tokenA = strategy.tokenA;
        _tokenB = strategy.tokenB;
    }

    /// @inheritdoc ILiquidityVenue
    function snapshot(address tokenIn, address tokenOut) external view returns (VenueSnapshot memory) {
        _requirePair(tokenIn, tokenOut);

        (, LiquidityConfig memory config) = ENGINE.preview(STRATEGY_ID);
        (IExecutableLiquidity.ExecutableLiquidity memory exec, uint256 balanceOut) = _executable(tokenIn, tokenOut, config);

        // Price comes from Aqua's advertised reserve ratio (what the XYCSwap curve actually
        // prices against), while depth comes from the solvency-bounded figure. The two are
        // deliberately sourced differently: a maker's wallet running dry changes how much they
        // can fill, not what the curve quotes.
        uint256 referencePrice = exec.virtualLiquidity == 0 ? 0 : (balanceOut * FixedPointMath.WAD) / exec.virtualLiquidity;

        return VenueSnapshot({
            venue: address(this),
            strategyId: STRATEGY_ID,
            mode: config.mode,
            effectiveLiquidity: exec.conditionalLiquidity,
            spreadBps: config.spreadBps,
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
        (, LiquidityConfig memory config) = ENGINE.preview(STRATEGY_ID);
        (IExecutableLiquidity.ExecutableLiquidity memory exec,) = _executable(tokenIn, tokenOut, config);
        return exec;
    }

    /// @dev The single place Aqua solvency is computed, shared by `snapshot` and
    ///      `executableLiquidity` so the two can never disagree.
    /// @return exec Full solvency breakdown for the `tokenIn` side.
    /// @return balanceOut Aqua's advertised `tokenOut` balance, used only for pricing.
    function _executable(
        address tokenIn,
        address tokenOut,
        LiquidityConfig memory config
    )
        private
        view
        returns (IExecutableLiquidity.ExecutableLiquidity memory exec, uint256 balanceOut)
    {
        IConditionalLiquidityRegistry.Strategy memory strategy = REGISTRY.getStrategy(STRATEGY_ID);
        uint256 balanceIn;
        (balanceIn, balanceOut) = AQUA.safeBalances(strategy.maker, address(ROUTER), STRATEGY_ID, tokenIn, tokenOut);

        // A deactivated strategy quotes nothing, matching `ENGINE.effectiveLiquidity`'s own
        // short-circuit. Carried here explicitly because this path does not call through it.
        uint16 liquidityBps = REGISTRY.isActive(STRATEGY_ID) ? config.liquidityBps : 0;

        exec = ExecutableLiquidityLib.derive({
            virtualLiquidity: balanceIn,
            // Aqua pulls with `safeTransferFrom(maker, ...)`, so the maker's own wallet and their
            // approval *to Aqua* (not to the router) are the two real settlement constraints.
            walletLiquidity: IERC20(tokenIn).balanceOf(strategy.maker),
            allowance: IERC20(tokenIn).allowance(strategy.maker, address(AQUA)),
            liquidityBps: liquidityBps
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

        IERC20(tokenIn).forceApprove(address(ROUTER), amountIn);

        TakerTraitsLib.Args memory targs;
        targs.taker = address(this);
        targs.isExactIn = true;
        targs.isFirstTransferFromTaker = true;
        targs.useTransferFromAndAquaPush = true;
        targs.isAToB = tokenIn == _tokenA;
        targs.threshold = abi.encodePacked(minAmountOut);

        (, amountOut,) = ROUTER.swap(_order, amountIn, TakerTraitsLib.build(targs));

        IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }

    function _requirePair(address tokenIn, address tokenOut) private view {
        bool matchesAToB = tokenIn == _tokenA && tokenOut == _tokenB;
        bool matchesBToA = tokenIn == _tokenB && tokenOut == _tokenA;
        require(matchesAToB || matchesBToA, UnknownPair(tokenIn, tokenOut));
    }
}
