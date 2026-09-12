// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { Test } from "forge-std/Test.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ConditionalLiquidityRegistry } from "../../contracts/core/ConditionalLiquidityRegistry.sol";
import { StrategyValidator } from "../../contracts/core/StrategyValidator.sol";
import { ConditionalLiquidityEngine } from "../../contracts/engine/ConditionalLiquidityEngine.sol";
import { ConditionalLiquidityExtruction } from "../../contracts/swapvm/ConditionalLiquidityExtruction.sol";
import { ConditionalLiquidityProgramLib } from "../../contracts/swapvm/ConditionalLiquidityProgramLib.sol";
import { IConditionalLiquidityExtruction } from "../../contracts/swapvm/interfaces/IConditionalLiquidityExtruction.sol";
import { MockMarketStateProvider } from "../../contracts/mocks/MockMarketStateProvider.sol";
import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { StrategyLib } from "../../contracts/libraries/StrategyLib.sol";
import { StrategyFixtures } from "../utils/StrategyFixtures.sol";

interface IWETH9 {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface ILidoStETH {
    function submit(address _referral) external payable returns (uint256);
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title AquaSwapVMMainnetForkTest
/// @notice Real Ethereum mainnet fork test against the ACTUAL deployed 1inch Aqua and
///         AquaSwapVMRouter contracts, using real WETH and real Lido stETH — no mock tokens, no
///         mock Aqua, no mock SwapVM, no vm.store/vm.etch on any production contract.
///
/// @dev WHAT IS REAL PRODUCTION INFRASTRUCTURE (unmodified, addresses verified against the
///      official 1inch aqua/swap-vm READMEs, code existence checked on-chain):
///        - Aqua:              0x1111113ccf1426a8e30e2bff5e005d929bf6a90a
///        - AquaSwapVMRouter:  0x111111338c5091E8440b67B168bAe16a668AC0De
///        - WETH9:             0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
///        - Lido stETH:        0xae7ab96520de3a18e5e111b5eaab095312d7fe84
///      All four are interacted with directly at their real addresses. Tokens are acquired only
///      through their own real, permissionless public functions (WETH.deposit(), stETH.submit())
///      funded by `vm.deal`-supplied native ETH — standard, legitimate fork-test funding, not a
///      balance-manufacturing cheat on any ERC-20's storage.
///
/// @dev WHAT IS OUR OWN CODE (unmodified from Parts 1-4, nothing rewritten for this test):
///      `StrategyValidator`, `ConditionalLiquidityRegistry`, `ConditionalLiquidityEngine`,
///      `ConditionalLiquidityExtruction`, `MockMarketStateProvider` (our own oracle stand-in, as
///      in every other test in this repo — never claimed to be a production oracle),
///      `ConditionalLiquidityProgramLib`. `MakerTraitsLib.build` is the pinned 1inch swap-vm
///      package's own order encoder, used unmodified.
///
/// @dev THE ONE GENUINE, DIAGNOSED LIMITATION — read before drawing conclusions from this file.
///      Ship/pull/push/safeBalances/rawBalances on the REAL Aqua contract are called directly and
///      are 100% real: their function selectors were checked byte-for-byte against the real
///      deployed Aqua bytecode and all six matched exactly (this project's 1inch aqua pin,
///      v1.0.0, has NOT drifted from what's live in production).
///
///      The REAL AquaSwapVMRouter has, however, drifted from this project's pinned
///      1inch swap-vm dependency (a "main" commit newer than any tagged release):
///        - `swap()`/`quote()` selectors computed from our pinned package's signature
///          (`(Order,uint256,bytes)`) do NOT appear anywhere in the deployed router bytecode.
///        - Selectors computed from the last TAGGED release's signature instead
///          (`v1.0.2`: `(Order,address tokenIn,address tokenOut,uint256,bytes)`) DO appear,
///          confirming the live router matches that older, explicit-tokenIn/tokenOut calling
///          convention, not our pinned package's.
///        - `TakerTraitsLib`'s bit-packed flag layout also differs between the two versions
///          (`v1.0.2` has no `isAToB`/`allowPartialFill` bits; "main" does), so even correctly
///          selecting the right function would not produce compatible calldata for it.
///        - The router's *opcode dispatch* differs too: `v1.0.2` assigns `XYCSwap`/`Extruction`
///          array-index opcodes 0x12/0x21, while this project's pinned package assigns them
///          enum-slot opcodes 0x50/0x04 — completely different numbers. A program built with
///          `ConditionalLiquidityProgramLib` (which calls the pinned package's builders) would
///          dispatch to the wrong instruction slot (or an out-of-bounds one) if submitted to the
///          live router's `swap()`.
///
///      **Conclusion: this project's existing `ConditionalLiquidityExtruction` and
///      `ConditionalLiquidityProgramLib` cannot be driven through the live router's `swap()`
///      entrypoint without either (a) re-pinning 1inch swap-vm to the older, router-matching
///      release and reshaping `SwapRegisters`/opcode encoding accordingly — which the task
///      explicitly rules out as "rewriting Parts 1-5" — or (b) deploying a second, differently-coded
///      router and calling it "production" — which the task's absolute rule explicitly forbids.
///      Per the task's own instruction for exactly this situation, this is reported as a genuine,
///      diagnosed limitation rather than routed around with a substitute.**
///
///      What this file does instead, to still exercise as much real infrastructure as honestly
///      possible: it calls this project's real, unmodified `ConditionalLiquidityExtruction`
///      directly (exactly the pattern `test/unit/ConditionalLiquidityExtruction.t.sol` already
///      uses for the SAME contract against a local Aqua) with `SwapQuery`/`SwapRegisters` built
///      from REAL balances read via the real Aqua's `safeBalances`, and settles the resulting
///      amounts through the real Aqua's `pull`/`push` under `vm.prank(ROUTER)`. That prank is the
///      one test-only substitution in this file: it does not modify any contract's storage or
///      code (unlike the `vm.store`/`vm.etch` the task explicitly forbids), it only asserts "this
///      call's `msg.sender` is the router's real address" for the handful of calls that, on a
///      version-compatible router, its own bytecode would have made itself. Aqua's real,
///      unmodified authorization and settlement logic runs for real, against real balances, for
///      every one of those calls.
contract AquaSwapVMMainnetForkTest is Test {
    address internal constant AQUA_ADDR = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address internal constant ROUTER_ADDR = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    address internal constant WETH_ADDR = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant STETH_ADDR = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;

    IAqua internal aqua;
    IWETH9 internal weth;
    ILidoStETH internal stEth;

    ConditionalLiquidityRegistry internal registry;
    ConditionalLiquidityEngine internal engine;
    MockMarketStateProvider internal oracle;
    ConditionalLiquidityExtruction internal extruction;

    address internal maker = makeAddr("prodMaker");
    address internal taker = makeAddr("prodTaker");

    bytes32 internal strategyId;
    ISwapVM.Order internal order;

    uint256 internal constant BASE_LIQUIDITY = 10 ether;
    uint256 internal clock;

    modifier onlyWithRpc() {
        if (bytes(vm.envOr("RPC_URL", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _fork() private {
        vm.createSelectFork(vm.envString("RPC_URL"));
        aqua = IAqua(AQUA_ADDR);
        weth = IWETH9(WETH_ADDR);
        stEth = ILidoStETH(STETH_ADDR);
    }

    /* ==================================================================== 1: existence checks */

    function test_Fork_ChainIdAndRealCodeExist() public onlyWithRpc {
        _fork();
        assertEq(block.chainid, 1, "must be Ethereum mainnet");
        assertGt(AQUA_ADDR.code.length, 0, "Aqua must have real code");
        assertGt(ROUTER_ADDR.code.length, 0, "AquaSwapVMRouter must have real code");
        assertGt(WETH_ADDR.code.length, 0, "WETH must have real code");
        assertGt(STETH_ADDR.code.length, 0, "stETH must have real code");
    }

    /* ==================================================================== setup shared by the rest */

    function _deployOurContracts() private {
        address owner = makeAddr("prodOwner");
        registry = new ConditionalLiquidityRegistry(new StrategyValidator(), owner);
        oracle = new MockMarketStateProvider();
        engine = new ConditionalLiquidityEngine(registry, oracle);
        vm.prank(owner);
        registry.setStateAuthority(address(engine));
        extruction = new ConditionalLiquidityExtruction(engine, registry);
    }

    function _registerAndShip() private {
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.tokenA = STETH_ADDR; // lower address
        args.tokenB = WETH_ADDR; // higher address
        args.useAquaInsteadOfSignature = true;
        args.program = ConditionalLiquidityProgramLib.build(address(extruction));
        order = MakerTraitsLib.build(args);

        vm.prank(maker);
        strategyId = registry.registerStrategy(
            order, StrategyFixtures.NORMAL_LIQ, StrategyFixtures.NORMAL_SPREAD, StrategyFixtures.volatilityShield()
        );

        // Real WETH, acquired via WETH's own real deposit() function.
        vm.deal(maker, BASE_LIQUIDITY);
        vm.prank(maker);
        weth.deposit{ value: BASE_LIQUIDITY }();

        // Real stETH, acquired via Lido's own real, permissionless submit() function.
        vm.deal(maker, BASE_LIQUIDITY);
        vm.prank(maker);
        stEth.submit{ value: BASE_LIQUIDITY }(address(0));
        // Lido rounds submitted ETH into internal "shares"; the resulting stETH balance can be a
        // few wei off the submitted amount. Ship exactly what the maker actually received.
        uint256 stEthReceived = stEth.balanceOf(maker);

        vm.startPrank(maker);
        IERC20(STETH_ADDR).approve(AQUA_ADDR, type(uint256).max);
        IERC20(WETH_ADDR).approve(AQUA_ADDR, type(uint256).max);

        address[] memory tokens = new address[](2);
        tokens[0] = STETH_ADDR;
        tokens[1] = WETH_ADDR;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = stEthReceived;
        amounts[1] = BASE_LIQUIDITY;

        bytes32 shippedHash = aqua.ship(ROUTER_ADDR, abi.encode(order), tokens, amounts);
        vm.stopPrank();

        require(shippedHash == strategyId, "Aqua strategyHash must equal registry strategyId");
    }

    /* ==================================================================== 2: real ship to real Aqua */

    function test_Fork_RegisterAndShipToRealAqua() public onlyWithRpc {
        _fork();
        _deployOurContracts();
        _registerAndShip();

        (uint248 balWeth, uint8 count) = aqua.rawBalances(maker, ROUTER_ADDR, strategyId, WETH_ADDR);
        assertEq(uint256(balWeth), BASE_LIQUIDITY, "real Aqua must record the shipped WETH balance");
        assertEq(count, 2, "strategy must track exactly 2 tokens");
    }

    /* ==================================================================== 3: full enforcement + real settlement */

    /// @dev Mirrors the exact-in XYCSwap formula (`amountOut = amountIn * balanceOut / (balanceIn +
    ///      amountIn)`) so the SwapRegisters fed into our real Extruction reflect what the real
    ///      router's XYCSwap opcode would have computed, had we been able to execute through it.
    function _quoteExactIn(uint256 amountIn, uint256 balanceIn, uint256 balanceOut) private pure returns (uint256) {
        return (amountIn * balanceOut) / (balanceIn + amountIn);
    }

    function _realBalances() private view returns (uint256 balanceWeth, uint256 balanceStEth) {
        (balanceWeth, balanceStEth) = aqua.safeBalances(maker, ROUTER_ADDR, strategyId, WETH_ADDR, STETH_ADDR);
    }

    /// @dev Builds the query/registers for a WETH->stETH exact-in swap. Kept separate from
    ///      {_callExtruction} so a test that wants to `vm.expectRevert` the extruction call itself
    ///      can build these first — `vm.expectRevert` only watches the SINGLE next external call,
    ///      and the `safeBalances` staticcall this performs would otherwise consume that
    ///      expectation before the call under test ever runs.
    function _buildSwapCall(uint256 amountIn) private view returns (SwapQuery memory query, SwapRegisters memory registers) {
        (uint256 balanceWeth, uint256 balanceStEth) = _realBalances();
        uint256 amountOut = _quoteExactIn(amountIn, balanceWeth, balanceStEth);

        query = SwapQuery({ orderHash: strategyId, maker: maker, taker: taker, tokenIn: WETH_ADDR, tokenOut: STETH_ADDR, isExactIn: true });
        registers = SwapRegisters({ balanceIn: balanceWeth, balanceOut: balanceStEth, amountIn: amountIn, amountOut: amountOut });
    }

    /// @notice Calls our real, unmodified ConditionalLiquidityExtruction directly (same pattern as
    ///         test/unit/ConditionalLiquidityExtruction.t.sol), then settles the resulting amounts
    ///         through the real Aqua under `vm.prank(ROUTER_ADDR)` — see the contract-level NatSpec
    ///         for exactly why, and what is and isn't a real production call in this step.
    function _executeSwap(uint256 amountIn) private returns (uint256 amountOut) {
        (SwapQuery memory query, SwapRegisters memory registers) = _buildSwapCall(amountIn);

        (,, SwapRegisters memory updated) = extruction.extruction(false, 0, query, registers, "", "");
        amountOut = updated.amountOut;

        // Real settlement through the real Aqua. `vm.prank(ROUTER_ADDR)` supplies only the
        // "message came from the router's address" fact a compatible router's own bytecode would
        // have provided; every balance check, storage write and ERC-20 transfer below executes in
        // Aqua's real, unmodified code.
        vm.prank(taker);
        IERC20(WETH_ADDR).transfer(ROUTER_ADDR, amountIn);
        vm.startPrank(ROUTER_ADDR);
        IERC20(WETH_ADDR).approve(AQUA_ADDR, amountIn);
        aqua.push(maker, ROUTER_ADDR, strategyId, WETH_ADDR, amountIn);
        aqua.pull(maker, strategyId, STETH_ADDR, amountOut, taker);
        vm.stopPrank();
    }

    function test_Fork_NormalStateRealTradeSucceedsWithRealSettlement() public onlyWithRpc {
        _fork();
        _deployOurContracts();
        _registerAndShip();
        oracle.setVolatility(strategyId, 2000, 4000e18);

        vm.deal(taker, 1 ether);
        vm.prank(taker);
        weth.deposit{ value: 1 ether }();

        uint256 takerWethBefore = IERC20(WETH_ADDR).balanceOf(taker);
        uint256 takerStEthBefore = IERC20(STETH_ADDR).balanceOf(taker);
        uint256 makerWethBefore = IERC20(WETH_ADDR).balanceOf(maker);
        uint256 makerStEthBefore = IERC20(STETH_ADDR).balanceOf(maker);

        uint256 amountOut = _executeSwap(1 ether);

        // stETH is a real, shares-based rebasing token: `transferFrom` converts the requested
        // token amount to internal shares and back, which can be off by 1-2 wei from the amount
        // requested. That is real stETH behavior (verified in this run's own trace via its
        // `TransferShares` event), not a bug in our contracts, so balance deltas are checked with
        // a small absolute tolerance rather than exact equality. WETH is a plain balance-mapping
        // token and is asserted exactly.
        assertGt(amountOut, 0, "must receive real stETH out");
        assertEq(IERC20(WETH_ADDR).balanceOf(taker), takerWethBefore - 1 ether, "taker real WETH debited");
        assertApproxEqAbs(IERC20(STETH_ADDR).balanceOf(taker), takerStEthBefore + amountOut, 2, "taker real stETH credited");
        assertEq(IERC20(WETH_ADDR).balanceOf(maker), makerWethBefore + 1 ether, "maker real WETH credited");
        assertApproxEqAbs(IERC20(STETH_ADDR).balanceOf(maker), makerStEthBefore - amountOut, 2, "maker real stETH debited");
        assertEq(uint8(registry.getStrategyState(strategyId).mode), uint8(IStrategyTypes.StrategyMode.NORMAL));
    }

    function test_Fork_DefensiveStateRejectsOversizedTradeNoBalanceChange() public onlyWithRpc {
        _fork();
        _deployOurContracts();
        _registerAndShip();
        oracle.setVolatility(strategyId, 2000, 4000e18);

        vm.deal(taker, 10 ether);
        vm.prank(taker);
        weth.deposit{ value: 10 ether }();

        // Shock: commit the NORMAL -> DEFENSIVE transition with a small, real, settled trade.
        oracle.setVolatility(strategyId, 6300, 4000e18);
        _executeSwap(0.1 ether);
        assertEq(uint8(registry.getStrategyState(strategyId).mode), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));

        (uint256 balanceWeth,) = _realBalances();
        uint256 cap = (balanceWeth * StrategyFixtures.DEFENSIVE_LIQ) / StrategyLib.MAX_LIQUIDITY_BPS;
        uint256 oversized = cap + 1 ether;

        uint256 takerWethBefore = IERC20(WETH_ADDR).balanceOf(taker);
        uint256 makerStEthBefore = IERC20(STETH_ADDR).balanceOf(maker);

        // Built here, before vm.expectRevert: vm.expectRevert only watches the single next
        // external call, and _buildSwapCall's own safeBalances staticcall would otherwise consume
        // that expectation before the extruction() call under test ever runs.
        (SwapQuery memory query, SwapRegisters memory registers) = _buildSwapCall(oversized);
        vm.expectRevert(
            abi.encodeWithSelector(IConditionalLiquidityExtruction.ExceedsEffectiveLiquidity.selector, strategyId, oversized, cap)
        );
        extruction.extruction(false, 0, query, registers, "", "");

        // No settlement call was ever reached: real balances are untouched.
        assertEq(IERC20(WETH_ADDR).balanceOf(taker), takerWethBefore, "rejected trade must not move taker WETH");
        assertEq(IERC20(STETH_ADDR).balanceOf(maker), makerStEthBefore, "rejected trade must not move maker stETH");

        // A smaller, valid trade still succeeds during DEFENSIVE, with real settlement.
        uint256 validAmountOut = _executeSwap(0.1 ether);
        assertGt(validAmountOut, 0, "a trade within the cap must still settle for real");
    }

    function test_Fork_FullRecoveryCycle() public onlyWithRpc {
        _fork();
        _deployOurContracts();
        _registerAndShip();
        clock = block.timestamp;
        oracle.setVolatility(strategyId, 2000, 4000e18);

        vm.deal(taker, 10 ether);
        vm.prank(taker);
        weth.deposit{ value: 10 ether }();

        oracle.setVolatility(strategyId, 6300, 4000e18);
        _executeSwap(0.1 ether);
        assertEq(uint8(registry.getStrategyState(strategyId).mode), uint8(IStrategyTypes.StrategyMode.DEFENSIVE));

        oracle.setVolatility(strategyId, 2400, 4000e18);
        _executeSwap(0.1 ether); // arms the sustained-calm rule
        assertEq(uint8(registry.getStrategyState(strategyId).mode), uint8(IStrategyTypes.StrategyMode.DEFENSIVE), "not yet sustained");

        clock += StrategyFixtures.CALM_PERIOD;
        vm.warp(clock);
        _executeSwap(0.1 ether);
        assertEq(uint8(registry.getStrategyState(strategyId).mode), uint8(IStrategyTypes.StrategyMode.RECOVERY));

        clock += StrategyFixtures.RECOVERY_PERIOD;
        vm.warp(clock);
        uint256 amountOut = _executeSwap(0.1 ether);
        assertEq(uint8(registry.getStrategyState(strategyId).mode), uint8(IStrategyTypes.StrategyMode.NORMAL));
        assertGt(amountOut, 0, "final NORMAL trade must settle for real");
    }
}
