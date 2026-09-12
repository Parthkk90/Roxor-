"""Generate differential test vectors for test/differential/ReferenceEngine.t.sol.

Runs the Python reference engine (reference_engine.py) through a deterministic pseudo-random walk
over the volatility-shield strategy's compiled bytecode, recording every (before-state, market,
now) -> (after-state) transition. The Solidity test replays the exact same sequence through
RuleEngineLib.evaluate and asserts every field matches.

Regenerate with:  python sim/generate_vectors.py
"""
from __future__ import annotations

import json
import random
from pathlib import Path

from reference_engine import MarketState, RuntimeState, StrategyMode, decode_program, evaluate

ROOT = Path(__file__).resolve().parent.parent
GOLDEN_BYTECODE = ROOT / "test" / "compiler" / "golden" / "volatility-shield.bytecode.hex"
OUTPUT = ROOT / "test" / "differential" / "vectors.json"

START_TS = 1_700_000_000
NORMAL_LIQUIDITY_BPS = 10_000
NORMAL_SPREAD_BPS = 20
PRICE = 4_000 * 10**18

# Deliberately includes both random exploration and the exact threshold values (5000/3000/600s)
# that the volatility-shield strategy is written around, so the fixture doesn't rely on chance
# alone to exercise boundary and hysteresis behaviour.
SCRIPTED_VOLATILITY = [2_000, 5_000, 4_999, 5_001, 3_000, 2_999, 6_300, 6_300, 2_400, 2_400]
SCRIPTED_JUMPS = [0, 0, 0, 0, 0, 0, 0, 300, 0, 600]


def main() -> None:
    random.seed(1337)

    _, rules = decode_program(bytes.fromhex(GOLDEN_BYTECODE.read_text().strip()[2:]))

    state = RuntimeState(
        mode=StrategyMode.NORMAL,
        reference_price=0,
        liquidity_bps=NORMAL_LIQUIDITY_BPS,
        spread_bps=NORMAL_SPREAD_BPS,
        last_transition=START_TS,
        last_execution=0,
        cumulative_volume=0,
        transition_count=0,
        armed_rule=0,
        armed_since=0,
    )

    now = START_TS
    steps = []

    def record(volatility: int, jump: int) -> None:
        nonlocal state, now
        now += jump
        market = MarketState(
            price=PRICE,
            volatility=volatility,
            price_change_5m=0,
            price_change_1h=0,
            volume=0,
            oracle_confidence=10_000,
            timestamp=now,
        )
        before = state
        after, _config = evaluate(before, market, rules, now)

        steps.append(
            {
                "beforeMode": str(int(before.mode)),
                "beforeReferencePrice": str(before.reference_price),
                "beforeLiquidityBps": str(before.liquidity_bps),
                "beforeSpreadBps": str(before.spread_bps),
                "beforeLastTransition": str(before.last_transition),
                "beforeLastExecution": str(before.last_execution),
                "beforeCumulativeVolume": str(before.cumulative_volume),
                "beforeTransitionCount": str(before.transition_count),
                "beforeArmedRule": str(before.armed_rule),
                "beforeArmedSince": str(before.armed_since),
                "marketVolatility": str(market.volatility),
                "marketPrice": str(market.price),
                "marketPriceChange5m": str(market.price_change_5m),
                "marketPriceChange1h": str(market.price_change_1h),
                "marketVolume": str(market.volume),
                "marketOracleConfidence": str(market.oracle_confidence),
                "marketTimestamp": str(market.timestamp),
                "now": str(now),
                "afterMode": str(int(after.mode)),
                "afterReferencePrice": str(after.reference_price),
                "afterLiquidityBps": str(after.liquidity_bps),
                "afterSpreadBps": str(after.spread_bps),
                "afterLastTransition": str(after.last_transition),
                "afterLastExecution": str(after.last_execution),
                "afterCumulativeVolume": str(after.cumulative_volume),
                "afterTransitionCount": str(after.transition_count),
                "afterArmedRule": str(after.armed_rule),
                "afterArmedSince": str(after.armed_since),
            }
        )
        state = after

    for vol, jump in zip(SCRIPTED_VOLATILITY, SCRIPTED_JUMPS):
        record(vol, jump)

    # Random walk: exercise arbitrary volatility values and irregular time jumps, including some
    # zero-jumps (same-block re-evaluation) and some jumps that land mid-countdown.
    for _ in range(90):
        vol = random.randint(0, 20_000)
        jump = random.choice([0, 1, 30, 60, 300, 599, 600, 601, 1200])
        record(vol, jump)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({"steps": steps}, indent=2) + "\n")
    print(f"wrote {len(steps)} steps to {OUTPUT}")


if __name__ == "__main__":
    main()
