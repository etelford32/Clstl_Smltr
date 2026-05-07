#!/usr/bin/env python3
"""SEO follow-up pass — apply fixes surfaced by scripts/seo_audit.py:

1. Add a visually-hidden <h1> to fullscreen sim pages that lack one,
   so search engines and screen readers have a clear topic anchor.
2. Replace overly long meta descriptions (>165 chars) with concise
   per-page copy tuned for SERP snippets.
3. Trim titles longer than 60 chars (would otherwise truncate in
   results).
4. Backfill canonical + OG + Twitter meta on signup, signin, and
   contact-enterprise.

Idempotent — re-running won't duplicate or compound changes.
"""
from __future__ import annotations
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://parkersphysics.com"
LOGO = f"{SITE}/ParkersPhysics_logo2.jpg"
LOGO_ALT = "Parkers Physics — real-time astrophysics simulations"

SR_ONLY_STYLE = (
    "position:absolute;width:1px;height:1px;padding:0;margin:-1px;"
    "overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0"
)

# slug -> H1 text. We give every fullscreen sim a topic-anchor heading.
H1_FOR: dict[str, str] = {
    "achernar.html": "Achernar — Oblate Be Star Simulator",
    "betelgeuse.html": "Betelgeuse — Red Supergiant Simulator",
    "earth.html": "Earth — Magnetosphere & Atmosphere Simulator",
    "galactic-map.html": "Milky Way Galactic Map",
    "moon.html": "The Moon — Lunar Radiation Environment",
    "sagittarius.html": "Sagittarius A* — Galactic Center Black Hole",
    "satellites.html": "Satellite Tracker",
    "sirius.html": "Sirius A + Sirius B Binary System",
    "solar-fluid.html": "Solar Fluid Dynamics Simulator",
    "star3d.html": "Sirius Planetary System (3D)",
    "stellar-wind.html": "Stellar Wind Simulator",
    "sun.html": "The Sun — G2V Star Simulator",
    "threejs.html": "Solar System Orrery",
    "ton618.html": "TON 618 — Ultramassive Black Hole",
    "vega.html": "Vega — Rapid Rotator",
    "wr102.html": "WR-102 — Wolf-Rayet Star",
}

# slug -> trimmed title (≤60 chars). Only set entries we want to change.
TITLE_OVERRIDES: dict[str, str] = {
    "gravity-lab.html": "Gravity Lab — N-Body Simulator · Parkers Physics",
    "jupiter-system.html": "Jupiter System — Galilean Moons · Parkers Physics",
    "launch-planner.html": "Launch Planner — Range Weather · Parkers Physics",
    "mission-planner.html": "Mission Planner — Trajectory Sim · Parkers Physics",
    "time-machine.html": "Orbital Time Machine — N-Body · Parkers Physics",
    "upper-atmosphere.html": "Upper Atmosphere Simulator · Parkers Physics",
}

