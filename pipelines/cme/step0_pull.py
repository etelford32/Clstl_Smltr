#!/usr/bin/env python3
"""
Parker Physics — CME Validation Step 0: Truth Data Pull
=======================================================
Pulls primary-source truth data for the Phase 1 hindcast event list and
verifies/updates the planning approximations in phase1_hindcast_events.csv.

This is the offline, auditable half of the CME forecasting/validation
pipeline (see CME_FORECAST_VALIDATION_PLAN.md at the repo root). The live
half already exists: api/cron/validation-rerun.js scores DONKI/ENLIL CME
arrivals against self-detected Pdyn shocks daily and writes
validation_runs(kind='cme'). Step 0 gives that loop what it lacks —
authoritative, external ground truth per historical event.

Sources:
  1. DONKI (kauai.ccmc.gsfc.nasa.gov) — CME characterization + GST records.
     No API key required for the kauai WS endpoints.
  2. CDAWeb HAPI (cdaweb.gsfc.nasa.gov/hapi) — OMNI 1-min (SYM-H, flow speed,
     Bz, density) and OMNI2 hourly (Dst, Kp). Named-parameter CSV, so no
     fixed-width column-index guessing. Note: OMNI ingests Kyoto WDC Dst, so
     this satisfies Phase 1; cite Kyoto WDC as the upstream authority.
  3. Richardson–Cane ICME list (izw1.caltech.edu) — ICME boundaries at L1.

Outputs (in --outdir):
  raw/                      cached raw responses (reproducibility record)
  truth_pull.json           per-event structured truth data
  discrepancy_report.md     planning values vs. primary sources
  phase1_hindcast_events_verified.csv   updated CSV, verified flag flipped
  inserts.sql               INSERTs for cme_events / cme_l1_observations /
                            cme_geomag_observations (schema:
                            supabase-cme-validation-migration.sql)

Usage:
  pip install requests pandas lxml
  python step0_pull.py --events phase1_hindcast_events.csv --outdir ./step0_out
  python step0_pull.py --events ... --only PP-HC-2024-0510      # single event
  python step0_pull.py --self-test                              # offline parser tests

DONKI coverage note: DONKI begins ~2010. Tier A events from 2000–2005
(Bastille Day, Halloween 2003, Nov 2004, May 2005) will return no DONKI
records — for those, launch kinematics must come from the LASCO CDAW catalog
(https://cdaw.gsfc.nasa.gov/CME_list/), which this script flags but does not
parse (CDAW is fixed-format HTML per month; do it as a follow-up or manually
for the Tier A events). SYM-H/Dst/OMNI coverage extends back through all
events.
"""

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import requests
    import pandas as pd
except ImportError:
    requests = pd = None
    if "--self-test" not in sys.argv:
        print("pip install requests pandas lxml", file=sys.stderr)
        sys.exit(1)

DONKI_BASE = "https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get"
HAPI_BASE = "https://cdaweb.gsfc.nasa.gov/hapi"
RC_LIST_URL = "https://izw1.caltech.edu/ACE/ASC/DATA/level3/icmetable2.htm"

UTC = timezone.utc

# HAPI/OMNI fill sentinels, per parameter. A single magnitude threshold is
# WRONG here: proton_density fills with 999.99 and KP1800 with 99 — both far
# below any blanket 9.9e3 cutoff, so they'd survive as fake "observations"
# (density max 999.99 /cc, Kp 9.9). Null anything >= 99.9% of its sentinel.
HAPI_FILL = {
    "SYM_H": 99999.0,
    "flow_speed": 99999.9,
    "BZ_GSM": 9999.99,
    "proton_density": 999.99,
    "DST1800": 99999.0,
    "KP1800": 99.0,
}


def parse_ts(s: str) -> datetime:
    """Parse the timestamp formats that appear in the event CSV and DONKI.
    Date-only strings are taken as 00:00 UTC."""
    s = s.strip().replace("Z", "+00:00")
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M%z", "%Y-%m-%d%z"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    try:  # date-only, no timezone suffix
        return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=UTC)
    except ValueError:
        pass
    raise ValueError(f"unparseable timestamp: {s}")


