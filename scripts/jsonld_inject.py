#!/usr/bin/env python3
"""Inject JSON-LD structured data into public HTML pages.

- Home (index.html): Organization + WebSite (in @graph).
- Each simulation page: SoftwareApplication.
- pricing.html and for-educators.html: FAQPage.

Insertion point: immediately before </head>. Idempotent: if a <script
type="application/ld+json"> with a matching @id is already present, the
block is replaced rather than duplicated.
"""
from __future__ import annotations
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://parkersphysics.com"
LOGO = f"{SITE}/ParkersPhysics_logo2.jpg"

ORG_ID = f"{SITE}/#org"
WEBSITE_ID = f"{SITE}/#website"

ORG_NODE = {
    "@type": "Organization",
    "@id": ORG_ID,
    "name": "Parkers Physics",
    "alternateName": "Parker Physics App",
    "url": f"{SITE}/",
    "logo": {
        "@type": "ImageObject",
        "url": LOGO,
    },
}

WEBSITE_NODE = {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    "name": "Parkers Physics",
    "url": f"{SITE}/",
    "publisher": {"@id": ORG_ID},
    "inLanguage": "en-US",
}

# slug -> (canonical_url, name, description, application_subcategory)
SIMS: dict[str, tuple[str, str, str, str]] = {
    "earth.html": (
        f"{SITE}/earth.html",
        "Earth View",
        "Interactive 3D Earth simulation with live magnetosphere, solar wind interaction, and real-time satellite positions. Driven by NOAA SWPC and NASA OMNIWeb data.",
        "Geophysics simulation",
    ),
    "sun.html": (
        f"{SITE}/sun.html",
        "The Sun (G2V)",
        "Real-time visualization of the Sun's photosphere, corona, magnetic field, and solar flares. Live SDO and GOES X-ray data with MHD-informed flow fields.",
        "Solar physics simulation",
    ),
    "space-weather.html": (
        f"{SITE}/space-weather.html",
        "Space Weather Dashboard",
        "Live space-weather conditions: solar wind, Kp/Dst indices, X-ray flux, CME alerts, auroral oval, and SEP storms. Sourced from NOAA SWPC, ACE, DSCOVR, and GOES.",
        "Space weather monitoring",
    ),
    "star3d.html": (
        f"{SITE}/star3d.html",
        "Sirius Planetary System (3D)",
        "Three-dimensional simulation of a hypothetical Sirius A planetary system with accurate stellar luminosity, habitable-zone bands, and orbital dynamics.",
        "Exoplanet simulation",
    ),
    "galactic-map.html": (
        f"{SITE}/galactic-map.html",
        "Galactic Map",
        "Interactive Milky Way map with real Gaia DR3 stellar positions, spiral arms, OB associations, and notable deep-sky objects. Pan, zoom, and search 100k+ stars.",
        "Galactic cartography",
    ),
    "launch-planner.html": (
        f"{SITE}/launch-planner",
        "Launch Planner",
        "Orbital launch go/no-go weather planning with live NOAA wind, lightning, and cloud-ceiling forecasts for major US ranges. Built for mission-planning workflows.",
        "Aerospace mission planning",
    ),
    "upper-atmosphere.html": (
        f"{SITE}/upper-atmosphere",
        "Upper Atmosphere Simulator",
        "Interactive thermosphere and exosphere model with live F10.7 and Ap drivers. Visualize density, temperature, and satellite drag from 100 km to 1000 km.",
        "Aeronomy simulation",
    ),
    "operations.html": (
        f"{SITE}/operations",
        "Operations Console",
        "Fleet and debris operations console with live TLE-driven satellite tracking, conjunction screening, and reentry risk visualization. Powered by SGP4 in WebAssembly.",
        "Space operations simulator",
    ),
    "missions.html": (
        f"{SITE}/missions",
        "Active Space Missions",
        "Live tracker for the inner solar system fleet: Parker Solar Probe, JWST, Mars rovers, lunar landers, and more. Real-time positions and mission telemetry.",
        "Mission tracker",
    ),
    "vega.html": (
        f"{SITE}/vega",
        "Vega — Rapid Rotator",
        "Three-dimensional model of Vega (Alpha Lyrae), an A0V rapid rotator with gravity darkening, oblateness, and a debris disk. Based on CHARA interferometry.",
        "Stellar astrophysics simulation",
    ),
    "wr102.html": (
        f"{SITE}/wr102",
        "WR-102 — Wolf-Rayet Star",
        "Visualize WR-102, one of the hottest known Wolf-Rayet stars, with its dense radiation-driven wind, ionization structure, and impending core-collapse fate.",
        "Stellar astrophysics simulation",
    ),
    "betelgeuse.html": (
        f"{SITE}/betelgeuse.html",
        "Betelgeuse — Red Supergiant",
        "Interactive simulation of Betelgeuse, an evolved red supergiant in Orion. Convection cells, mass loss, dimming events, and supernova-progenitor physics.",
        "Stellar astrophysics simulation",
    ),
    "sirius.html": (
        f"{SITE}/sirius.html",
        "Sirius A + Sirius B",
        "Binary system simulation of Sirius A (A1V) and its white-dwarf companion Sirius B. Mass transfer history, orbital mechanics, and X-ray emission.",
        "Stellar astrophysics simulation",
    ),
    "stellar-wind.html": (
        f"{SITE}/stellar-wind.html",
        "Stellar Wind Simulator",
        "Hydrodynamic stellar-wind simulator across spectral types. Compare mass-loss rates, terminal velocities, and wind-driven bubbles for OB, WR, and red giants.",
        "Stellar astrophysics simulation",
    ),
    "star2d.html": (
        f"{SITE}/star2d.html",
        "2D Stellar Modeler",
        "Two-dimensional stellar-structure modeler with adjustable mass, metallicity, and age. Live HR-diagram tracking and core/envelope visualization.",
        "Stellar structure simulation",
    ),
    "star2d-advanced.html": (
        f"{SITE}/star2d-advanced.html",
        "Advanced 2D Solar Physics",
        "Advanced solar interior simulator: convection zones, differential rotation, dynamo cycles, and meridional flow. Built for upper-division astrophysics courses.",
        "Solar physics simulation",
    ),
    "black-hole-fluid.html": (
        f"{SITE}/black-hole-fluid.html",
        "Black Hole Accretion",
        "Pseudo-Newtonian accretion-disk simulator with relativistic ISCO, Doppler beaming, and gravitational redshift visualization. Tune mass, spin, and accretion rate.",
        "High-energy astrophysics simulation",
    ),
    "solar-fluid.html": (
        f"{SITE}/solar-fluid.html",
        "Solar Fluid Dynamics",
        "Magnetohydrodynamic visualization of the solar atmosphere: granulation, Alfvén waves, prominence eruptions, and reconnection-driven flares.",
        "Solar physics simulation",
    ),
    "gravity-lab.html": (
        f"{SITE}/gravity-lab.html",
        "Gravity Lab — N-Body Sandbox",
        "Browser-based Newtonian N-body sandbox with adaptive integrators. Build solar systems, binaries, and chaotic three-body configurations in real time.",
        "Celestial mechanics simulation",
    ),
    "time-machine.html": (
        f"{SITE}/time-machine.html",
        "Orbital Time Machine",
        "Propagate the solar system millions of years into the past or future with a high-precision N-body integrator. Watch resonances, secular trends, and chaos.",
        "Celestial mechanics simulation",
    ),
    "mission-planner.html": (
        f"{SITE}/mission-planner.html",
        "Mission Planner — Patched-Conic Trajectory Simulator",
        "Design interplanetary trajectories with patched-conic transfers, Lambert solvers, gravity assists, and porkchop plots. From LEO to Pluto and beyond.",
        "Astrodynamics tool",
    ),
    "jupiter-system.html": (
        f"{SITE}/jupiter-system.html",
        "Jovian System — Galilean Moons",
        "Interactive Jupiter system showing Io, Europa, Ganymede, and Callisto in the 4:2:1 Laplace resonance. Tidal heating, magnetosphere, and ring visualization.",
        "Planetary science simulation",
    ),
    "moon.html": (
        f"{SITE}/moon.html",
        "The Moon — Lunar Radiation Environment",
        "Lunar surface simulator with live galactic-cosmic-ray and solar-particle-event flux. Plan EVA exposure for Artemis-class missions.",
        "Planetary science simulation",
    ),
    "ton618.html": (
        f"{SITE}/ton618.html",
        "TON 618 — Ultramassive Black Hole",
        "Research-grade visualization of TON 618, a ~66 billion solar mass quasar. Compare its event horizon to the solar system and Milky Way at scale.",
        "High-energy astrophysics simulation",
    ),
    "achernar.html": (
        f"{SITE}/achernar.html",
        "Achernar — Oblate Be Star",
        "Three-dimensional model of Achernar (Alpha Eridani), the most-oblate known star. Rapid rotation, gravity darkening, and a transient decretion disk.",
        "Stellar astrophysics simulation",
    ),
    "sagittarius.html": (
        f"{SITE}/sagittarius.html",
        "Sagittarius A* — Galactic Center Black Hole",
        "Visualize Sagittarius A*, the 4.3 million solar mass black hole at the center of the Milky Way. EHT-informed shadow geometry and S-star orbits.",
        "High-energy astrophysics simulation",
    ),
    "satellites.html": (
        f"{SITE}/satellites.html",
        "Satellite Tracker",
        "Real-time tracker for 25,000+ satellites and debris objects using SGP4 propagation in WebAssembly. Search, filter, and visualize orbital regimes.",
        "Space situational awareness",
    ),
    "threejs.html": (
        f"{SITE}/threejs.html",
        "Solar System Orrery",
        "Interactive 3D solar-system orrery with the Sun, eight planets, dwarf planets, major moons, and the asteroid belt. Keplerian orbits driven by NASA JPL ephemerides.",
        "Planetary science simulation",
    ),
}

