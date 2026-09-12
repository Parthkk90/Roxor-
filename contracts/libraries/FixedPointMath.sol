// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title FixedPointMath
/// @notice The single fixed-point convention shared by the contracts, the DSL compiler and the
///         Python reference model.
/// @dev Two scales exist and they are never mixed implicitly:
///      - `BPS` (10_000) for ratios: liquidity multipliers, spreads, volatility, price changes.
///      - `WAD` (1e18) for absolute prices.
library FixedPointMath {
    /// @notice Denominator for basis-point quantities. 10_000 bps == 100%.
    uint256 internal constant BPS = 10_000;

    /// @notice Denominator for WAD-scaled absolute values. 1e18 == 1.0.
    uint256 internal constant WAD = 1e18;

    /// @dev Thrown when a bps-scaled multiplier would exceed the representable range.
    error BpsOverflow(uint256 value);

    /// @notice Multiply `value` by a basis-point ratio, rounding down.
    /// @dev Rounding down is deliberate: every call site uses this to *shrink* an amount
    ///      (liquidity budget, output after spread), so rounding down always favours the maker.
    function mulBps(uint256 value, uint256 bps) internal pure returns (uint256) {
        return (value * bps) / BPS;
    }

    /// @notice Reduce `value` by a spread expressed in bps, rounding down.
    /// @dev Reverts if `spreadBps` exceeds 100%, which would otherwise underflow.
    function applySpread(uint256 value, uint256 spreadBps) internal pure returns (uint256) {
        require(spreadBps <= BPS, BpsOverflow(spreadBps));
        return mulBps(value, BPS - spreadBps);
    }

    /// @notice Absolute value of a signed bps quantity.
    /// @dev Handled via unsigned two's-complement negation so `type(int256).min` returns its true
    ///      magnitude rather than reverting, which is what a checked `-value` would do.
    function absBps(int256 value) internal pure returns (uint256) {
        unchecked {
            // forge-lint: disable-next-line(unsafe-typecast)
            return value < 0 ? ~uint256(value) + 1 : uint256(value);
        }
    }
}
