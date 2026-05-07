#!/usr/bin/env python3
"""Inject canonical + OG + Twitter meta tags into public HTML pages.

Idempotent: if a tag already exists for a given property, it is left alone.
Run from the repo root: python3 scripts/seo_inject.py
"""
from __future__ import annotations
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://parkersphysics.com"
DEFAULT_OG_IMAGE = f"{SITE}/ParkersPhysics_logo2.jpg"
DEFAULT_OG_ALT = "Parkers Physics — real-time astrophysics simulations"

# slug -> (canonical_path, og_title, description)
PAGES: dict[str, tuple[str, str, str]] = {
    "index.html": (
        "/",
        "Parkers Physics — Real-time Astrophysics Simulations",
        "Scientifically accurate, WebGL-powered astrophysics simulations driven by live NASA and NOAA data. Explore the Sun, Earth's magnetosphere, space weather, and deep space.",
    ),
    "pricing.html": (
        "/pricing",
        "Pricing — Parkers Physics",
        "Plans for students, educators, institutions, and enterprises. Free tier available. Per-seat pricing for classrooms with live NASA/NOAA data simulations.",
    ),
    "for-educators.html": (
        "/for-educators",
        "For Educators — Parkers Physics",
        "Bring live NASA and NOAA data into your classroom. Per-seat licenses, lesson plans, and 28+ interactive astrophysics simulations for grades 9–14 and undergraduate physics.",
    ),
    "earth.html": (
        "/earth.html",
        "Earth View — Parkers Physics",
        "Interactive 3D Earth simulation with live magnetosphere, solar wind interaction, and real-time satellite positions. Driven by NOAA SWPC and NASA OMNIWeb data.",
    ),
    "sun.html": (
        "/sun.html",
        "The Sun (G2V) — Parkers Physics",
        "Real-time visualization of the Sun's photosphere, corona, magnetic field, and solar flares. Live SDO and GOES X-ray data with MHD-informed flow fields.",
    ),
    "space-weather.html": (
        "/space-weather.html",
        "Space Weather Dashboard — Parkers Physics",
        "Live space-weather conditions: solar wind, Kp/Dst indices, X-ray flux, CME alerts, auroral oval, and SEP storms. Sourced from NOAA SWPC, ACE, DSCOVR, and GOES.",
    ),
    "star3d.html": (
        "/star3d.html",
        "Sirius Planetary System (3D) — Parkers Physics",
        "Three-dimensional simulation of a hypothetical Sirius A planetary system with accurate stellar luminosity, habitable-zone bands, and orbital dynamics.",
    ),
    "galactic-map.html": (
        "/galactic-map.html",
        "Galactic Map — Parkers Physics",
        "Interactive Milky Way map with real Gaia DR3 stellar positions, spiral arms, OB associations, and notable deep-sky objects. Pan, zoom, and search 100k+ stars.",
    ),
    "launch-planner.html": (
        "/launch-planner",
        "Launch Planner — Parkers Physics",
        "Orbital launch go/no-go weather planning with live NOAA wind, lightning, and cloud-ceiling forecasts for major US ranges. Built for mission-planning workflows.",
    ),
    "upper-atmosphere.html": (
        "/upper-atmosphere",
        "Upper Atmosphere Simulator — Parkers Physics",
        "Interactive thermosphere and exosphere model with live F10.7 and Ap drivers. Visualize density, temperature, and satellite drag from 100 km to 1000 km.",
    ),
    "operations.html": (
        "/operations",
        "Operations Console — Parkers Physics",
        "Fleet and debris operations console with live TLE-driven satellite tracking, conjunction screening, and reentry risk visualization. Powered by SGP4 in WebAssembly.",
    ),
    "missions.html": (
        "/missions",
        "Active Space Missions — Parkers Physics",
        "Live tracker for the inner solar system fleet: Parker Solar Probe, JWST, Mars rovers, lunar landers, and more. Real-time positions and mission telemetry.",
    ),
    "vega.html": (
        "/vega",
        "Vega — Rapid Rotator — Parkers Physics",
        "Three-dimensional model of Vega (Alpha Lyrae), an A0V rapid rotator with gravity darkening, oblateness, and a debris disk. Based on CHARA interferometry.",
    ),
    "wr102.html": (
        "/wr102",
        "WR-102 — Wolf-Rayet Star — Parkers Physics",
        "Visualize WR-102, one of the hottest known Wolf-Rayet stars, with its dense radiation-driven wind, ionization structure, and impending core-collapse fate.",
    ),
    "betelgeuse.html": (
        "/betelgeuse.html",
        "Betelgeuse — Red Supergiant — Parkers Physics",
        "Interactive simulation of Betelgeuse, an evolved red supergiant in Orion. Convection cells, mass loss, dimming events, and supernova-progenitor physics.",
    ),
    "sirius.html": (
        "/sirius.html",
        "Sirius A + Sirius B — Parkers Physics",
        "Binary system simulation of Sirius A (A1V) and its white-dwarf companion Sirius B. Mass transfer history, orbital mechanics, and X-ray emission.",
    ),
    "stellar-wind.html": (
        "/stellar-wind.html",
        "Stellar Wind Simulator — Parkers Physics",
        "Hydrodynamic stellar-wind simulator across spectral types. Compare mass-loss rates, terminal velocities, and wind-driven bubbles for OB, WR, and red giants.",
    ),
    "star2d.html": (
        "/star2d.html",
        "2D Stellar Modeler — Parkers Physics",
        "Two-dimensional stellar-structure modeler with adjustable mass, metallicity, and age. Live HR-diagram tracking and core/envelope visualization.",
    ),
    "star2d-advanced.html": (
        "/star2d-advanced.html",
        "Advanced 2D Solar Physics — Parkers Physics",
        "Advanced solar interior simulator: convection zones, differential rotation, dynamo cycles, and meridional flow. Built for upper-division astrophysics courses.",
    ),
    "black-hole-fluid.html": (
        "/black-hole-fluid.html",
        "Black Hole Accretion — Parkers Physics",
        "Pseudo-Newtonian accretion-disk simulator with relativistic ISCO, Doppler beaming, and gravitational redshift visualization. Tune mass, spin, and accretion rate.",
    ),
    "solar-fluid.html": (
        "/solar-fluid.html",
        "Solar Fluid Dynamics — Parkers Physics",
        "Magnetohydrodynamic visualization of the solar atmosphere: granulation, Alfvén waves, prominence eruptions, and reconnection-driven flares.",
    ),
    "gravity-lab.html": (
        "/gravity-lab.html",
        "Gravity Lab — N-Body Sandbox — Parkers Physics",
        "Browser-based Newtonian N-body sandbox with adaptive integrators. Build solar systems, binaries, and chaotic three-body configurations in real time.",
    ),
    "time-machine.html": (
        "/time-machine.html",
        "Orbital Time Machine — Parkers Physics",
        "Propagate the solar system millions of years into the past or future with a high-precision N-body integrator. Watch resonances, secular trends, and chaos.",
    ),
    "mission-planner.html": (
        "/mission-planner.html",
        "Mission Planner — Patched-Conic Trajectory Simulator — Parkers Physics",
        "Design interplanetary trajectories with patched-conic transfers, Lambert solvers, gravity assists, and porkchop plots. From LEO to Pluto and beyond.",
    ),
    "jupiter-system.html": (
        "/jupiter-system.html",
        "Jovian System — Galilean Moons — Parkers Physics",
        "Interactive Jupiter system showing Io, Europa, Ganymede, and Callisto in the 4:2:1 Laplace resonance. Tidal heating, magnetosphere, and ring visualization.",
    ),
    "moon.html": (
        "/moon.html",
        "The Moon — Lunar Radiation Environment — Parkers Physics",
        "Lunar surface simulator with live galactic-cosmic-ray and solar-particle-event flux. Plan EVA exposure for Artemis-class missions.",
    ),
    "ton618.html": (
        "/ton618.html",
        "TON 618 — Ultramassive Black Hole — Parkers Physics",
        "Research-grade visualization of TON 618, a ~66 billion solar mass quasar. Compare its event horizon to the solar system and Milky Way at scale.",
    ),
    "achernar.html": (
        "/achernar.html",
        "Achernar — Oblate Be Star — Parkers Physics",
        "Three-dimensional model of Achernar (Alpha Eridani), the most-oblate known star. Rapid rotation, gravity darkening, and a transient decretion disk.",
    ),
    "sagittarius.html": (
        "/sagittarius.html",
        "Sagittarius A* — Galactic Center Black Hole — Parkers Physics",
        "Visualize Sagittarius A*, the 4.3 million solar mass black hole at the center of the Milky Way. EHT-informed shadow geometry and S-star orbits.",
    ),
    "satellites.html": (
        "/satellites.html",
        "Satellite Tracker — Parkers Physics",
        "Real-time tracker for 25,000+ satellites and debris objects using SGP4 propagation in WebAssembly. Search, filter, and visualize orbital regimes.",
    ),
}