# slug -> new description (120–160 chars target). Curated rewrites.
DESC_OVERRIDES: dict[str, str] = {
    "operations.html": (
        "Real-time satellite operations console: fleet drag and decay forecasts, "
        "pairwise conjunction screening, and full data provenance."
    ),
    "upper-atmosphere.html": (
        "Thermosphere and exosphere simulator with live F10.7 and Ap drivers — "
        "density, temperature, and species composition from 80 to 2000 km."
    ),
    "pricing.html": (
        "Plans for students, educators, institutions, and enterprises. Free tier, "
        "per-seat classroom licenses, and live NASA/NOAA-driven simulations."
    ),
    "for-educators.html": (
        "Bring live NASA and NOAA data into your classroom. Per-seat licenses, "
        "lesson plans, and 28+ interactive astrophysics simulations for grades 9–14."
    ),
    "gravity-lab.html": (
        "Browser-based Newtonian N-body sandbox. Build solar systems, binaries, "
        "and chaotic three-body configurations with adaptive integrators."
    ),
    "mission-planner.html": (
        "Design interplanetary trajectories with patched-conic transfers, Lambert "
        "solvers, gravity assists, and porkchop plots. From LEO to the outer planets."
    ),
    "missions.html": (
        "Live tracker for the inner solar system fleet: Parker Solar Probe, JWST, "
        "Mars rovers, lunar landers, and more — real-time positions and telemetry."
    ),
    "launch-planner.html": (
        "Orbital launch go/no-go weather planning with live NOAA wind, lightning, "
        "and cloud-ceiling forecasts for major US ranges."
    ),
    "sagittarius.html": (
        "Visualize Sagittarius A*, the 4.3 million solar mass black hole at the "
        "center of the Milky Way. EHT-informed shadow geometry and S-star orbits."
    ),
    "jupiter-system.html": (
        "Interactive Jupiter system showing Io, Europa, Ganymede, and Callisto in "
        "the 4:2:1 Laplace resonance, with tidal heating and magnetosphere."
    ),
    "ton618.html": (
        "Research-grade visualization of TON 618, a ~66 billion solar mass quasar. "
        "Compare its event horizon to the solar system and Milky Way at scale."
    ),
    "index.html": (
        "Scientifically accurate WebGL astrophysics simulations driven by live NASA "
        "and NOAA data. Sun, Earth, space weather, and 28+ deep-space simulations."
    ),
    "contact-enterprise.html": (
        "Enterprise-tier Parkers Physics for satellite operators, financial-services "
        "teams, and research labs. Custom data pipelines and SLAs."
    ),
}

# Auth-page meta. Keep canonical pointing at the .html so the URLs in the
# sitemap (which use the bare slug) resolve to a single canonical.
AUTH_META: dict[str, tuple[str, str, str]] = {
    "signup.html": (
        f"{SITE}/signup",
        "Sign Up — Parkers Physics",
        "Create a free Parkers Physics account to access live NASA and NOAA-driven astrophysics simulations.",
    ),
    "signin.html": (
        f"{SITE}/signin",
        "Sign In — Parkers Physics",
        "Sign in to Parkers Physics to manage your subscription, classroom seats, and saved simulation locations.",
    ),
    "contact-enterprise.html": (
        f"{SITE}/contact-enterprise.html",
        "Enterprise — Parkers Physics",
        "Enterprise-tier Parkers Physics for satellite operators, financial-services teams, and research labs.",
    ),
}

TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S | re.I)
META_DESC_RE = re.compile(
    r'<meta\s+name=["\']description["\']\s+content="(.*?)"\s*/?>',
    re.I | re.S,
)
BODY_OPEN_RE = re.compile(r"<body\b[^>]*>", re.I)
H1_RE = re.compile(r"<h1\b", re.I)
HEAD_CLOSE_RE = re.compile(r"</head>", re.I)
CANONICAL_RE = re.compile(r'<link\s+rel=["\']canonical["\']', re.I)
META_DESC_TAG_RE = re.compile(r'<meta\s+name=["\']description["\']', re.I)
OG_TYPE_RE = re.compile(r'<meta\s+property=["\']og:type["\']', re.I)
TW_CARD_RE = re.compile(r'<meta\s+name=["\']twitter:card["\']', re.I)

SR_H1_MARKER = "data-seo-h1"  # so we can detect/idempotently replace


