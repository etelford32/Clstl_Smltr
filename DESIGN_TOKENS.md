# Earth UI — Design Tokens Reference

This is the source of truth for the Earth simulation page's visual
design system. Every token listed here lives at `:root` (or under a
contextual override) in `earth.html`. Tweak a token there and every
consumer updates in lockstep — the whole reason the system exists.

> **Stay inside the system.** Reaching for a raw `#hex` or `rgba()`
> value when a token already exists is the slow drift that turned the
> codebase into a paint-shop in the first place. If a token doesn't
> cover what you need, **add a new token** rather than patching one
> rule with a literal — see "Adding a token" at the bottom.

---

## Quick navigation

- [Color — accent families](#color--accent-families)
- [Color — status palette](#color--status-palette)
- [Color — surface fills](#color--surface-fills)
- [Color — text scale](#color--text-scale)
- [Color — borders](#color--borders)
- [Spacing rhythm](#spacing-rhythm)
- [Border radii](#border-radii)
- [Surface effects](#surface-effects)
- [Transitions](#transitions)
- [Override blocks (mobile + light theme)](#override-blocks)
- [Adding a token](#adding-a-token)
- [Conventions and gotchas](#conventions-and-gotchas)

---

## Color — accent families

Three accent tracks, one per major UI region. Each ships **both** a
hex value and an RGB triplet — modern browsers can't substitute a hex
token into `rgba()`, so consumers that need transparency embed the
triplet:

```css
border: 1px solid rgba(var(--c-accent-rgb), .22);
```

### Cyan — primary chrome accent (`--c-accent*`)

The visual signature of the Earth page. Used by every weather /
atmosphere / info panel border and scrollbar, the layer panel
header, the toggle pill `:checked` state, and most chrome buttons.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--c-accent` | `#00c6ff` | `#0085b0` | Headings, link colour, chrome accents that read as solid text |
| `--c-accent-rgb` | `0, 200, 255` | `0, 133, 176` | Triplet for `rgba()` calls |
| `--c-accent-soft` | `rgba(.., .15)` | `rgba(.., .12)` | Hover backgrounds, badge fills |
| `--c-accent-border` | `rgba(.., .22)` | `rgba(.., .25)` | Default panel border |
| `--c-accent-border-hi` | `rgba(.., .30)` | `rgba(.., .40)` | Stronger border for active / focused state |
| `--c-accent-glow` | `rgba(.., .55)` | `rgba(.., .55)` | Outer glow ring on focused / "live" elements |
| `--c-accent-bg-overlay` | `rgba(.., .10)` | `rgba(.., .06)` | Subtle radial gradient overlay on panels |

### Amber — Storm Watch / cyclone accent (`--c-storm*`)

Owned by the Storm Watch panel, the cyclone forecast cones, the
forecast-time scrubber, and any "active weather warning" affordance.
Distinct from the cyan chrome so a hurricane doesn't look like an
informational hint.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--c-storm` | `#ffb066` | `#d96a1a` | Storm Watch heading, badge text |
| `--c-storm-rgb` | `255, 160, 80` | `217, 106, 26` | Triplet for `rgba()` |
| `--c-storm-soft` | `rgba(.., .12)` | `rgba(.., .12)` | Card-hover background |
| `--c-storm-border` | `rgba(.., .28)` | `rgba(.., .35)` | Default panel border |
| `--c-storm-border-hi` | `rgba(.., .55)` | `rgba(.., .55)` | Active card border |
| `--c-storm-glow` | `rgba(.., .55)` | `rgba(.., .40)` | Pulse ring on the live-feed dot |
| `--c-storm-bg-overlay` | `rgba(.., .10)` | `rgba(.., .06)` | Panel backdrop tint |

### Teal-mint — location/sun accent (`--c-loc*`)

Used only by the location panel hero — it's the visitor's first-
contact affordance ("set your location") and gets the loudest visual
treatment in the family. Restricted to one consumer on purpose; if
you find yourself reaching for `--c-loc` outside `#loc-panel`, you
probably want `--c-accent`.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--c-loc` | `#5fffd0` | `#00926a` | Hero heading, hint banner |
| `--c-loc-rgb` | `95, 255, 208` | `0, 146, 106` | Triplet for `rgba()` |
| `--c-loc-soft` | `rgba(.., .18)` | `rgba(.., .14)` | Top-left radial gradient on the panel |
| `--c-loc-border` | `rgba(.., .45)` | `rgba(.., .45)` | Panel outline + glow ring |

---

## Color — status palette

Single source of truth for every layer-status pip across the page —
the `.lyr-status` dots in the layer panel, the NASA-obs row dots,
the Storm Watch live-pulse, and the aurora forecast freshness chip.
**Do not flip these in the light theme** — the green=live, red=error
convention is universal and re-mapping it just adds confusion.

| Token | Both themes | Meaning |
|---|---|---|
| `--c-status-live` | `#4fc97f` | Feed is producing fresh data |
| `--c-status-live-glow` | `rgba(79, 201, 127, .55)` | Pulse ring around a live dot |
| `--c-status-fetching` | `#ffaa22` | Request in flight (amber pulse) |
| `--c-status-fetch-glow` | `rgba(255, 170, 34, .60)` | Pulse during fetch |
| `--c-status-error` | `#ff4422` | Last fetch failed |
| `--c-status-error-glow` | `rgba(255, 68, 34, .65)` | Pulse on errored row |
| `--c-status-idle` | `#556` | Layer never polled (toggle off) |

---

## Color — surface fills

The frosted-glass panel backgrounds. Layered radial-gradient overlays
(usually one of the `--c-*-bg-overlay` tokens) on top of these give
each panel its characteristic hue without diverging the underlying
value scale.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--c-surface-1` | `rgba(6, 10, 22, .86)` | `rgba(248, 250, 254, .94)` | Top stop in the panel's linear-gradient backing |
| `--c-surface-2` | `rgba(2, 4, 12, .92)` | `rgba(232, 238, 248, .96)` | Bottom stop — slight value shift gives the card depth |

---

## Color — text scale

Five-tier hierarchy from headline to faint metadata. The skill-grid
keeps a slightly different mid-grey (`--c-text-skill`) so a refactor
doesn't accidentally flatten the visual difference between "this is
a number you should read" and "this is chrome around the number."

| Token | Dark | Light | Use |
|---|---|---|---|
| `--c-text-primary` | `#d6dee6` | `#1a2735` | Card titles, primary readouts |
| `--c-text-secondary` | `#b0c8d8` | `#2c3a4a` | Layer labels, body copy |
| `--c-text-muted` | `#7a98a8` | `#5a6a7a` | Descriptors, captions |
| `--c-text-faint` | `#557` | `#8898a8` | Metadata, "ago" timestamps |
| `--c-text-skill` | `#88b` | `#4a5a7a` | Skill-grid cells — distinct from chrome |

---

## Color — borders

Three weights for separators and outlines. **Light theme uses higher
alpha** because dark separators on white have to be visibly darker
than white separators on black to read at the same perceived weight.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--c-border-faint` | `rgba(255, 255, 255, .06)` | `rgba(10, 30, 50, .08)` | Section separators inside a panel |
| `--c-border-soft` | `rgba(255, 255, 255, .10)` | `rgba(10, 30, 50, .14)` | Button outlines, scrollbar tracks |
| `--c-border-medium` | `rgba(255, 255, 255, .14)` | `rgba(10, 30, 50, .20)` | Featured-card outlines |

---

## Spacing rhythm

Every panel padding, gap, and row spacing pulls from one 2 px-base
scale. **Mixing in arbitrary px values was the historical reason the
layout looked subtly inconsistent across panels** — that's gone.

| Token | Desktop | Phone (≤640 px) | Use |
|---|---|---|---|
| `--sp-1` | `2px` | `2px` | Hairline gap (rare; usually you want `--sp-2`) |
| `--sp-2` | `4px` | `3px` | Inter-item gap inside a button row |
| `--sp-3` | `6px` | `5px` | Sub-row spacing inside a card |
| `--sp-4` | `8px` | `7px` | Standard card-internal padding |
| `--sp-5` | `10px` | `8px` | Panel inner padding (vertical) |
| `--sp-6` | `12px` | `10px` | Panel inner padding (horizontal) |
| `--sp-7` | `14px` | `12px` | Panel section gaps |
| `--sp-8` | `16px` | `14px` | Hero-panel padding |

The mobile compression is automatic — no per-rule media queries
needed. Any rule that wants to opt OUT of mobile compression spells
its padding in raw px (rare, and visible to reviewers).

---

## Border radii

Predictable hierarchy: smaller affordances get smaller radii, hero
panels get the loudest curve.

| Token | Desktop | Phone | Use |
|---|---|---|---|
| `--r-sm` | `4px` | `4px` | Badges, buttons, chips |
| `--r-md` | `6px` | `6px` | Sub-cards inside a panel |
| `--r-lg` | `9px` | `9px` | Legacy panel default — rare in new code |
| `--r-xl` | `10px` | `8px` | **Current panel default** |
| `--r-2xl` | `14px` | `12px` | Loc-panel hero only |

---

## Surface effects

| Token | Dark / Desktop | Phone | Light | Use |
|---|---|---|---|---|
| `--blur-glass` | `blur(12px) saturate(1.15)` | `blur(8px) saturate(1.10)` | (inherits) | Backdrop filter on every panel |
| `--shadow-panel` | `0 4px 22px rgba(0,16,40,.55)` | `0 2px 14px rgba(0,16,40,.50)` | `0 4px 22px rgba(20,40,80,.14)` | Drop shadow under panels |

`--blur-glass` is the **most expensive** line in the panel render
budget. Phones drop it to `blur(8px)` because the small viewport
hides the difference between 8 and 12 — and the GPU thanks you.

The light theme tints `--shadow-panel` toward navy instead of the
dark theme's near-black so it doesn't look soot-grey on a near-white
surface.

---

## Transitions

| Token | Value | Use |
|---|---|---|
| `--t-fast` | `.12s ease` | Button-press feedback (`transform: scale(.92)`), chip activation |
| `--t-snap` | `.15s ease` | Hover state changes, focus ring fade, status-pip recolour |
| `--t-medium` | `.25s ease` | Panel body collapse, toggle pill knob slide |

Avoid using raw `transition: ...` durations elsewhere — the three
tokens above cover every animation in the design system. If you need
a fourth (e.g. `--t-slow` for a 1 s reveal), add it to `:root` rather
than inlining a duration.

---

## Override blocks

### `@media (max-width: 640px)`
Applies the **mobile** column shown in the spacing / radii / effects
tables above. Re-declares only the tokens whose values change on
phones; everything else inherits the desktop default. Located right
after the main `:root` block in `earth.html`.

### `:root.theme-light, body.theme-light`
Applies the **light** column shown in the colour tables above.
Activated by:

- `?theme=light` URL param (one-shot designer preview)
- `localStorage.setItem('pp.theme', 'light')` (saved preference)
- `prefers-color-scheme: light` OS-level toggle (when no user pref)
- Runtime: `window.setEarthTheme('light' | 'dark' | 'auto')`
- **UI: tap the 🌞/🌙 button at top-right** (long-press → 'auto')

Some rules can't be expressed by re-declaring a single token —
multi-stop gradients, layered shadows, decorative effects.  Those
land in a **rule-override section** under
`html.theme-light <selector>, body.theme-light <selector>` directly
below the token block. See e.g. `#loc-panel` hero shadow stops or
the `.lyr` pill `:checked` gradient.

---

## Adding a token

1. **Decide if you actually need a new token.**  Most additions are
   really an existing token plus a different alpha. Look for the
   `--c-*-soft / -border / -border-hi / -glow` pattern first — those
   already span the typical alpha range.
2. If you need a true new colour family, add it under the relevant
   block in `:root` with the same shape as `--c-accent*`:
   ```css
   --c-newfamily:           #...;
   --c-newfamily-rgb:       R, G, B;
   --c-newfamily-soft:      rgba(R, G, B, .12);
   --c-newfamily-border:    rgba(R, G, B, .25);
   --c-newfamily-glow:      rgba(R, G, B, .55);
   ```
3. Add the matching light-theme override under `body.theme-light` —
   even if the dark and light values are the same, a comment saying
   "stays put" prevents a future contributor wondering whether you
   forgot.
4. **Add a row to this doc.** A token without a documented intent
   becomes a mystery in six months.

---

## Conventions and gotchas

- **`var()` doesn't work in SVG presentation attributes.** A
  `<polyline stroke="rgba(var(--c-accent-rgb), .7)">` won't render —
  SVG strokes are processed before the CSS cascade resolves the
  variable. Use `style="stroke: rgba(var(--c-accent-rgb), .7)"`
  instead so the cascade fires.
- **Inline HTML `style="..."`** *does* support `var()`. So does the
  injected stylesheet inside `js/storm-watch-panel.js` — custom
  properties cascade through dynamic `<style>` nodes natively.
- **Canvas drawing context** doesn't process variables. `ctx.strokeStyle = 'var(--c-accent)'` won't work.
  Read the variable explicitly: `getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim()`.
- **Multi-stop gradients** that mix more than one token-family colour
  (e.g. cyan → purple) usually can't be tokenised cleanly. Add a
  rule-override under `body.theme-light` instead of carrying the
  gradient inline.
- **Status colours stay put across themes.** The green-live / red-
  error convention is universal; remapping it would just add
  confusion. The light-theme block deliberately omits redefining the
  status palette.
- **Three accent families is enough.** If you find yourself wanting a
  fourth (purple? orange?), first ask whether the new region really
  needs its own colour story or whether it's "just another panel" in
  the cyan family. Adding a fourth track means tuning it for both
  themes plus all alpha variants — nontrivial cost.

---

## Source location

All tokens live in `earth.html`:

| Block | Approximate lines |
|---|---|
| `:root { ... }` (dark/desktop defaults) | 33 – 121 |
| `@media (max-width: 640px) { :root { ... } }` (mobile overrides) | 138 – 164 |
| `:root.theme-light, body.theme-light { ... }` (light theme) | 193 – 248 |
| Rule-level light-theme overrides | 263 onward |
| Theme activation hook (inline `<script>`) | ~1747 |
| 🌞/🌙 toggle button HTML + wiring | ~2026 |

Keep the doc in sync when those blocks move.