CANONICAL_RE = re.compile(r'<link\s+rel=["\']canonical["\']', re.IGNORECASE)
TITLE_RE = re.compile(r"(<title>[^<]*</title>)", re.IGNORECASE)
META_DESC_RE = re.compile(r'<meta\s+name=["\']description["\']', re.IGNORECASE)
OG_PROP_RE = re.compile(r'<meta\s+property=["\'](og:[a-z_:]+)["\']', re.IGNORECASE)
TW_PROP_RE = re.compile(r'<meta\s+name=["\'](twitter:[a-z_:]+)["\']', re.IGNORECASE)


def html_escape_attr(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def build_block(canonical: str, og_title: str, description: str) -> str:
    canonical_url = f"{SITE}{canonical}"
    title_e = html_escape_attr(og_title)
    desc_e = html_escape_attr(description)
    img_e = html_escape_attr(DEFAULT_OG_IMAGE)
    alt_e = html_escape_attr(DEFAULT_OG_ALT)
    site_name = "Parkers Physics"
    return (
        "\n"
        f'<link rel="canonical" href="{canonical_url}">\n'
        f'<meta name="description" content="{desc_e}">\n'
        f'<meta property="og:type" content="website">\n'
        f'<meta property="og:site_name" content="{site_name}">\n'
        f'<meta property="og:url" content="{canonical_url}">\n'
        f'<meta property="og:title" content="{title_e}">\n'
        f'<meta property="og:description" content="{desc_e}">\n'
        f'<meta property="og:image" content="{img_e}">\n'
        f'<meta property="og:image:alt" content="{alt_e}">\n'
        f'<meta name="twitter:card" content="summary_large_image">\n'
        f'<meta name="twitter:title" content="{title_e}">\n'
        f'<meta name="twitter:description" content="{desc_e}">\n'
        f'<meta name="twitter:image" content="{img_e}">\n'
    )


def existing_props(html: str) -> tuple[set[str], set[str], bool, bool]:
    og = {m.group(1).lower() for m in OG_PROP_RE.finditer(html)}
    tw = {m.group(1).lower() for m in TW_PROP_RE.finditer(html)}
    has_canonical = bool(CANONICAL_RE.search(html))
    has_desc = bool(META_DESC_RE.search(html))
    return og, tw, has_canonical, has_desc


def build_partial_block(
    canonical: str,
    og_title: str,
    description: str,
    og_have: set[str],
    tw_have: set[str],
    has_canonical: bool,
    has_desc: bool,
) -> str:
    canonical_url = f"{SITE}{canonical}"
    title_e = html_escape_attr(og_title)
    desc_e = html_escape_attr(description)
    img_e = html_escape_attr(DEFAULT_OG_IMAGE)
    alt_e = html_escape_attr(DEFAULT_OG_ALT)
    site_name = "Parkers Physics"

    lines: list[str] = []
    if not has_canonical:
        lines.append(f'<link rel="canonical" href="{canonical_url}">')
    if not has_desc:
        lines.append(f'<meta name="description" content="{desc_e}">')
    og_targets = [
        ("og:type", "website"),
        ("og:site_name", site_name),
        ("og:url", canonical_url),
        ("og:title", og_title),
        ("og:description", description),
        ("og:image", DEFAULT_OG_IMAGE),
        ("og:image:alt", DEFAULT_OG_ALT),
    ]
    for prop, val in og_targets:
        if prop not in og_have:
            v = html_escape_attr(val)
            lines.append(f'<meta property="{prop}" content="{v}">')
    tw_targets = [
        ("twitter:card", "summary_large_image"),
        ("twitter:title", og_title),
        ("twitter:description", description),
        ("twitter:image", DEFAULT_OG_IMAGE),
    ]
    for prop, val in tw_targets:
        if prop not in tw_have:
            v = html_escape_attr(val)
            lines.append(f'<meta name="{prop}" content="{v}">')

    if not lines:
        return ""
    return "\n" + "\n".join(lines) + "\n"


def process(path: Path, canonical: str, og_title: str, description: str) -> bool:
    html = path.read_text(encoding="utf-8")
    og_have, tw_have, has_canonical, has_desc = existing_props(html)
    block = build_partial_block(
        canonical, og_title, description, og_have, tw_have, has_canonical, has_desc
    )
    if not block:
        return False
    m = TITLE_RE.search(html)
    if not m:
        print(f"  ! no <title> in {path.name}, skipping")
        return False
    insert_at = m.end()
    new_html = html[:insert_at] + block + html[insert_at:]
    path.write_text(new_html, encoding="utf-8")
    return True


def main() -> None:
    changed = 0
    skipped = 0
    for slug, (canonical, og_title, desc) in PAGES.items():
        path = ROOT / slug
        if not path.exists():
            print(f"  ! missing: {slug}")
            continue
        if process(path, canonical, og_title, desc):
            print(f"  + {slug}")
            changed += 1
        else:
            print(f"  = {slug} (already complete)")
            skipped += 1
    print(f"\nUpdated {changed} files, {skipped} already complete.")


if __name__ == "__main__":
    main()