PRICING_FAQ: list[tuple[str, str]] = [
    (
        "Do I need a credit card for the free trial?",
        "No — the free tier is completely free with no credit card required. You'll get instant access to our core simulations right after creating your account.",
    ),
    (
        "Can I switch plans at any time?",
        "Yes. You can upgrade or downgrade your plan at any time from your account dashboard. Upgrades take effect immediately; downgrades apply at the next billing cycle.",
    ),
    (
        "What is the SWMF pipeline in the Advanced plan?",
        "SWMF (Space Weather Modeling Framework) is a physics-based magnetosphere simulation tool used by NASA and NOAA researchers. Advanced members can run and retrieve magnetosphere model outputs driven by live solar wind data from the L1 Lagrange point.",
    ),
    (
        "What's the difference between Educator and Institution?",
        "Educator is for a single teacher, professor, or homeschool parent who wants to license up to 30 student seats — billed monthly with a \"Powered by Parkers Physics\" attribution badge on embedded simulations. Institution is for a whole university department, planetarium, or science center: 200 seats, full white-label / custom branding, SSO, and SLA-backed support. Above 200 seats or with custom data needs, talk to us about Enterprise.",
    ),
    (
        "Can I embed simulations on my school's website or LMS?",
        "Yes, on the Educator, Institution, and Enterprise tiers. Educator embeds carry the \"Powered by Parkers Physics\" attribution badge (a licensing condition); Institution and Enterprise can white-label.",
    ),
    (
        "When should I contact Enterprise sales?",
        "If you're a satellite operator, financial-services team, or research lab that needs anomaly correlation, GNSS scintillation forecasting, launch-window briefings, custom data ingestion, or contractual SLAs — that's Enterprise. Pricing is bespoke and starts above the Institution tier.",
    ),
    (
        "Is there an academic or institutional discount?",
        "Educator ($25/mo for 30 seats) and Institution ($500/mo for 200 seats) are themselves the academic-discounted tiers. For larger organizations or seat counts above 200, contact Enterprise sales.",
    ),
    (
        "How does billing work?",
        "All self-serve plans are billed monthly via Stripe. You'll receive a receipt by email after each payment. There are no setup fees or long-term contracts. Institution and Enterprise can also be billed annually by invoice — contact us.",
    ),
    (
        "What simulations are in the free tier?",
        "The free tier includes the Sun simulation, Earth atmospheric view, basic Space Weather dashboard with live solar wind speed, and the 2D Stellar Modeler. Upgrading to Basic unlocks all 17 interactive simulations.",
    ),
    (
        "Can I add seats above my plan's cap?",
        "Educator includes 30 seats and Institution includes 200. If you need more, the cleanest path is to move up a tier (Educator → Institution → Enterprise). For one-off overage, email billing@parkersphysics.com — we'll quote per-seat overage that's added to your next renewal invoice.",
    ),
    (
        "What's the difference between cancel and downgrade?",
        "Cancel ends the subscription at the end of the current billing period — you keep full access until then, and your account drops to Free after. Downgrade switches you to a lower paid tier immediately at the start of the next cycle (proration handled by Stripe). Both are self-serve from your dashboard.",
    ),
    (
        "Do you handle sales tax / VAT?",
        "Yes. US sales tax and EU/UK VAT are calculated and collected automatically by Stripe Tax at checkout based on your billing address. Tax-exempt institutions: send your exemption certificate to billing@parkersphysics.com and we'll zero out the tax line on your invoice.",
    ),
    (
        "Do you accept purchase orders or invoice billing?",
        "Yes — for Institution and Enterprise. We can issue a quarterly or annual invoice with NET-30 terms and accept ACH, wire, or PO. Self-serve tiers (Free → Advanced) are credit-card / Stripe only.",
    ),
    (
        "What happens to embedded simulations if my subscription ends?",
        "Embedded simulations check your subscription status on each load. When an Educator or Institution subscription ends, the embed shows a small upgrade prompt instead of the simulation. Embeds keep working through the rest of the paid period and stop at period end, not the moment you click Cancel.",
    ),
]

