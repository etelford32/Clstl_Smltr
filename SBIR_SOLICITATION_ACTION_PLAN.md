# SBIR solicitation action plan — SpaceWERX + NSF tracks

*Compiled 2026-07-12 from live web research. Companion draft: `NSF_PROJECT_PITCH_DRAFT.md`.*

Context: the SBIR/STTR reauthorization (S.3971, signed 2026-04-13) restarted
agency cycles after a five-month lapse. Two tracks are actionable right now
for the LEO drag forecasting wedge.

---

## Deadline board

| Date | What | Track |
|---|---|---|
| **Now → Jul 21** | DAF/SpaceWERX 26.2 pre-release: topic-author Q&A window | SpaceWERX |
| **Jul 21–23** | AFWERX/SpaceWERX Innovate Tech Forum, Huntsville AL | SpaceWERX |
| **Jul 22** | DAF 26.2 Specific Topic submissions OPEN (via DSIP) | SpaceWERX |
| **Jul 27** | NSF full-proposal deadline #1 (only if pitch already invited) | NSF |
| **Aug 18** | DAF 26.2 Specific Topic submissions CLOSE | SpaceWERX |
| **Nov 4** | NSF full-proposal deadline #2 — **our realistic target** | NSF |
| Mar 4, 2027 | NSF full-proposal deadline #3 (invite stays valid) | NSF |
| TBD (short notice) | NASA BAA Appendix C — space weather subtopic (PROSWIFT-aligned) | watch |
| ~Nov 2026–Feb 2027 | NOAA FY2026 NOFO expected | watch |

---

## Blocking prerequisites (both tracks — start immediately)

These registrations gate *everything* and the slowest takes weeks:

1. **Legal entity check** — confirm the small business entity that will
   propose (legal name, EIN, incorporation). *(Owner: Eric — [FILL IN])*
2. **SAM.gov registration → UEI** — required for NSF and DoD. Processing
   is commonly 2–4+ weeks. If not already registered, this is the single
   most time-sensitive item on this page.
3. **SBA Company Registry** (sbir.gov) → SBC control ID. Quick, but needs
   the entity details.
4. **DSIP account** (dodsbirsttr.mil) + firm registration — required to
   ask topic-author questions during pre-release and to submit to DAF 26.2.
5. **Research.gov account** — required for the NSF full proposal (not for
   the Project Pitch itself, which goes through the seedfund.nsf.gov portal).

---

## Track A — SpaceWERX / DAF 26.2 (opens Jul 22, closes Aug 18)

### Step 1 (now → Jul 21): topic fit
- Log into DSIP → browse the 26.2 pre-released topic list. Search terms:
  *space weather, thermosphere, atmospheric density, drag, conjunction,
  space domain awareness, orbit determination, SSA*.
- Note: sandboxed sessions can't reach dodsbirsttr.mil — this needs a
  human login. Capture topic numbers + titles back into this doc.
- For each candidate topic, submit questions to the topic author through
  DSIP **during pre-release** (Q&A typically shuts before open date).
  Questions worth asking:
  - Is a physics-based (MHD-driven) storm-time neutral density forecast
    in scope, vs. empirical-index approaches?
  - Is hindcast validation against accelerometer-derived density
    (GRACE-FO) an acceptable Phase I feasibility demonstration?
  - Who is the intended end user (Delta 2 / SSC / 557th Weather Wing)?
- Decision gate: if a Specific Topic fits, propose to it (pre-identified
  customer, no memo needed). If not, fall back to **Open Topic Phase I**
  ($75K–$180K, out-of-cycle) — no customer memo required at Phase I;
  the memo is only needed for Open Topic Direct-to-Phase-II.

### Step 2 (Jul 21–23): Innovate Tech Forum, Huntsville
- Topic authors and USSF customers attend. If travel is feasible, this is
  the highest-leverage 3 days of the cycle. Target conversations:
  - **USSF Delta 2** (space domain awareness) — drag mis-forecasts are
    their conjunction-screening pain.
  - **SSC Space Sensing** — owns next-gen space weather sensing/exploitation.
  - **557th Weather Wing** — operational space weather support.
- Goal: a named government POC willing to be the customer for a future
  D2P2 memo, and validation of which topic to bid.

### Step 3 (Jul 22 → Aug 18): proposal
- Anchor narrative: **Feb 2022 Starlink loss (38 satellites) as failure of
  empirical density models; MHD-grounded forecast as the fix; Gannon
  May 2024 G5 hindcast as validation.** This matches the repo's existing
  proof-point framing (see `MHD_DENSITY_PHASE0_RUNBOOK.md`,
  `GANNON_SIMULATION_DESIGN.md`).
- Reuse the NSF pitch draft's technical sections as the seed.
- Submit early in DSIP — the portal historically jams near close.

---

## Track B — NSF SBIR Project Pitch (submit ASAP, target Nov 4 full proposal)

### Mechanics (per NSF 26-510)
- Pitch is submitted via the seedfund.nsf.gov Project Pitch portal;
  program staff respond by email (historically ~3 weeks) with an
  invite/decline.
- An invite is valid for the **next two** full-proposal deadlines — so a
  pitch submitted in July that's invited in August covers Nov 4, 2026
  *and* Mar 4, 2027. No downside to submitting now.
- Limits: max 2 pitches per company per 12 months; max 3 lifetime per
  technology. Don't burn one on a rushed draft — but the draft in
  `NSF_PROJECT_PITCH_DRAFT.md` is close; it needs Eric's review and the
  company/team facts filled in.
- Phase I is up to $305K / 6–18 months (confirm exact figure in NSF 26-510
  before submitting). NSF wants *unproven, high-risk R&D*, not
  incremental engineering — the pitch is framed accordingly.

### Steps
1. Fill the `[FILL IN]` blocks in `NSF_PROJECT_PITCH_DRAFT.md`
   (entity, PI status, team, any revenue/funding history).
2. Eric reviews technical claims — every number in the draft must be
   defensible from the hindcast harness outputs.
3. Submit at seedfund.nsf.gov. Record submission date + pitch ID here.
4. On invite: build the full proposal against the Nov 4 deadline
   (research.gov, ~15-page project description — separate work plan).

### NSF caution
The NSF reviewer lens is *commercialization + deep-tech risk*, not
mission fit. The B2G/SBIR pivot story (satellite operators + government)
is the right market narrative; do NOT frame it as a consumer SaaS.

---

## Watch items (no action this week)

- **NASA BAA Appendix C** — the BAA (valid through Sep 2027) has a space
  weather R2O subtopic. Appendices drop with short lead times; the PY2026
  Information Hub newsletter is the alert channel. Subscribe.
- **NOAA FY2026 NOFO** — once-per-year NOFO via techpartnerships.noaa.gov
  + grants.gov, expected Nov–Feb. NOAA SWPC is the most natural customer;
  when it opens it likely deserves priority over everything else.

## Status log

| Date | Event |
|---|---|
| 2026-07-12 | Plan created; NSF pitch drafted; awaiting entity/registration facts |
