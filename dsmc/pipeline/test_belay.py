"""
test_belay.py — smoke tests for the Belay supervisor.

Run:  python3 -m pytest dsmc/pipeline/test_belay.py -q
Or:   python3 -m dsmc.pipeline.test_belay         (plain asyncio)
"""

from __future__ import annotations

import asyncio
import logging

from pipeline.belay import Belay, SkipResult, _Pitch


def test_compute_sleep_backoff_then_recovery() -> None:
    p = _Pitch(name="x", fn=lambda: None, cadence_s=10.0,
               jitter_pct=0.0, min_sleep_s=0.01)  # type: ignore[arg-type]
    # Clean cadence
    assert abs(p.compute_sleep() - 10.0) < 1e-6

    # One failure → ~20 s (2×)
    p._consecutive_failures = 1
    assert abs(p.compute_sleep() - 20.0) < 1e-6

    # Three failures → 80 s but cap is 900 s so still 80
    p._consecutive_failures = 3
    assert abs(p.compute_sleep() - 80.0) < 1e-6

    # Hit the cap
    p._consecutive_failures = 20
    assert p.compute_sleep() <= p.backoff_cap_s

    # Back to healthy
    p._consecutive_failures = 0
    p._consecutive_skips = 0
    assert abs(p.compute_sleep() - 10.0) < 1e-6

    # A SkipResult coasts at 1.5× cadence
    p._consecutive_skips = 1
    assert abs(p.compute_sleep() - 15.0) < 1e-6


def test_skip_vs_success_fingerprint() -> None:
    p = _Pitch(name="y", fn=lambda: None, cadence_s=5.0,
               jitter_pct=0.0, min_sleep_s=0.01)  # type: ignore[arg-type]
    p._consecutive_skips = 1
    skip_sleep = p.compute_sleep()
    p._consecutive_skips = 0
    ok_sleep = p.compute_sleep()
    assert skip_sleep > ok_sleep, \
        "a skip outcome should slow the cadence, not speed it up"


async def _drive_one_pitch_through_one_cycle() -> None:
    """Drive one pitch through success → failure → recovery."""
    calls = {"n": 0, "seen_outcomes": []}
    hb_events: list[str] = []

    async def pitch():
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("boom")
        return {"ok": calls["n"]}

    async def sink(payload: dict) -> None:
        hb_events.append(payload["outcome"])

    b = Belay(heartbeat_sink=sink)
    b.add_pitch("t", pitch, cadence_s=0.05, jitter_pct=0.0,
                backoff_cap_s=0.2, min_sleep_s=0.01)

    run = asyncio.create_task(b.run())
    # Let it run a short while: ok → fail → ok → stop
    await asyncio.sleep(0.25)
    b._shutdown.set()
    await run

    assert calls["n"] >= 3, f"expected at least 3 attempts, got {calls['n']}"
    assert "error" in hb_events, "failure should be reported to the sink"
    assert "ok" in hb_events, "success should be reported to the sink"


def test_drive_one_pitch_through_one_cycle() -> None:
    asyncio.run(_drive_one_pitch_through_one_cycle())


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    test_compute_sleep_backoff_then_recovery()
    test_skip_vs_success_fingerprint()
    test_drive_one_pitch_through_one_cycle()
    print("OK")