EDUCATORS_FAQ: list[tuple[str, str]] = [
    (
        "Do students need to pay anything?",
        "No. Students sign up free under your subscription. They don't need a credit card and can't be charged. Their access ends when you remove them or cancel the subscription.",
    ),
    (
        "What grade level is this?",
        "Grades 9–12 and undergraduate physics most directly. The simulations have both a \"show me the cool thing\" surface and an \"explain the math\" panel underneath, so they scale up to upper-division and down to middle-school demonstrations.",
    ),
    (
        "Does it work on Chromebooks, iPads, or phones?",
        "Yes. The simulations are WebGL — no install, no plugin. We test on Chromebooks (the most common school device) every release.",
    ),
    (
        "Can I exceed 30 seats?",
        "Yes — the Institution plan ($500/mo) gives you 200 seats, custom branding, and priority support. If you need more than 200, the Enterprise tier negotiates per-contract.",
    ),
    (
        "What happens at the end of the school year?",
        "Cancel from the dashboard's billing portal. You keep access through the end of the current paid period. Students retain their accounts but lose the inherited plan — they fall back to the free tier with reduced features.",
    ),
    (
        "Can I see lesson plans or activity ideas?",
        "Yes — once enrolled, the dashboard surfaces an \"Activities\" panel with grade-banded prompts that map to NGSS HS-ESS1 (stars), HS-ESS2 (Earth's systems), and HS-PS2 (forces). We add new ones every few weeks based on instructor feedback.",
    ),
    (
        "Is the data really live?",
        "Yes. We pull from NASA SWPC, NOAA, NWS, USGS, MET Norway, NASA Earth Observatory, and CelesTrak (TLEs). The pipeline status page (linked in nav) shows real-time freshness.",
    ),
    (
        "What about privacy?",
        "We store the student's email, display name, and (optionally) their saved location. No analytics scripts, no advertising IDs. Detailed policy on the privacy page; the EULA covers classroom use.",
    ),
]