def null_fills(df, params: list) -> None:
    """Null out HAPI fill sentinels in place, per-parameter (see HAPI_FILL)."""
    for c in params:
        fill = HAPI_FILL.get(c)
        if fill is None:
            # Unknown parameter: fall back to the coarse magnitude cut so a
            # new column never silently keeps 1e31-style fills.
            df.loc[df[c].abs() > 9.9e3, c] = None
            continue
        df.loc[df[c].abs() >= abs(fill) * 0.999, c] = None


# ---------------------------------------------------------------------------
# Cached fetching — every raw response is written to raw/ keyed by URL hash,
# so re-runs are free and the pull is auditable/reproducible.
# ---------------------------------------------------------------------------
class CachedFetcher:
    def __init__(self, raw_dir: Path, pause_s: float = 1.0):
        self.raw_dir = raw_dir
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.pause_s = pause_s

    def get(self, url: str, timeout: int = 60) -> str:
        key = hashlib.sha256(url.encode()).hexdigest()[:24]
        cache = self.raw_dir / f"{key}.txt"
        meta = self.raw_dir / f"{key}.meta.json"
        if cache.exists():
            return cache.read_text()
        resp = requests.get(url, timeout=timeout,
                            headers={"User-Agent": "ParkerPhysics-Step0/0.1"})
        resp.raise_for_status()
        cache.write_text(resp.text)
        meta.write_text(json.dumps({
            "url": url,
            "fetched_at": datetime.now(UTC).isoformat(),
            "status": resp.status_code,
            "sha256": hashlib.sha256(resp.text.encode()).hexdigest(),
        }, indent=2))
        time.sleep(self.pause_s)  # be polite to government servers
        return resp.text


# ---------------------------------------------------------------------------
# DONKI — CME characterization + geomagnetic storm records
# Field names verified against a live CMEAnalysis response (2016-09 sample):
#   time21_5, latitude, longitude, halfAngle, speed, type, isMostAccurate,
#   associatedCMEID, associatedCMEstartTime, catalog, link
# (Same field set api/donki/cme.js consumes on the live side.)
# ---------------------------------------------------------------------------
def pick_cme_analysis(analyses: list, window_start: datetime,
                      window_end: datetime) -> "dict | None":
    """Choose the best CMEAnalysis in the launch window: most-accurate,
    Earth-directed-ish (|lon| <= 60 when known), fastest wins ties."""
    candidates = []
    for a in analyses:
        try:
            t = parse_ts(a["associatedCMEstartTime"])
        except (KeyError, ValueError):
            continue
        if not (window_start <= t <= window_end):
            continue
        if not a.get("isMostAccurate", False):
            continue
        lon = a.get("longitude")
        if lon is not None and abs(lon) > 60:
            continue  # likely flank/far-side; keep threshold generous
        candidates.append(a)
    if not candidates:
        return None
    return max(candidates, key=lambda a: a.get("speed") or 0)


