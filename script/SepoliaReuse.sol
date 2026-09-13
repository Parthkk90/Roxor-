// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title SepoliaReuse
/// @notice Every Ethereum Sepolia address this project REUSES rather than redeploys, with the
///         evidence that justified reusing it.
///
/// @dev Nothing here is taken on trust from a docs page or a prior README. Each address was
///      verified on-chain before being written down (`scripts/audit/*.mjs`, results recorded in
///      `docs/sepolia-deployment.md`): code present, code length matching the artifact this
///      repository builds today, and the contract answering the calls the current source expects.
///
/// @dev PROFILE NOTE. The 1inch half of the stack was originally broadcast under
///      `FOUNDRY_PROFILE=ci` (optimizer_runs = 700) because `AquaSwapVMRouter` compiles to 26,774
///      bytes under this project's default profile - over EIP-170 - and a default-profile
///      broadcast therefore lands EMPTY router code on a real chain. That is not a hypothetical:
///      the earlier `DeploySolver` Sepolia run left exactly such an empty router at
///      `0x302C...09EA`, which is why the whole `DeploySolver` Aqua half is classified INVALID and
///      the `DeployAquaFix` addresses below are the live ones.
library SepoliaReuse {
    uint256 internal constant CHAIN_ID = 11_155_111;

    /* ------------------------------------------------------------ project test tokens (REUSED) */

    /// @notice "Demo Token B" (DTB), 18 decimals. Lower-addressed token of the pair => `tokenA`.
    address internal constant DTB = 0x246b76e37825a473Ae784Ce14A2Bb42733A8f922;
    /// @notice "Demo Token A" (DTA), 18 decimals. Higher-addressed token of the pair => `tokenB`.
    address internal constant DTA = 0xFE14a75D92e1A028ebb497dAc4D25bF2e08B3Af3;

    /* ------------------------------------------------- 1inch Aqua / SwapVM half (REUSED, `ci`) */

    address internal constant AQUA = 0xB9e780c07B3d36Af0090B011bd0233Ca8b212844;
    address internal constant AQUA_SWAPVM_ROUTER = 0x8FCF7D68df61a9FCf2009e606ff632E97BdDEAEC;
    address internal constant AQUA_REGISTRY = 0x9888e8C6CffBEbF792C6B0B3d1085B7B11Da61a7;
    address internal constant AQUA_ENGINE = 0x1ee607310423099D47F3B35d59F8BB66690EC952;
    address internal constant AQUA_EXTRUCTION = 0xb21Bf6e48FbcFDf83a7685924A244510Db08bC75;
    address internal constant AQUA_ORACLE = 0x40b30ECEF85Ea5E850373544ba3A6D02bd7b49a2;

    /// @notice Strategy registered by `DeployAquaFix`, shipped into Aqua, still active.
    bytes32 internal constant AQUA_STRATEGY_ID = 0xd4e296704cf420357c0d20976f594a2e301e01b4da3734f2b37d5184d852a2df;

    /* --------------------------------------------- Uniswap-side strategy plumbing (REUSED) */

    address internal constant UNI_REGISTRY = 0x738b102E559EEBE23F5a67cC61798CBcB14284dB;
    address internal constant UNI_ENGINE = 0x4670CC0Ab2322F5aFcaa9ec91ee3fbE0d35A2D55;
    address internal constant UNI_ORACLE = 0xD0b139BF9c0576A96b48C3b9c3C5b0ed336cabF4;

    /// @notice Strategy registered in {UNI_REGISTRY} by `DeploySolver`, maker = deployer, active.
    bytes32 internal constant UNI_STRATEGY_ID = 0xacdbaa77ce0882057769fb71336eb3deff305c7a15a2bb821b62ffc55d77d911;

    /* ------------------------------------------------ official Uniswap v4 on Sepolia (REUSED) */

    /// @dev Uniswap's own Sepolia `PoolManager`. Verified live: 24,009 bytes of code, `extsload`
    ///      answers, `owner()` is Uniswap's (`0x5b73C549...`), not this project's deployer. The
    ///      earlier `DeploySolver` run deployed a *second, private* PoolManager
    ///      (`0x7C88...Ba21`, owner = this project's deployer) - duplicate protocol infrastructure
    ///      that this deployment deliberately stops using.
    address internal constant V4_POOL_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant V4_POOL_SWAP_TEST = 0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe;
    address internal constant V4_POOL_MODIFY_LIQUIDITY_TEST = 0x0C478023803a644c94c4CE1C1e7b9A087e411B0A;

    /// @dev Canonical deterministic-deployment proxy, used to CREATE2-mine the hook address so it
    ///      carries the permission bits v4 requires.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
}