def html_escape_attr(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def add_visually_hidden_h1(html: str, text: str) -> tuple[str, bool]:
    if H1_RE.search(html):
        return html, False
    if SR_H1_MARKER in html:
        return html, False
    body_m = BODY_OPEN_RE.search(html)
    if not body_m:
        return html, False
    h1_text = html_escape_attr(text)
    insert = (
        f'\n<h1 {SR_H1_MARKER} style="{SR_ONLY_STYLE}">{h1_text}</h1>\n'
    )
    pos = body_m.end()
    return html[:pos] + insert + html[pos:], True


def replace_description(html: str, new_desc: str) -> tuple[str, bool]:
    m = META_DESC_RE.search(html)
    if not m:
        return html, False
    if m.group(1) == new_desc:
        return html, False
    new_attr = html_escape_attr(new_desc)
    new_tag = f'<meta name="description" content="{new_attr}">'
    return html[:m.start()] + new_tag + html[m.end():], True


def replace_title(html: str, new_title: str) -> tuple[str, bool]:
    m = TITLE_RE.search(html)
    if not m:
        return html, False
    if m.group(1).strip() == new_title:
        return html, False
    return html[:m.start()] + f"<title>{new_title}</title>" + html[m.end():], True


def add_full_meta_block(html: str, canonical: str, title: str, desc: str) -> tuple[str, bool]:
    has_canonical = bool(CANONICAL_RE.search(html))
    has_og = bool(OG_TYPE_RE.search(html))
    has_tw = bool(TW_CARD_RE.search(html))
    has_desc = bool(META_DESC_TAG_RE.search(html))

    if has_canonical and has_og and has_tw and has_desc:
        return html, False

    title_e = html_escape_attr(title)
    desc_e = html_escape_attr(desc)
    img_e = html_escape_attr(LOGO)
    alt_e = html_escape_attr(LOGO_ALT)

    parts: list[str] = []
    if not has_canonical:
        parts.append(f'<link rel="canonical" href="{canonical}">')
    if not has_desc:
        parts.append(f'<meta name="description" content="{desc_e}">')
    if not has_og:
        parts.extend([
            '<meta property="og:type" content="website">',
            '<meta property="og:site_name" content="Parkers Physics">',
            f'<meta property="og:url" content="{canonical}">',
            f'<meta property="og:title" content="{title_e}">',
            f'<meta property="og:description" content="{desc_e}">',
            f'<meta property="og:image" content="{img_e}">',
            f'<meta property="og:image:alt" content="{alt_e}">',
        ])
    if not has_tw:
        parts.extend([
            '<meta name="twitter:card" content="summary_large_image">',
            f'<meta name="twitter:title" content="{title_e}">',
            f'<meta name="twitter:description" content="{desc_e}">',
            f'<meta name="twitter:image" content="{img_e}">',
        ])

    block = "\n" + "\n".join(parts) + "\n"

    title_m = TITLE_RE.search(html)
    if title_m:
        pos = title_m.end()
        return html[:pos] + block + html[pos:], True

    head_m = HEAD_CLOSE_RE.search(html)
    if head_m:
        pos = head_m.start()
        return html[:pos] + block + html[pos:], True
    return html, False


def main() -> None:
    h1_changed: list[str] = []
    title_changed: list[str] = []
    desc_changed: list[str] = []
    auth_changed: list[str] = []

    # 1. H1 injection
    for slug, h1 in H1_FOR.items():
        path = ROOT / slug
        if not path.exists():
            continue
        html = path.read_text(encoding="utf-8")
        html2, changed = add_visually_hidden_h1(html, h1)
        if changed:
            path.write_text(html2, encoding="utf-8")
            h1_changed.append(slug)

    # 2. Title trims
    for slug, title in TITLE_OVERRIDES.items():
        path = ROOT / slug
        if not path.exists():
            continue
        html = path.read_text(encoding="utf-8")
        html2, changed = replace_title(html, title)
        if changed:
            path.write_text(html2, encoding="utf-8")
            title_changed.append(slug)

    # 3. Description rewrites
    for slug, desc in DESC_OVERRIDES.items():
        path = ROOT / slug
        if not path.exists():
            continue
        html = path.read_text(encoding="utf-8")
        html2, changed = replace_description(html, desc)
        if changed:
            path.write_text(html2, encoding="utf-8")
            desc_changed.append(slug)

    # 4. Auth-page meta
    for slug, (canonical, title, desc) in AUTH_META.items():
        path = ROOT / slug
        if not path.exists():
            continue
        html = path.read_text(encoding="utf-8")
        html2, changed = add_full_meta_block(html, canonical, title, desc)
        if changed:
            path.write_text(html2, encoding="utf-8")
            auth_changed.append(slug)

    print("== H1 added ==")
    for s in h1_changed:
        print(f"  + {s}")
    print(f"== Titles trimmed ({len(title_changed)}) ==")
    for s in title_changed:
        print(f"  + {s}")
    print(f"== Descriptions rewritten ({len(desc_changed)}) ==")
    for s in desc_changed:
        print(f"  + {s}")
    print(f"== Auth/contact meta backfill ({len(auth_changed)}) ==")
    for s in auth_changed:
        print(f"  + {s}")


if __name__ == "__main__":
    main()
