// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IExecutableLiquidity
/// @notice The solvency breakdown behind a venue's headline liquidity number.
///
/// @dev Additive to {ILiquidityVenue}: `snapshot` still answers "how much may this venue quote?",
///      while this answers "and can it actually pay?". Separating them keeps the Solver's hot path
///      unchanged for venues that were already solvent, while giving the settlement path, the
///      discovery layer and the UI one shared vocabulary for the gap between advertised and real.
interface IExecutableLiquidity {
    /// @notice Every layer between a venue's advertised depth and what it can truly settle.
    /// @param virtualLiquidity Liquidity the venue advertises. For Aqua this is the maker's virtual
    ///        balance (`IAqua.safeBalances`), which is an allowance, not custody. Discovery-grade
    ///        only: never route against this field alone.
    /// @param walletLiquidity Tokens the settling party actually holds at this block.
    /// @param allowance Amount the settling party has actually approved to the contract that will
    ///        pull from them (Aqua for a maker; not applicable to a pool that holds its own
    ///        reserves, which reports `type(uint256).max`).
    /// @param deliverableLiquidity `min(virtual, wallet, allowance)` — the solvency bound, before
    ///        any strategy logic is applied.
    /// @param conditionalLiquidity `deliverableLiquidity` after the strategy's live liquidity
    ///        multiplier. This is the only field a router may allocate against.
    /// @param coverageBps `deliverableLiquidity / virtualLiquidity` in bps, clamped to 10_000.
    ///        A reliability signal for ranking and display, never a settlement input.
    struct ExecutableLiquidity {
        uint256 virtualLiquidity;
        uint256 walletLiquidity;
        uint256 allowance;
        uint256 deliverableLiquidity;
        uint256 conditionalLiquidity;
        uint16 coverageBps;
    }

    /// @notice Live solvency breakdown for `tokenIn -> tokenOut` at the current block.
    /// @dev Must be derived entirely from reads performed inside this call. Implementations may
    ///      not cache, and callers may not carry a result across a state-changing boundary — a
    ///      maker can drain their wallet or revoke their approval in the block in between.
    function executableLiquidity(address tokenIn, address tokenOut) external view returns (ExecutableLiquidity memory);
}
