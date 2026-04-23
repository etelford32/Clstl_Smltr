"""
belay.py — a lightweight in-process task supervisor
====================================================
"Climbing-gear" approach to pipeline scheduling: no cron, no external
orchestrator, no external queue. One asyncio event loop, multiple named
"pitches" (periodic tasks), each with its own cadence and self-arresting
backoff on failure.

Why not cron?
  Cron is a fire-and-forget timer. If a task is flapping because NOAA is
  throttling us, cron will keep piling on requests; if a task crashes,
  cron leaves no breadcrumbs. Inside a long-lived Python process we can
  do much better in ~200 lines.

Design principles (climbing-gear analogues):

  * Locking carabiner (idempotent heartbeats)
      Every attempt — successful or not — writes a heartbeat row with the
      outcome, duration, and next scheduled fire time. You can't forget
      to record a call because the decorator owns that path.

  * Dynamic rope (exponential backoff w/ jitter)
      On consecutive failures we double the sleep interval up to a cap
      (default 15 min), with ±20 % jitter so parallel instances don't
      thunder-herd upstream. On a successful run the interval snaps back
      to the configured cadence.

  * Prusik knot (adaptive cadence)
      A task's callable may return a `SkipResult(reason=...)` when the
      upstream data hasn't changed (e.g. a cached ETag hit). We coast at
      half cadence until new data appears — gentler on the upstream,
      still responsive when the storm hits.

  * Self-arrest (SIGTERM aware)
      A single signal handler sets the shutdown event; all pitches
      finish their in-flight call and exit cleanly before the container
      stops.

Usage
-----

    async def pull_f107():
        ...
        return {"records": 1}

    async def pull_kp():
        ...

    belay = Belay()
    belay.add_pitch("f107_daily",  pull_f107, cadence_s=3600)
    belay.add_pitch("ap_index_3h", pull_kp,   cadence_s=300)
    asyncio.run(belay.run())

Each pitch writes to the `pipeline_heartbeat` table so Grafana can show
which loops are alive and when they last succeeded.
"""

from __future__ import annotations

import asyncio
import logging
import random
import signal
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

log = logging.getLogger("dsmc.belay")

# A pitch callable returns either a plain dict (success), a SkipResult
# (upstream unchanged), or raises (failure).
PitchFn = Callable[[], Awaitable[Any]]


@dataclass
class SkipResult:
    """Return this from a pitch when the upstream had nothing new."""
    reason: str = "no-new-data"


@dataclass
class _Pitch:
    name: str
    fn: PitchFn
    cadence_s: float                  # nominal interval on success
    backoff_cap_s: float = 900.0      # max backoff on failure (15 min)
    jitter_pct: float = 0.20          # ±20 % jitter
    min_sleep_s: float = 1.0          # floor — protects upstream from hammering
    _consecutive_failures: int = 0
    _consecutive_skips: int = 0
    _last_run_utc: Optional[datetime] = None
    _last_ok_utc: Optional[datetime] = None
    _last_error: Optional[str] = None
    _next_sleep_s: float = field(init=False, default=0.0)

    def compute_sleep(self) -> float:
        """Work out how long to wait before the next attempt."""
        if self._consecutive_failures > 0:
            # Dynamic rope — doubles each failure, caps out, jittered.
            base = min(self.cadence_s * (2 ** self._consecutive_failures),
                       self.backoff_cap_s)
        elif self._consecutive_skips > 0:
            # Prusik — coast at half cadence while upstream is quiet.
            base = self.cadence_s * 1.5
        else:
            base = self.cadence_s
        jitter = base * self.jitter_pct
        return max(self.min_sleep_s, base + random.uniform(-jitter, jitter))