def faq_node(faq_id: str, items: list[tuple[str, str]]) -> dict:
    return {
        "@type": "FAQPage",
        "@id": faq_id,
        "mainEntity": [
            {
                "@type": "Question",
                "name": q,
                "acceptedAnswer": {"@type": "Answer", "text": a},
            }
            for q, a in items
        ],
    }


def software_node(canonical_url: str, name: str, description: str, subcat: str) -> dict:
    return {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "@id": f"{canonical_url}#app",
        "name": name,
        "description": description,
        "url": canonical_url,
        "image": LOGO,
        "applicationCategory": "EducationalApplication",
        "applicationSubCategory": subcat,
        "operatingSystem": "Web Browser",
        "browserRequirements": "Requires JavaScript and WebGL",
        "isAccessibleForFree": True,
        "publisher": {"@id": ORG_ID},
        "inLanguage": "en-US",
    }


def serialize(node: dict) -> str:
    body = json.dumps(node, ensure_ascii=False, indent=2)
    return f'<script type="application/ld+json">\n{body}\n</script>'


# Match an existing JSON-LD script that contains the given @id (we
# serialize as JSON, so the literal substring `"@id": "<id>"` appears).
def find_existing_block(html: str, id_value: str) -> tuple[int, int] | None:
    pattern = re.compile(
        r'<script\s+type=["\']application/ld\+json["\']\s*>(.*?)</script>',
        re.IGNORECASE | re.DOTALL,
    )
    needle = f'"@id": "{id_value}"'
    for m in pattern.finditer(html):
        if needle in m.group(1):
            return (m.start(), m.end())
    return None