def pull_donki_for_event(fetcher, launch: datetime, arrival: datetime) -> dict:
    d0 = (launch - timedelta(days=1)).strftime("%Y-%m-%d")
    d1 = (launch + timedelta(days=2)).strftime("%Y-%m-%d")
    g0 = (arrival - timedelta(days=1)).strftime("%Y-%m-%d")
    g1 = (arrival + timedelta(days=3)).strftime("%Y-%m-%d")

    out = {"cme_analysis": None, "gst": None, "ips": None, "donki_notes": []}

    txt = fetcher.get(f"{DONKI_BASE}/CMEAnalysis?startDate={d0}&endDate={d1}"
                      f"&mostAccurateOnly=true&catalog=ALL")
    analyses = json.loads(txt) if txt.strip() else []
    best = pick_cme_analysis(analyses,
                             launch - timedelta(hours=24),
                             launch + timedelta(hours=36))
    if best:
        out["cme_analysis"] = {
            "donki_id": best.get("associatedCMEID"),
            "launch_time_utc": best.get("associatedCMEstartTime"),
            "speed_kms_3d": best.get("speed"),
            "half_width_deg": best.get("halfAngle"),
            "direction_lat_deg": best.get("latitude"),
            "direction_lon_deg": best.get("longitude"),
            "cme_class": best.get("type"),
            "catalog": best.get("catalog"),
            "donki_link": best.get("link"),
        }
    else:
        out["donki_notes"].append(
            "no DONKI CMEAnalysis in window (pre-2010 event or gap) — "
            "use LASCO CDAW catalog manually")

    # Geomagnetic storm record (kpIndex time series + linked events)
    txt = fetcher.get(f"{DONKI_BASE}/GST?startDate={g0}&endDate={g1}")
    gsts = json.loads(txt) if txt.strip() else []
    if gsts:
        kp_all = [(k.get("observedTime"), k.get("kpIndex"))
                  for g in gsts for k in (g.get("allKpIndex") or [])]
        kp_max = max((k for _, k in kp_all if k is not None), default=None)
        out["gst"] = {"gst_ids": [g.get("gstID") for g in gsts],
                      "kp_max": kp_max, "n_kp_points": len(kp_all)}

    # Interplanetary shock (arrival cross-check)
    txt = fetcher.get(f"{DONKI_BASE}/IPS?startDate={g0}&endDate={g1}&location=Earth")
    ips = json.loads(txt) if txt.strip() else []
    if ips:
        out["ips"] = [{"eventTime": s.get("eventTime"),
                       "activityID": s.get("activityID")} for s in ips]
    return out


# ---------------------------------------------------------------------------
# OMNI via CDAWeb HAPI — named parameters, CSV, no column guessing
# ---------------------------------------------------------------------------
def hapi_csv(fetcher, dataset: str, params: str,
             t0: datetime, t1: datetime) -> "pd.DataFrame":
    url = (f"{HAPI_BASE}/data?id={dataset}&parameters={params}"
           f"&time.min={t0.strftime('%Y-%m-%dT%H:%M:%SZ')}"
           f"&time.max={t1.strftime('%Y-%m-%dT%H:%M:%SZ')}&format=csv")
    txt = fetcher.get(url, timeout=180)
    from io import StringIO
    cols = params.split(",")
    df = pd.read_csv(StringIO(txt), header=None, names=["time"] + cols)
    df["time"] = pd.to_datetime(df["time"], utc=True, format="mixed")
    null_fills(df, cols)
    return df


def detect_shock(df: "pd.DataFrame", approx_arrival: datetime,
                 search_h: int = 18) -> "dict | None":
    """Simple shock finder: largest 10-min flow_speed step within
    approx_arrival +/- search_h. Always flag for human confirmation."""
    lo = approx_arrival - timedelta(hours=search_h)
    hi = approx_arrival + timedelta(hours=search_h)
    w = df[(df.time >= lo) & (df.time <= hi)].copy()
    # Require real coverage: a handful of surviving points around a data gap
    # produces a garbage diff, not a shock.
    if w.empty or w["flow_speed"].notna().sum() < 30:
        return None
    w["dv"] = w["flow_speed"].diff(10)  # ~10-min step at 1-min cadence
    if w["dv"].isna().all():
        return None
    i = w["dv"].idxmax()
    if (w.loc[i, "dv"] or 0) < 40:  # <40 km/s jump: weak/no clear shock
        return None
    return {"shock_arrival_utc": w.loc[i, "time"].isoformat(),
            "speed_jump_kms": round(float(w.loc[i, "dv"]), 1),
            "confidence": "auto — CONFIRM MANUALLY"}


