// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { DeploySolver } from "../../script/DeploySolver.s.sol";
import { ISolver } from "../../contracts/solver/interfaces/ISolver.sol";
import { ILiquidityVenue } from "../../contracts/solver/interfaces/ILiquidityVenue.sol";
import { IExecutableLiquidity } from "../../contracts/venues/interfaces/IExecutableLiquidity.sol";
import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { MockERC20 } from "../../contracts/mocks/MockERC20.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

/// @notice Proves `script/DeploySolver.s.sol` actually deploys three independent, genuine
///         markets rather than one market wearing three labels — the gap flagged during planning:
///         no test previously touched the deploy script at all.
contract MultiMarketDeployTest is Test {
    DeploySolver.Market[3] internal markets;

    /// @dev Under `forge test`, `deployer.run()` is called directly by this contract, so
    ///      `msg.sender` as read inside `run()` (`vm.envOr(_, msg.sender)`) is this test contract
    ///      — but every call `run()` makes AFTER `vm.startBroadcast()` executes with sender
    ///      `tx.origin`, which under `forge test` is `DEFAULT_SENDER`, not this contract. Real
    ///      `forge script` avoids the split because its top-level call into `run()` already
    ///      originates from the broadcaster. Setting MAKER/OWNER explicitly to `DEFAULT_SENDER`
    ///      below closes that gap without touching the script itself.
    address internal maker = DEFAULT_SENDER;

    function setUp() public {
        vm.setEnv("MAKER", vm.toString(DEFAULT_SENDER));
        vm.setEnv("OWNER", vm.toString(DEFAULT_SENDER));
        DeploySolver deployer = new DeploySolver();
        DeploySolver.Market[3] memory deployed = deployer.run();
        for (uint256 i = 0; i < 3; ++i) {
            markets[i] = deployed[i];
        }
    }

    function _request(address tokenIn, address tokenOut, uint256 amount) internal pure returns (ISolver.TraderRequest memory) {
        return ISolver.TraderRequest({ tokenIn: tokenIn, tokenOut: tokenOut, amount: amount, maxSlippageBps: 10_000 });
    }

    /// 1. Three distinct token pairs, with the demo-labelled symbols/decimals the plan settled on.
    function test_ThreeDistinctPairsWithExpectedTokenMetadata() public view {
        address[] memory allTokens = new address[](6);
        for (uint256 i = 0; i < 3; ++i) {
            allTokens[i * 2] = markets[i].tokenIn;
            allTokens[i * 2 + 1] = markets[i].tokenOut;
            assertTrue(markets[i].tokenIn != markets[i].tokenOut, "pair must be two distinct tokens");
        }
        // Exactly 3 distinct tokens across all 6 slots (each token appears in two markets).
        uint256 distinct = 0;
        for (uint256 i = 0; i < 6; ++i) {
            bool seen = false;
            for (uint256 j = 0; j < i; ++j) {
                if (allTokens[i] == allTokens[j]) seen = true;
            }
            if (!seen) distinct++;
        }
        assertEq(distinct, 3, "expected exactly 3 distinct demo tokens across all markets");

        string[3] memory expectedSymbols = ["DWA", "DUSDC", "DDAI"];
        for (uint256 i = 0; i < 6; ++i) {
            MockERC20 token = MockERC20(allTokens[i]);
            assertEq(token.decimals(), 18, "every demo token must stay 18 decimals (Solver unit assumption)");
            bool matched = false;
            for (uint256 j = 0; j < 3; ++j) {
                if (keccak256(bytes(token.symbol())) == keccak256(bytes(expectedSymbols[j]))) matched = true;
            }
            assertTrue(matched, "token symbol must be one of the demo-labelled mocks");
        }
    }

    /// 2. Each market's Solver holds exactly its own AquaVenue + UniswapV4Venue.
    function test_EachSolverHoldsOnlyItsOwnMarketVenues() public view {
        for (uint256 i = 0; i < 3; ++i) {
            ILiquidityVenue[] memory venues = markets[i].solver.venues();
            assertEq(venues.length, 2, "one Aqua leg + one Uniswap leg per market");
            assertEq(address(venues[0]), address(markets[i].aquaVenue));
            assertEq(address(venues[1]), address(markets[i].uniVenue));
        }
    }

    /// 3. The solver can route each market's pair, in both directions.
    function test_SolverRoutesEveryMarketBothDirections() public view {
        for (uint256 i = 0; i < 3; ++i) {
            ISolver.ExecutionPlan memory forward = markets[i].solver.route(_request(markets[i].tokenIn, markets[i].tokenOut, 1 ether));
            assertGt(forward.totalExpectedAmountOut, 0);

            ISolver.ExecutionPlan memory reverse = markets[i].solver.route(_request(markets[i].tokenOut, markets[i].tokenIn, 1 ether));
            assertGt(reverse.totalExpectedAmountOut, 0);
        }
    }

    /// 4. No-phantom-liquidity invariant: every leg's allocation is bounded by that venue's live
    ///    executable depth, per market.
    function test_ExecutableLiquidityBoundedPerMarket() public view {
        for (uint256 i = 0; i < 3; ++i) {
            ISolver.ExecutionPlan memory plan = markets[i].solver.route(_request(markets[i].tokenIn, markets[i].tokenOut, 1 ether));
            for (uint256 l = 0; l < plan.legs.length; ++l) {
                IExecutableLiquidity.ExecutableLiquidity memory exec =
                    ILiquidityVenue(plan.legs[l].venue).executableLiquidity(markets[i].tokenIn, markets[i].tokenOut);
                assertLe(plan.legs[l].amountIn, exec.conditionalLiquidity, "leg allocation must not exceed executable depth");
            }
        }
    }

    /// 5. Aqua wallet/allowance solvency: draining the maker's wallet on one market zeroes that
    ///    market's Aqua-side executable liquidity. Market 3 (DUSDC/DDAI) shares neither token with
    ///    market 1 (DWA/DUSDC), so it is the control unaffected by draining market 1's `tokenIn`
    ///    (`DWA`) — market 2 (DWA/DDAI) is deliberately not used as the control here: the same
    ///    single EOA is the maker for every market, so it also holds market 2's DWA reserve, and
    ///    draining "the maker's DWA" is realistically one wallet, not three independent ones.
    function test_DrainingAquaMakerWalletZeroesOnlyThatMarket() public {
        MockERC20 drainedToken = MockERC20(markets[0].tokenIn);
        uint256 balance = drainedToken.balanceOf(maker);
        vm.prank(maker);
        drainedToken.transfer(makeAddr("sink"), balance);

        IExecutableLiquidity.ExecutableLiquidity memory drained =
            markets[0].aquaVenue.executableLiquidity(markets[0].tokenIn, markets[0].tokenOut);
        assertEq(drained.conditionalLiquidity, 0, "drained maker wallet must zero executable liquidity");

        IExecutableLiquidity.ExecutableLiquidity memory untouched =
            markets[2].aquaVenue.executableLiquidity(markets[2].tokenIn, markets[2].tokenOut);
        assertGt(untouched.conditionalLiquidity, 0, "a market sharing neither token must be unaffected");
    }

    /// 6. Conditional liquidity still applies: market 2 was walked into DEFENSIVE by the deploy
    ///    script's shock+poke, and reports the fixture's reduced size/wider spread on both legs,
    ///    while market 1 stayed NORMAL — read back live from chain, not asserted on the input.
    function test_ConditionalLiquidityStatesAreReal() public view {
        ILiquidityVenue.VenueSnapshot memory normalAqua = markets[0].aquaVenue.snapshot(markets[0].tokenIn, markets[0].tokenOut);
        assertEq(uint8(normalAqua.mode), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertEq(normalAqua.spreadBps, StrategyFixtures.NORMAL_SPREAD);

        ILiquidityVenue.VenueSnapshot memory defensiveAqua = markets[1].aquaVenue.snapshot(markets[1].tokenIn, markets[1].tokenOut);
        assertEq(uint8(defensiveAqua.mode), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
        assertEq(defensiveAqua.spreadBps, StrategyFixtures.DEFENSIVE_SPREAD);

        ILiquidityVenue.VenueSnapshot memory defensiveUni = markets[1].uniVenue.snapshot(markets[1].tokenIn, markets[1].tokenOut);
        assertEq(uint8(defensiveUni.mode), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));
    }

    /// 7. Marketplace data corresponds to real deployed contracts: routing one market's Solver
    ///    against another market's tokens is rejected — no shared/implicit routing across markets.
    function test_CrossMarketRoutingIsRejected() public {
        vm.expectRevert();
        markets[0].solver.route(_request(markets[1].tokenIn, markets[1].tokenOut, 1 ether));
    }
}
