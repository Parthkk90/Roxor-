// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IStrategyTypes
/// @notice Shared value types for the Conditional Liquidity protocol.
/// @dev Fixed-point convention used everywhere in this protocol:
///      - Ratio-like quantities (liquidity multiplier, spread, volatility, price change)
///        are expressed in basis points, where `BPS = 10_000` means 100%.
///      - Absolute prices are expressed in WAD (1e18) fixed point.
///      There is exactly one convention so the DSL compiler, the Solidity engine and the
///      Python reference model can agree bit-for-bit.
interface IStrategyTypes {
    /// @notice Lifecycle mode of a strategy's runtime state machine.
    /// @dev The numeric values are part of the compiled strategy ABI. Never reorder them.
    enum StrategyMode {
        NORMAL,
        DEFENSIVE,
        RECOVERY
    }

    /// @notice A snapshot of external market conditions, supplied by an IMarketStateProvider.
    /// @param price Spot price of tokenA denominated in tokenB, WAD (1e18) fixed point.
    /// @param volatility Annualised (or provider-defined) volatility in bps. 5_000 == 50%.
    /// @param priceChange5m Signed price change over the trailing 5 minutes, in bps.
    /// @param priceChange1h Signed price change over the trailing hour, in bps.
    /// @param volume Trailing traded volume, denominated in tokenB base units.
    /// @param oracleConfidence Provider confidence in bps. 10_000 == fully confident.
    /// @param timestamp Unix timestamp the snapshot describes.
    struct MarketState {
        uint256 price;
        uint256 volatility;
        int256 priceChange5m;
        int256 priceChange1h;
        uint256 volume;
        uint256 oracleConfidence;
        uint256 timestamp;
    }

    /// @notice The immutable definition of a registered strategy.
    /// @dev `tokenA` and `tokenB` are stored sorted (`tokenA < tokenB`) to match the ordering
    ///      that `MakerTraitsLib.build` enforces on a SwapVM order. The pair is direction-agnostic;
    ///      swap direction is chosen by the taker at execution time.
    /// @param maker Liquidity provider that owns the strategy.
    /// @param tokenA Lower-addressed token of the pair.
    /// @param tokenB Higher-addressed token of the pair.
    /// @param baseLiquidityBps Liquidity multiplier applied in the absence of any triggered rule.
    /// @param baseSpreadBps Spread applied in the absence of any triggered rule.
    /// @param programHash keccak256 of the compiled rule program this strategy executes.
    /// @param createdAt Block timestamp of registration.
    /// @param active Whether the strategy may currently be executed against.
    struct Strategy {
        address maker;
        address tokenA;
        address tokenB;
        uint16 baseLiquidityBps;
        uint16 baseSpreadBps;
        bytes32 programHash;
        uint64 createdAt;
        bool active;
    }

    /// @notice Mutable per-strategy state carried between executions.
    /// @param mode Current state-machine mode.
    /// @param referencePrice Price recorded when the strategy last entered its current mode, WAD.
    /// @param liquidityBps Currently effective liquidity multiplier in bps.
    /// @param spreadBps Currently effective spread in bps.
    /// @param lastTransition Timestamp of the most recent mode change.
    /// @param lastExecution Timestamp of the most recent execution against this strategy.
    /// @param cumulativeVolume Lifetime volume routed through this strategy, tokenB base units.
    /// @param transitionCount Monotonic counter of mode changes, used for replay/telemetry.
    /// @param armedRule 1-based index of the duration-gated rule currently counting down, 0 if none.
    /// @param armedSince Timestamp at which `armedRule` first evaluated true.
    struct RuntimeState {
        StrategyMode mode;
        uint256 referencePrice;
        uint16 liquidityBps;
        uint16 spreadBps;
        uint64 lastTransition;
        uint64 lastExecution;
        uint256 cumulativeVolume;
        uint64 transitionCount;
        uint8 armedRule;
        uint64 armedSince;
    }

    /// @notice The liquidity configuration a strategy resolves to for one execution.
    /// @param liquidityBps Fraction of the maker's Aqua balance this strategy may quote against.
    /// @param spreadBps Spread to charge on this execution.
    /// @param mode Mode the strategy is in after evaluation.
    struct LiquidityConfig {
        uint16 liquidityBps;
        uint16 spreadBps;
        StrategyMode mode;
    }
}