def upsert(html: str, node: dict, anchor_id: str) -> str:
    block = serialize(node)
    existing = find_existing_block(html, anchor_id)
    if existing:
        s, e = existing
        return html[:s] + block + html[e:]
    head_close = re.search(r"</head>", html, re.IGNORECASE)
    if not head_close:
        return html
    insert_at = head_close.start()
    prefix = html[:insert_at]
    if not prefix.endswith("\n"):
        prefix += "\n"
    return prefix + block + "\n" + html[insert_at:]


def process_home(path: Path) -> bool:
    html = path.read_text(encoding="utf-8")
    graph_node = {
        "@context": "https://schema.org",
        "@graph": [ORG_NODE, WEBSITE_NODE],
    }
    new_html = upsert(html, graph_node, ORG_ID)
    if new_html == html:
        return False
    path.write_text(new_html, encoding="utf-8")
    return True


def process_sim(path: Path, canonical_url: str, name: str, desc: str, subcat: str) -> bool:
    html = path.read_text(encoding="utf-8")
    node = software_node(canonical_url, name, desc, subcat)
    new_html = upsert(html, node, node["@id"])
    if new_html == html:
        return False
    path.write_text(new_html, encoding="utf-8")
    return True


def process_faq(path: Path, faq_id: str, items: list[tuple[str, str]]) -> bool:
    html = path.read_text(encoding="utf-8")
    node = {"@context": "https://schema.org", **faq_node(faq_id, items)}
    new_html = upsert(html, node, faq_id)
    if new_html == html:
        return False
    path.write_text(new_html, encoding="utf-8")
    return True


def main() -> None:
    home = ROOT / "index.html"
    if process_home(home):
        print("  + index.html (Organization + WebSite)")

    for slug, (canonical_url, name, desc, subcat) in SIMS.items():
        path = ROOT / slug
        if not path.exists():
            print(f"  ! missing: {slug}")
            continue
        if process_sim(path, canonical_url, name, desc, subcat):
            print(f"  + {slug} (SoftwareApplication)")

    pricing = ROOT / "pricing.html"
    if process_faq(pricing, f"{SITE}/pricing#faq", PRICING_FAQ):
        print("  + pricing.html (FAQPage)")

    educators = ROOT / "for-educators.html"
    if process_faq(educators, f"{SITE}/for-educators#faq", EDUCATORS_FAQ):
        print("  + for-educators.html (FAQPage)")


if __name__ == "__main__":
    main()
