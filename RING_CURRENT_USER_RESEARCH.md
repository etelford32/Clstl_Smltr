# Ring Current / Atmospheric Analyzer — user research & leads (2026-07)

What actual users say they want from space-weather / atmospheric-drag
services, with sources, and how each finding maps to product features.
Companion to RING_CURRENT_SIMULATION_PLAN.md.

---

## 1. What users are asking for (evidence)

### Satellite operators / conjunction assessment (the B2G wedge)

- **Neutral density is the #1 pain.** Storm-driven neutral-density change is
  "the largest orbital perturbation for LEO satellites and the largest source
  of prediction error"; operators surveyed want near-term density forecast
  improvements. No consensus on cadence/thresholds, but agreement on
  **3-day forecasts for conjunction screening** and up to **7 days for
  collision avoidance**; **5-year solar-cycle outlooks** for mission design.
  (Survey of operations-ready thermospheric density models, J. Astronautical
  Sciences 2025; AMOS 2023.)
- **Index forecasts failed when it mattered.** For the May 2024 Gannon G5,
  "the magnitude and duration of the storm were poorly predicted [in ap]
  even one day in advance"; ~**5,000 satellites maneuvered en masse in one
  day** after the storm (baseline ~300/day), stressing conjunction
  infrastructure. (Parker & Linares, Satellite Drag Analysis During the May
  2024 Gannon Geomagnetic Storm, AIAA JSR / arXiv:2406.08617; SpaceNews
  "mass migrations".)
- **Uncertainty quantification is explicitly wanted.** Forecast uncertainty
  propagates directly into conjunction probability-of-collision; operators
  need bands, not point forecasts. (Parker, "Influences of Space Weather
  Forecasting Uncertainty on Satellite Conjunction Assessment", Space
  Weather 2024, doi:10.1029/2023SW003818.)
- **First National Survey of User Needs for Space Weather (SWAG, 2024)** —
  five sectors (electric power, satellites, GNSS, aviation, emergency
  management). Satellite operators' ideal: **2–3 weeks notice of extreme
  events** (unachievable physically — which argues for showing *measured
  skill at the horizons that ARE physical*: our L1 lead), plus recurring
  themes of **forecast specificity** and **accessible data**.
  (weather.gov/media/nws/Results-of-the-First-National-Survey-of-User-Needs-for-Space-Weather-2024.pdf)

### Consumer / aurora side (top of funnel)

- Most-requested: **predictive alerts 30–90 min ahead** (not after onset),
  for exact locations; multi-factor "will I actually see it" scoring; ~"80%
  within 3 h" Kp accuracy is the ceiling users currently accept.
  (auroraforecast.me 7-app comparison 2026; app-store reviews.)
  → Our ballistic L1 window IS 30–60 min of genuine lead. Same physics
  serves both segments.

## 2. Leads (specific, current)

| Lead | Why | Entry point |
|------|-----|-------------|
| **NOAA Office of Space Commerce — TraCSS** | Building civil space-traffic coordination; explicitly funding data-assimilative thermosphere density; issued a **BAA for white papers (Mar 2025, rolling)** for SSA/STC R&D | space.commerce.gov → "Office of Space Commerce Solicits White Papers"; TraCSS roadmap page |
| **MIT ARCLab (W. Parker, R. Linares)** | Authors of the Gannon drag + uncertainty papers; run community density/drag challenges; validation partners & credibility | arXiv:2406.08617 corresponding authors |
| **SWAG / SWORM survey pipeline** | The national user-needs survey will iterate; formal channel to register as a service provider responding to documented needs | spaceweather.gov/news → survey report |
| **Conjunction-assessment providers** (LeoLabs, COMSPOC, Slingshot) | Consume density/uncertainty as input; the Gannon papers cite their screening volumes | AMOS conference circuit |
| **SBIR** | X/SF-series topics recur on thermosphere density nowcasting (award #207792 cites TraCSS support) | sbir.gov, filter "thermospheric density" |

## 3. Research → feature map (what we build, in order)

| Finding | Feature | Status |
|---------|---------|--------|
| Uncertainty wanted for conjunction work | **Parameter-ensemble band** on the Dst forecast (O'Brien–McPherron a, τ perturbed ±25%; labeled as parameter spread) | this branch |
| Index forecasts miss storms; alerts wanted 30–90 min ahead | **Threshold-crossing alert**: "model crosses −50 nT in ≈N min" from the L1-driven forecast | this branch |
| Density is the #1 operator need | **Storm density impact panel**: site's own thermosphere engine (`js/upper-atmosphere-engine.js` density()) driven by live Kp→ap + F10.7, storm/quiet ratio at 300/400/550/800 km | this branch |
| Skill must be shown, not claimed (2–3 wk notice impossible) | **Gannon G5 replay**: run the same model over May 2024 OMNI drivers vs SYM-H, on the page, with skill numbers | this branch |
| 3–7 day forecasts for screening | Couple `ring_current_log` + `geomag_indices` skill ledger into a published verification page; extend drivers with 27-day recurrence | ledger panel landed 2026-07-11 (`/api/ring-current/skill` + "Independent validation" panel); 27-day recurrence later |
| TraCSS / BAA | White paper: L1-driven ring-current→density chain with continuously-measured skill | later (business) |

## Sources

- https://link.springer.com/article/10.1007/s40295-025-00558-8
- https://arxiv.org/abs/2406.08617
- https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2023SW003818
- https://www.weather.gov/media/nws/Results-of-the-First-National-Survey-of-User-Needs-for-Space-Weather-2024.pdf
- https://www.spaceweather.gov/news/results-first-national-survey-user-needs-space-weather
- https://spacenews.com/geomagnetic-storms-cause-mass-migrations-of-satellites/
- https://space.commerce.gov/office-of-space-commerce-solicits-white-papers-for-ssa-stc-research/
- https://space.commerce.gov/traffic-coordination-system-for-space-tracss/
- https://eos.org/editor-highlights/space-traffic-management-better-space-weather-forecasts-needed
- https://auroraforecast.me/guides/best-aurora-app