class Belay:
    """An asyncio-based supervisor for periodic pipeline tasks."""

    def __init__(
        self,
        *,
        heartbeat_sink: Optional[Callable[[dict], Awaitable[None]]] = None,
    ):
        self._pitches: list[_Pitch] = []
        self._shutdown = asyncio.Event()
        self._heartbeat_sink = heartbeat_sink

    # ── Registration ──────────────────────────────────────────────────────
    def add_pitch(
        self,
        name: str,
        fn: PitchFn,
        *,
        cadence_s: float,
        backoff_cap_s: float = 900.0,
        jitter_pct: float = 0.20,
        min_sleep_s: float = 1.0,
    ) -> None:
        if any(p.name == name for p in self._pitches):
            raise ValueError(f"pitch name already registered: {name}")
        self._pitches.append(_Pitch(
            name=name,
            fn=fn,
            cadence_s=cadence_s,
            backoff_cap_s=backoff_cap_s,
            jitter_pct=jitter_pct,
            min_sleep_s=min_sleep_s,
        ))
        log.info("belay: registered pitch %s (cadence=%.0fs)", name, cadence_s)

    # ── Runtime ───────────────────────────────────────────────────────────
    async def run(self) -> None:
        """Drive all registered pitches until SIGTERM/SIGINT."""
        if not self._pitches:
            log.warning("belay.run() called with no pitches — returning")
            return

        self._install_signal_handlers()

        # Start each pitch as its own task; they're independent.
        tasks = [asyncio.create_task(self._drive(p), name=f"belay:{p.name}")
                 for p in self._pitches]

        await self._shutdown.wait()
        log.info("belay: shutdown requested — waiting for in-flight pitches")

        # Give each pitch a moment to finish its current attempt; then cancel.
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        log.info("belay: all pitches stopped cleanly")

    def _install_signal_handlers(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, self._shutdown.set)
            except NotImplementedError:
                # Windows — fall back to default handling.
                pass

    async def _drive(self, pitch: _Pitch) -> None:
        """Run a single pitch in a self-healing loop."""
        # Small initial scatter so we don't fire every pitch at t=0.
        # Cap the scatter at min(5 s, 10% of cadence) so fast-cadence pitches
        # (and unit tests) don't wait forever to fire their first attempt.
        scatter_cap = min(5.0, pitch.cadence_s * 0.1)
        if scatter_cap > 0:
            await self._interruptible_sleep(random.uniform(0.0, scatter_cap))

        while not self._shutdown.is_set():
            t0 = time.monotonic()
            outcome = "ok"
            detail: dict = {}
            try:
                result = await pitch.fn()
                if isinstance(result, SkipResult):
                    outcome = "skip"
                    detail = {"reason": result.reason}
                    pitch._consecutive_skips += 1
                    pitch._consecutive_failures = 0
                else:
                    outcome = "ok"
                    pitch._consecutive_failures = 0
                    pitch._consecutive_skips = 0
                    pitch._last_ok_utc = datetime.now(timezone.utc)
                    detail = result if isinstance(result, dict) else {"result": str(result)[:200]}
                pitch._last_error = None

            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — supervisor must catch all
                outcome = "error"
                pitch._consecutive_failures += 1
                pitch._last_error = f"{type(exc).__name__}: {exc}"
                log.exception("belay[%s] attempt failed (streak=%d): %s",
                              pitch.name, pitch._consecutive_failures, exc)
                detail = {"error": pitch._last_error}

            pitch._last_run_utc = datetime.now(timezone.utc)
            duration_ms = (time.monotonic() - t0) * 1000.0
            pitch._next_sleep_s = pitch.compute_sleep()

            await self._emit_heartbeat(pitch, outcome, duration_ms, detail)

            await self._interruptible_sleep(pitch._next_sleep_s)

    async def _interruptible_sleep(self, seconds: float) -> None:
        """Sleep that wakes up immediately on shutdown."""
        try:
            await asyncio.wait_for(self._shutdown.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    async def _emit_heartbeat(
        self,
        pitch: _Pitch,
        outcome: str,
        duration_ms: float,
        detail: dict,
    ) -> None:
        payload = {
            "pitch":               pitch.name,
            "outcome":             outcome,
            "duration_ms":         round(duration_ms, 1),
            "consecutive_fails":   pitch._consecutive_failures,
            "consecutive_skips":   pitch._consecutive_skips,
            "next_sleep_s":        round(pitch._next_sleep_s, 1),
            "last_run_utc":        pitch._last_run_utc.isoformat() if pitch._last_run_utc else None,
            "last_ok_utc":         pitch._last_ok_utc.isoformat()  if pitch._last_ok_utc  else None,
            "last_error":          pitch._last_error,
            "detail":              detail,
        }
        if self._heartbeat_sink is None:
            log.info("belay[%s] %s (%.0fms, next=%.0fs)",
                     pitch.name, outcome, duration_ms, pitch._next_sleep_s)
            return
        try:
            await self._heartbeat_sink(payload)
        except Exception as exc:  # noqa: BLE001
            # Never let a heartbeat sink failure kill the belay.
            log.warning("belay[%s] heartbeat sink failed: %s", pitch.name, exc)

    # ── Introspection (useful for /health endpoint) ──────────────────────
    def snapshot(self) -> list[dict]:
        """Return a plain-Python view of every pitch's recent state."""
        return [
            {
                "name":                p.name,
                "cadence_s":           p.cadence_s,
                "consecutive_fails":   p._consecutive_failures,
                "consecutive_skips":   p._consecutive_skips,
                "last_run_utc":        p._last_run_utc.isoformat() if p._last_run_utc else None,
                "last_ok_utc":         p._last_ok_utc.isoformat()  if p._last_ok_utc  else None,
                "last_error":          p._last_error,
                "next_sleep_s":        round(p._next_sleep_s, 1),
            }
            for p in self._pitches
        ]