def pull_omni_for_event(fetcher, arrival: datetime) -> dict:
    t0 = arrival - timedelta(days=1)
    t1 = arrival + timedelta(days=3)
    out = {}
    try:
        hi = hapi_csv(fetcher, "OMNI_HRO_1MIN",
                      "SYM_H,flow_speed,BZ_GSM,proton_density", t0, t1)
        if hi["SYM_H"].notna().any():
            i_min = hi["SYM_H"].idxmin()
            out["symh_min_nt"] = float(hi.loc[i_min, "SYM_H"])
            out["symh_min_utc"] = hi.loc[i_min, "time"].isoformat()
        for key, col, fn in (("observed_speed_max_kms", "flow_speed", "max"),
                             ("observed_bz_min_nt", "BZ_GSM", "min"),
                             ("observed_density_max", "proton_density", "max")):
            if hi[col].notna().any():
                out[key] = float(getattr(hi[col], fn)())
        out["shock"] = detect_shock(hi, arrival)
    except Exception as e:
        out["omni_1min_error"] = str(e)
    try:
        lo = hapi_csv(fetcher, "OMNI2_H0_MRG1HR", "DST1800,KP1800", t0, t1)
        if lo["DST1800"].notna().any():
            out["dst_min_nt"] = float(lo["DST1800"].min())
        if lo["KP1800"].notna().any():
            out["kp_max"] = float(lo["KP1800"].max()) / 10.0  # stored as Kp*10
    except Exception as e:
        out["omni_hourly_error"] = str(e)
    return out


