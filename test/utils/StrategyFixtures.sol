// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import { IStrategyTypes } from "../../contracts/core/interfaces/IStrategyTypes.sol";
import { RuleProgram } from "../../contracts/libraries/RuleProgram.sol";
import { RuleProgramBuilder } from "./RuleProgramBuilder.sol";

/// @notice The canonical "volatility shield" strategy, shared by every part of the test suite.
///
/// @dev Hysteresis is expressed with two *different* thresholds rather than one, which is the
///      whole point: entering DEFENSIVE needs volatility >= 50%, but leaving it needs volatility
///      < 30%. Between 30% and 50% the strategy simply holds its current mode, so a market
///      oscillating around a single threshold cannot make it flap.
///
///      NORMAL --(sigma >= 50%)--> DEFENSIVE --(sigma < 30% for 10 min)--> RECOVERY --(10 min)--> NORMAL
///                                     ^                                       |
///                                     +-------------(sigma >= 50%)------------+
library StrategyFixtures {
    uint256 internal constant ENTER_DEFENSIVE_BPS = 5000; // 50% volatility
    uint256 internal constant LEAVE_DEFENSIVE_BPS = 3000; // 30% volatility
    uint32 internal constant CALM_PERIOD = 10 minutes;
    uint32 internal constant RECOVERY_PERIOD = 10 minutes;

    uint16 internal constant NORMAL_LIQ = 10_000; // 100%
    uint16 internal constant DEFENSIVE_LIQ = 2500; // 25%
    uint16 internal constant RECOVERY_LIQ = 5000; // 50%

    uint16 internal constant NORMAL_SPREAD = 20; // 20 bps
    uint16 internal constant DEFENSIVE_SPREAD = 90; // 90 bps
    uint16 internal constant RECOVERY_SPREAD = 50; // 50 bps

    function _mode(IStrategyTypes.StrategyMode m) private pure returns (int256) {
        return int256(uint256(uint8(m)));
    }

    function volatilityShield() internal pure returns (bytes memory) {
        bytes[] memory rules = new bytes[](4);

        // 0: calm -> shock. Fires immediately; a market crash should not wait out a timer.
        rules[0] = RuleProgramBuilder.rule(
            0,
            bytes.concat(
                RuleProgramBuilder.cond(
                    RuleProgram.ConditionType.MODE, RuleProgram.Comparison.EQ, _mode(IStrategyTypes.StrategyMode.NORMAL)
                ),
                RuleProgramBuilder.cond(RuleProgram.ConditionType.VOLATILITY, RuleProgram.Comparison.GTE, int256(ENTER_DEFENSIVE_BPS))
            ),
            bytes.concat(
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_MODE, uint256(uint8(IStrategyTypes.StrategyMode.DEFENSIVE))),
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_LIQUIDITY, DEFENSIVE_LIQ),
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_SPREAD, DEFENSIVE_SPREAD)
            )
        );

        // 1: shock -> calming. Requires the calm to be *sustained*, not a single quiet sample.
        rules[1] = RuleProgramBuilder.rule(
            CALM_PERIOD,
            bytes.concat(
                RuleProgramBuilder.cond(
                    RuleProgram.ConditionType.MODE, RuleProgram.Comparison.EQ, _mode(IStrategyTypes.StrategyMode.DEFENSIVE)
                ),
                RuleProgramBuilder.cond(RuleProgram.ConditionType.VOLATILITY, RuleProgram.Comparison.LT, int256(LEAVE_DEFENSIVE_BPS))
            ),
            bytes.concat(
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_MODE, uint256(uint8(IStrategyTypes.StrategyMode.RECOVERY))),
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_LIQUIDITY, RECOVERY_LIQ),
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_SPREAD, RECOVERY_SPREAD)
            )
        );

        // 2: relapse during recovery. Ordered before rule 3 so a fresh shock beats the timer.
        rules[2] = RuleProgramBuilder.rule(
            0,
            bytes.concat(
                RuleProgramBuilder.cond(
                    RuleProgram.ConditionType.MODE, RuleProgram.Comparison.EQ, _mode(IStrategyTypes.StrategyMode.RECOVERY)
                ),
                RuleProgramBuilder.cond(RuleProgram.ConditionType.VOLATILITY, RuleProgram.Comparison.GTE, int256(ENTER_DEFENSIVE_BPS))
            ),
            bytes.concat(
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_MODE, uint256(uint8(IStrategyTypes.StrategyMode.DEFENSIVE))),
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_LIQUIDITY, DEFENSIVE_LIQ),
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_SPREAD, DEFENSIVE_SPREAD)
            )
        );

        // 3: recovery complete -> back to full size.
        rules[3] = RuleProgramBuilder.rule(
            0,
            bytes.concat(
                RuleProgramBuilder.cond(
                    RuleProgram.ConditionType.MODE, RuleProgram.Comparison.EQ, _mode(IStrategyTypes.StrategyMode.RECOVERY)
                ),
                RuleProgramBuilder.cond(
                    RuleProgram.ConditionType.TIME_SINCE_TRANSITION, RuleProgram.Comparison.GTE, int256(uint256(RECOVERY_PERIOD))
                )
            ),
            bytes.concat(
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_MODE, uint256(uint8(IStrategyTypes.StrategyMode.NORMAL))),
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_LIQUIDITY, NORMAL_LIQ),
                RuleProgramBuilder.act(RuleProgram.ActionType.SET_SPREAD, NORMAL_SPREAD)
            )
        );

        return RuleProgramBuilder.program(rules);
    }
}
