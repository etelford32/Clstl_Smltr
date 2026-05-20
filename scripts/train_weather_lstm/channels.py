"""Per-channel configuration for the weather LSTM trainer.

A `ChannelConfig` bundles everything that differs across channels —
which Open-Meteo variables to fetch, how to extract a target tensor
from the fetched payload, the input/output feature layout, and the
default JSON output path. Everything else (data fetcher, window
slicer, train loop, weight exporter) is channel-agnostic.

v1 ships two channels:
  * temperature - scalar, normalised against a fixed [-50, +50] degC
    range; the diurnal cycle dominates so the LSTM mostly learns
    deviations from a sinusoidal climatology.
  * wind - 2-vector (U, V) at 10 m, decomposed from speed/direction
    at fetch time. Vector target lets a single model jointly learn
    both components instead of decoupling into two independent fits;
    physically wind is a vector field, not two scalar fields.

Adding a third channel (e.g. precipitation) is a matter of adding
one more `ChannelConfig` and one matching `_extract_*` function; the
trainer's CLI surfaces it via `--channel <name>`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import numpy as np


# ── Physical bounds for linear physical -> normalised remaps ─────────────
# Matches the bounds an eventual js/{channel}-lstm.js loader would use; if
# either side changes, both must move together or the pretrained weights
# stop being interpretable.

T_MIN_C   = -50.0
T_MAX_C   =  50.0
# 60 m/s covers all routine and most extreme winds. Cat-5 hurricanes peak
# ~80 m/s at landfall but those grid cells get clipped to the boundary
# rather than the model learning a wide unused tail.
WIND_MAX_MS = 60.0

DEG2RAD = math.pi / 180.0


# ── Channel-agnostic temporal/spatial feature builder ────────────────────
# These features depend only on epoch-seconds and (lat, lon), not on the
# channel being predicted, so we build them once for the whole grid and
# slice during window assembly.

def temporal_features(epoch_s: np.ndarray) -> np.ndarray:
    """(T,) epoch seconds -> (T, 4) sin/cos(hod), sin/cos(doy)."""
    secs = epoch_s.astype(np.float64)
    hod  = (secs % 86400) / 3600.0
    doy  = ((secs // 86400) % 365).astype(np.float64)
    two_pi = 2 * math.pi
    return np.stack([
        np.sin(two_pi * hod / 24.0),
        np.cos(two_pi * hod / 24.0),
        np.sin(two_pi * doy / 365.0),
        np.cos(two_pi * doy / 365.0),
    ], axis=-1).astype(np.float32)


def spatial_features(lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """(N,) lat/lon arrays -> (N, 3) sin(lat), cos(lat), lon/180."""
    lat_rad = lats.astype(np.float64) * DEG2RAD
    return np.stack([
        np.sin(lat_rad),
        np.cos(lat_rad),
        lons.astype(np.float64) / 180.0,
    ], axis=-1).astype(np.float32)


# ── ChannelConfig ────────────────────────────────────────────────────────

@dataclass
class ChannelConfig:
    """Per-channel knobs the trainer dispatches on.

    The `extract` callable maps the raw fetched-data dict (Open-Meteo
    archive output keyed by Open-Meteo variable name) into:
      dynamic_features: (N, T, K) — already normalised to [-1, 1] or
                        [0, 1]; will form the first K columns of the
                        per-timestep feature vector.
      targets:          (N, T, output_size) — normalised, same shape
                        the model predicts.
      normalisation:    a dict shipped into the exported JSON so the
                        browser loader knows how to denormalise.

    For v1 both temperature and wind use the same array for `dynamic
    features` and `targets` (predict what you observed), but keeping
    them separate in the signature leaves room for a precip-style
    classification head later.
    """
    name:           str
    hourly_vars:    list[str]
    output_size:    int
    feature_layout: list[str]
    output_path:    str
    unit:           str
    # MAE in normalised units multiplied by this gives MAE in `unit`.
    # For temperature the range is 100 degC; for wind 60 m/s (per
    # component; combined MAE is reported as the mean across U and V).
    physical_scale: float
    extract: Callable[[dict[str, np.ndarray]],
                      tuple[np.ndarray, np.ndarray, dict]] = field(repr=False)


# ── Temperature ──────────────────────────────────────────────────────────

def _norm_t(t_c: np.ndarray) -> np.ndarray:
    return (t_c - T_MIN_C) / (T_MAX_C - T_MIN_C)


def _extract_temperature(
    data: dict[str, np.ndarray],
) -> tuple[np.ndarray, np.ndarray, dict]:
    if "temperature_2m" not in data:
        raise KeyError("temperature_2m missing from fetched data dict")
    t_norm = _norm_t(data["temperature_2m"]).astype(np.float32)
    # Add trailing axis so dynamic_features is uniformly (N, T, K).
    dyn = t_norm[..., None]
    targets = t_norm[..., None]
    norm_meta = {
        "temperature_2m_C": {"min": T_MIN_C, "max": T_MAX_C},
    }
    return dyn, targets, norm_meta


TEMPERATURE_CHANNEL = ChannelConfig(
    name="temperature",
    hourly_vars=["temperature_2m"],
    output_size=1,
    feature_layout=[
        "T_norm",
        "sin_hod", "cos_hod", "sin_doy", "cos_doy",
        "sin_lat", "cos_lat", "lon_norm",
    ],
    output_path="js/weather-temperature-lstm-weights.json",
    unit="degC",
    physical_scale=(T_MAX_C - T_MIN_C),
    extract=_extract_temperature,
)


# ── Wind (U, V) ──────────────────────────────────────────────────────────

def _decompose_wind(speed_ms: np.ndarray,
                    direction_deg: np.ndarray,
                    ) -> tuple[np.ndarray, np.ndarray]:
    """Open-Meteo's `wind_direction_10m` is the meteorological convention
    'wind from' in degrees clockwise from north. Convert to U (east-
    ward) / V (northward) velocity components — same convention as
    js/weather-forecast-feed.js so a future inference path can paint
    these straight onto the existing wind-particle field.
    """
    dir_rad = direction_deg.astype(np.float64) * DEG2RAD
    u = -np.sin(dir_rad) * speed_ms.astype(np.float64)
    v = -np.cos(dir_rad) * speed_ms.astype(np.float64)
    return u.astype(np.float32), v.astype(np.float32)


def _extract_wind(
    data: dict[str, np.ndarray],
) -> tuple[np.ndarray, np.ndarray, dict]:
    for key in ("wind_speed_10m", "wind_direction_10m"):
        if key not in data:
            raise KeyError(f"{key} missing from fetched data dict")
    u, v = _decompose_wind(data["wind_speed_10m"], data["wind_direction_10m"])
    # Clip to the physical-bounds window before normalising; the rare
    # >60 m/s storm cell saturates to the boundary rather than the
    # model wasting capacity on a long tail.
    u_norm = np.clip(u / WIND_MAX_MS, -1.0, 1.0).astype(np.float32)
    v_norm = np.clip(v / WIND_MAX_MS, -1.0, 1.0).astype(np.float32)
    dyn = np.stack([u_norm, v_norm], axis=-1)            # (N, T, 2)
    targets = dyn                                        # joint vector target
    norm_meta = {
        "wind_u_ms": {"clip": [-WIND_MAX_MS, WIND_MAX_MS]},
        "wind_v_ms": {"clip": [-WIND_MAX_MS, WIND_MAX_MS]},
    }
    return dyn, targets, norm_meta


WIND_CHANNEL = ChannelConfig(
    name="wind",
    hourly_vars=["wind_speed_10m", "wind_direction_10m"],
    output_size=2,
    feature_layout=[
        "U_norm", "V_norm",
        "sin_hod", "cos_hod", "sin_doy", "cos_doy",
        "sin_lat", "cos_lat", "lon_norm",
    ],
    output_path="js/weather-wind-lstm-weights.json",
    unit="m/s",
    physical_scale=WIND_MAX_MS,           # per-component scale; reporting
                                          # MAE is the mean across U and V
    extract=_extract_wind,
)


# ── Registry ─────────────────────────────────────────────────────────────

CHANNELS: dict[str, ChannelConfig] = {
    "temperature": TEMPERATURE_CHANNEL,
    "wind":        WIND_CHANNEL,
}


def get_channel(name: str) -> ChannelConfig:
    if name not in CHANNELS:
        raise SystemExit(
            f"unknown channel '{name}'; choose from {sorted(CHANNELS)}"
        )
    return CHANNELS[name]