# ---------------------------------------------------------------------------
# Richardson–Cane ICME list — pulled once, matched per event
# ---------------------------------------------------------------------------
def pull_rc_table(fetcher) -> "pd.DataFrame | None":
    try:
        txt = fetcher.get(RC_LIST_URL, timeout=120)
        tables = pd.read_html(txt)
        rc = max(tables, key=len)  # the ICME table is the big one
        return rc
    except Exception as e:
        print(f"  [warn] Richardson-Cane pull failed ({e}); "
              f"populate rc_catalog_ref manually", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Reconciliation + outputs
# ---------------------------------------------------------------------------
def reconcile(event: dict, truth: dict) -> "list[str]":
    """Compare planning approximations to pulled truth; return discrepancies."""
    issues = []
    omni = truth.get("omni", {})
    if omni.get("symh_min_nt") is not None and event.get("dst_min_nt_approx"):
        planned = float(event["dst_min_nt_approx"])
        got = omni["symh_min_nt"]
        if abs(planned - got) > 30:
            issues.append(f"Dst/SYM-H: planned {planned:.0f}, "
                          f"OMNI SYM-H min {got:.0f} nT (Δ {got - planned:+.0f})")
    shock = omni.get("shock") or {}
    if shock.get("shock_arrival_utc") and event.get("l1_arrival_utc_approx"):
        planned = parse_ts(event["l1_arrival_utc_approx"])
        got = parse_ts(shock["shock_arrival_utc"])
        dh = (got - planned).total_seconds() / 3600
        if abs(dh) > 3:
            issues.append(f"L1 arrival: planned {planned.isoformat()}, "
                          f"detected {got.isoformat()} (Δ {dh:+.1f} h)")
    cme = truth.get("donki", {}).get("cme_analysis") or {}
    if cme.get("speed_kms_3d") and event.get("cme_speed_kms_approx"):
        planned = float(event["cme_speed_kms_approx"])
        got = cme["speed_kms_3d"]
        if abs(planned - got) / max(planned, 1) > 0.25:
            issues.append(f"CME speed: planned {planned:.0f}, "
                          f"DONKI {got:.0f} km/s")
    return issues


def sql_escape(v):
    if v is None or v == "":
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def emit_sql(results: dict, path: Path):
    lines = ["-- Generated by pipelines/cme/step0_pull.py — review before applying.",
             "-- Target schema: supabase-cme-validation-migration.sql", ""]
    for eid, r in results.items():
        cme = (r["truth"].get("donki", {}) or {}).get("cme_analysis") or {}
        omni = r["truth"].get("omni", {})
        shock = omni.get("shock") or {}
        lines.append(
            "INSERT INTO cme_events (event_id, donki_id, launch_time_utc, "
            "source_region, cme_type, speed_kms_3d, half_width_deg, "
            "direction_lat_deg, direction_lon_deg, is_earth_directed, "
            "is_hindcast, characterization_source, notes) VALUES ("
            + ", ".join(sql_escape(x) for x in [
                eid, cme.get("donki_id"),
                cme.get("launch_time_utc") or r["event"]["launch_time_utc_approx"],
                r["event"].get("source_region") or None,
                "halo", cme.get("speed_kms_3d"), cme.get("half_width_deg"),
                cme.get("direction_lat_deg"), cme.get("direction_lon_deg"),
                True, True,
                "DONKI" if cme else "MANUAL",
                "; ".join(r["truth"].get("donki", {}).get("donki_notes", []))
                or None,
            ]) + ") ON CONFLICT (event_id) DO NOTHING;")
        lines.append(
            "INSERT INTO cme_l1_observations (event_id, shock_arrival_utc, "
            "observed_speed_kms, observed_bz_min_nt, observed_density_max, "
            "arrived, source) VALUES ("
            + ", ".join(sql_escape(x) for x in [
                eid, shock.get("shock_arrival_utc"),
                omni.get("observed_speed_max_kms"),
                omni.get("observed_bz_min_nt"),
                omni.get("observed_density_max"), True, "OMNI",
            ]) + ") ON CONFLICT (event_id) DO NOTHING;")
        lines.append(
            "INSERT INTO cme_geomag_observations (event_id, symh_min_nt, "
            "symh_min_utc, dst_min_nt, kp_max, source) VALUES ("
            + ", ".join(sql_escape(x) for x in [
                eid, omni.get("symh_min_nt"), omni.get("symh_min_utc"),
                omni.get("dst_min_nt"), omni.get("kp_max"), "OMNI",
            ]) + ") ON CONFLICT (event_id) DO NOTHING;")
        lines.append("")
    path.write_text("\n".join(lines))


# ---------------------------------------------------------------------------
# Offline self-test — validates DONKI parsing against a captured live response
# ---------------------------------------------------------------------------
DONKI_FIXTURE = [
    {"time21_5": "2016-09-06T14:18Z", "latitude": -20.0, "longitude": 120.0,
     "halfAngle": 31.0, "speed": 674.0, "type": "C", "isMostAccurate": True,
     "associatedCMEID": "2016-09-06T08:54:00-CME-001",
     "associatedCMEstartTime": "2016-09-06T08:54Z", "catalog": "M2M_CATALOG",
     "link": "https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/CMEAnalysis/11233/-1"},
    {"time21_5": "2016-09-15T04:24Z", "latitude": -18.0, "longitude": -122.0,
     "halfAngle": 43.0, "speed": 722.0, "type": "C", "isMostAccurate": True,
     "associatedCMEID": "2016-09-14T23:36:00-CME-001",
     "associatedCMEstartTime": "2016-09-14T23:36Z", "catalog": "M2M_CATALOG",
     "link": "https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/CMEAnalysis/11256/-1"},
    {"time21_5": "2016-09-10T02:00Z", "latitude": 5.0, "longitude": -15.0,
     "halfAngle": 38.0, "speed": 910.0, "type": "C", "isMostAccurate": True,
     "associatedCMEID": "2016-09-09T12:00:00-CME-001",
     "associatedCMEstartTime": "2016-09-09T12:00Z", "catalog": "M2M_CATALOG",
     "link": "test"},
]


def self_test() -> int:
    failures = 0

    # 1. Earth-directed filter: lon=120 and lon=-122 must be rejected
    w0 = parse_ts("2016-09-05T00:00Z")
    w1 = parse_ts("2016-09-16T00:00Z")
    best = pick_cme_analysis(DONKI_FIXTURE, w0, w1)
    if best is None or best["associatedCMEID"] != "2016-09-09T12:00:00-CME-001":
        print("FAIL: pick_cme_analysis should select the |lon|<=60 event")
        failures += 1

    # 2. Window filter: narrow window excludes the Earthward event
    best = pick_cme_analysis(DONKI_FIXTURE,
                             parse_ts("2016-09-14T00:00Z"), w1)
    if best is not None:  # only far-side event in window -> None
        print("FAIL: far-side-only window should yield None")
        failures += 1

    # 3. Timestamp parser round-trips DONKI + CSV formats (incl. date-only)
    for s in ("2016-09-06T08:54Z", "2024-05-08T05:00Z",
              "2003-10-28T11:30:00+00:00", "2000-07-14"):
        try:
            parse_ts(s)
        except ValueError:
            print(f"FAIL: parse_ts({s})")
            failures += 1

    # 4. SQL escaping (booleans must not stringify as Python True/False)
    if (sql_escape("O'Brien") != "'O''Brien'" or sql_escape(None) != "NULL"
            or sql_escape(True) != "TRUE" or sql_escape(1674.0) != "1674.0"):
        print("FAIL: sql_escape")
        failures += 1

    # 5. Per-parameter fill nulling (needs pandas; skipped offline if absent)
    if pd is not None:
        df = pd.DataFrame({
            "SYM_H": [-120.0, 99999.0], "flow_speed": [740.0, 99999.9],
            "BZ_GSM": [-31.0, 9999.99], "proton_density": [42.0, 999.99],
            "DST1800": [-383.0, 99999.0], "KP1800": [90.0, 99.0],
        })
        null_fills(df, list(df.columns))
        if int(df.isna().sum().sum()) != 6 or df["KP1800"].max() != 90.0:
            print("FAIL: null_fills must strip each parameter's own sentinel "
                  "and keep valid extremes (Kp*10 = 90)")
            failures += 1
    else:
        print("skip: null_fills test (pandas not installed)")

    print("self-test: " + ("ALL PASS" if failures == 0 else f"{failures} FAILURES"))
    return failures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", help="phase1_hindcast_events.csv")
    ap.add_argument("--outdir", default="./step0_out")
    ap.add_argument("--only", help="single event_id")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        sys.exit(self_test())
    if not args.events:
        ap.error("--events required (or use --self-test)")

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    fetcher = CachedFetcher(outdir / "raw")

    events = pd.read_csv(args.events).to_dict("records")
    if args.only:
        events = [e for e in events if e["event_id"] == args.only]

    rc_table = pull_rc_table(fetcher)
    if rc_table is not None:
        rc_table.to_csv(outdir / "richardson_cane_snapshot.csv", index=False)

    results, report = {}, ["# Step 0 Discrepancy Report",
                           f"Generated {datetime.now(UTC).isoformat()}", ""]
    for ev in events:
        eid = ev["event_id"]
        print(f"[{eid}] pulling...")
        launch = parse_ts(ev["launch_time_utc_approx"])
        arrival = parse_ts(ev["l1_arrival_utc_approx"])
        truth = {}
        try:
            truth["donki"] = pull_donki_for_event(fetcher, launch, arrival)
        except Exception as e:
            truth["donki"] = {"error": str(e)}
        truth["omni"] = pull_omni_for_event(fetcher, arrival)

        issues = reconcile(ev, truth)
        results[eid] = {"event": ev, "truth": truth, "discrepancies": issues}
        report.append(f"## {eid}")
        report.extend([f"- ⚠️ {i}" for i in issues] or ["- ✓ within tolerance"])
        for n in truth.get("donki", {}).get("donki_notes", []):
            report.append(f"- ℹ️ {n}")
        report.append("")

    (outdir / "truth_pull.json").write_text(json.dumps(results, indent=2, default=str))
    (outdir / "discrepancy_report.md").write_text("\n".join(report))
    emit_sql(results, outdir / "inserts.sql")

    df = pd.DataFrame([r["event"] for r in results.values()])
    for eid, r in results.items():
        omni = r["truth"].get("omni", {})
        ok = (omni.get("symh_min_nt") is not None
              and not r["discrepancies"])
        df.loc[df.event_id == eid, "verified_against_primary"] = ok
        if omni.get("symh_min_nt") is not None:
            df.loc[df.event_id == eid, "dst_min_nt_approx"] = omni["symh_min_nt"]
        donki = (r["truth"].get("donki", {}) or {}).get("cme_analysis") or {}
        if donki.get("donki_id"):
            df.loc[df.event_id == eid, "donki_id"] = donki["donki_id"]
    df.to_csv(outdir / "phase1_hindcast_events_verified.csv", index=False)

    n_flagged = sum(1 for r in results.values() if r["discrepancies"])
    print(f"\nDone. {len(results)} events pulled, {n_flagged} with discrepancies.")
    print(f"Review {outdir}/discrepancy_report.md, confirm shock times, "
          f"then apply {outdir}/inserts.sql")


if __name__ == "__main__":
    main()
