#!/usr/bin/env python3
"""
upgrade_nav.py — Nav v3 (final).

Top-level structure (as user requested):
  Home | Galactic Map | Solar System | The Sun | Earth View | Space Weather | Stars ▾ | Simulations ▾

Auth pushed to the FAR RIGHT via .nav-spacer (flex:1) inside .nav-menu.

Dropdowns are rich: icon + title + one-line description for every item.
Stars ▾  → all 7 star pages (with section dividers)
Simulations ▾ → all 3 fluid sims + Rust/WASM
"""

import re, os

BASE = os.path.dirname(os.path.abspath(__file__))

# ─── Canonical nav CSS ───────────────────────────────────────────────────────
NAV_CSS = """\
/* ─── Nav ────────────────────────────────────────────────────── */
nav {
    position:relative; z-index:600;
    height:50px; min-height:50px;
    background:rgba(4,2,16,.93); backdrop-filter:blur(16px);
    border-bottom:1px solid rgba(255,255,255,.07);
    display:flex; align-items:center; padding:0 16px; gap:6px;
}
.nav-brand {
    display:flex; align-items:center; gap:8px;
    font-size:.95rem; font-weight:700; text-decoration:none; white-space:nowrap;
    background:linear-gradient(45deg,#ffd700,#ff8c00);
    -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text;
    margin-right:2px;
}
.nav-logo-img { height:30px; width:auto; border-radius:50%; flex-shrink:0; }
/* nav-menu stretches to fill all remaining space */
.nav-menu { display:flex; align-items:center; gap:4px; flex:1; min-width:0; }
.nav-item {
    padding:5px 10px; background:rgba(255,255,255,.07);
    border:1px solid rgba(255,255,255,.12); border-radius:5px;
    color:#ccc; text-decoration:none; font-size:.8rem; white-space:nowrap;
    transition:background .2s, border-color .2s; flex-shrink:0;
}
.nav-item:hover { background:rgba(255,255,255,.16); border-color:rgba(255,200,0,.4); color:#fff; }
.nav-item.active { background:linear-gradient(45deg,#ff8c00,#ffd700); border-color:#ff8c00; color:#000; font-weight:600; }
.nav-drop { position:relative; flex-shrink:0; }
.nav-drop-btn {
    padding:5px 10px; background:rgba(255,255,255,.07);
    border:1px solid rgba(255,255,255,.12); border-radius:5px;
    color:#ccc; font-size:.8rem; cursor:pointer; font-family:inherit;
    transition:background .2s, border-color .2s; white-space:nowrap;
}
.nav-drop-btn:hover { background:rgba(255,255,255,.16); color:#fff; }
.nav-drop-btn.active { background:linear-gradient(45deg,#ff8c00,#ffd700); border-color:#ff8c00; color:#000; font-weight:600; }
/* Rich dropdown panel */
.nav-drop-menu {
    display:block; position:absolute; top:calc(100% + 5px); left:0;
    background:rgba(5,2,18,.97); backdrop-filter:blur(18px);
    border:1px solid rgba(255,255,255,.11); border-radius:9px;
    padding:6px 0 8px; min-width:268px; z-index:800;
    box-shadow:0 14px 44px rgba(0,0,0,.80);
    opacity:0; visibility:hidden; pointer-events:none;
    transform:translateY(-4px);
    transition:opacity .18s ease, visibility .18s ease, transform .18s ease;
}
.nav-drop:hover .nav-drop-menu, .nav-drop.open .nav-drop-menu {
    opacity:1; visibility:visible; pointer-events:auto; transform:translateY(0);
}
/* Each item in the dropdown */
.nav-drop-link {
    display:flex; align-items:center; gap:11px;
    padding:7px 16px; text-decoration:none; transition:background .15s;
}
.nav-drop-link:hover { background:rgba(255,255,255,.07); }
.nav-drop-link.active .ndl-title { color:#ffd700 !important; font-weight:600; }
.nav-drop-link.active .ndl-icon  { opacity:1; }
.ndl-icon  { font-size:1.05rem; width:20px; text-align:center; flex-shrink:0; opacity:.72; }
.ndl-body  { display:flex; flex-direction:column; gap:1px; }
.ndl-title { color:#c8c8c8; font-size:.82rem; font-weight:500; line-height:1.25; }
.ndl-sub   { color:#484e60; font-size:.70rem; line-height:1.2; }
.nav-drop-link:hover .ndl-title { color:#fff; }
.nav-drop-link:hover .ndl-sub   { color:#7a8090; }
/* Section label inside dropdown */
.nav-drop-section {
    padding:7px 16px 3px; font-size:.63rem; font-weight:700;
    letter-spacing:.09em; color:#3d4255; text-transform:uppercase;
    border-top:1px solid rgba(255,255,255,.06); margin-top:3px;
}
.nav-drop-section:first-child { border-top:none; margin-top:0; padding-top:4px; }
/* Spacer that pushes auth buttons to the far right */
.nav-spacer { flex:1; }
/* Auth */
.nav-auth-sep { width:1px; height:22px; background:rgba(255,255,255,.15); margin:0 3px; flex-shrink:0; }
.nav-login  { background:transparent !important; border-color:rgba(255,255,255,.22) !important; color:#bbb !important; }
.nav-login:hover  { background:rgba(255,255,255,.1) !important; color:#fff !important; border-color:rgba(255,255,255,.4) !important; }
.nav-signup { background:linear-gradient(45deg,#ff8c00,#ffd700) !important; border-color:#ff8c00 !important; color:#000 !important; font-weight:700 !important; letter-spacing:.01em; }
.nav-signup:hover { filter:brightness(1.12) !important; }
/* Burger */
.nav-burger {
    display:none; margin-left:auto;
    background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.14);
    border-radius:5px; color:#fff; padding:5px 10px; font-size:1.1rem;
    cursor:pointer; line-height:1; transition:background .2s;
}
.nav-burger:hover { background:rgba(255,255,255,.18); }
@media (max-width:1024px) {
    .nav-burger { display:block; }
    .nav-menu {
        display:none; flex-direction:column; align-items:stretch;
        position:absolute; top:50px; left:0; right:0;
        background:rgba(3,1,14,.98); backdrop-filter:blur(18px);
        border-bottom:1px solid rgba(255,255,255,.1);
        padding:8px 12px 14px; gap:3px; z-index:700;
        max-height:calc(100vh - 50px); overflow-y:auto;
    }
    .nav-menu.open { display:flex; }
    .nav-item, .nav-drop-btn { padding:11px 14px; font-size:.9rem; }
    .nav-drop-menu {
        position:static; box-shadow:none; border-radius:5px; min-width:0;
        background:rgba(255,255,255,.04); border-color:rgba(255,255,255,.07);
        display:none; opacity:1; visibility:visible; transform:none;
        transition:none; pointer-events:auto; padding:2px 0 6px;
    }
    .nav-drop-link { padding:8px 14px 8px 22px; }
    .ndl-sub { display:none; }
    .nav-drop-section { padding:5px 14px 2px 22px; }
    .nav-drop:hover .nav-drop-menu { display:none !important; }
    .nav-drop.open  .nav-drop-menu { display:block !important; }
    .nav-spacer { display:none; }
    .nav-auth-sep { display:none; }
}"""

# ─── Nav JS ───────────────────────────────────────────────────────────────────
NAV_JS = """\
// ─── Nav ─────────────────────────────────────────────────────────────────────
const _navBurger = document.getElementById('nav-burger');
const _navMenu   = document.getElementById('nav-menu');
if (_navBurger && _navMenu) {
    _navBurger.addEventListener('click', () => {
        const open = _navMenu.classList.toggle('open');
        _navBurger.textContent = open ? '✕' : '☰';
        _navBurger.setAttribute('aria-expanded', open);
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('nav')) {
            _navMenu.classList.remove('open');
            _navBurger.textContent = '☰';
            _navBurger.setAttribute('aria-expanded', 'false');
        }
    });
    document.querySelectorAll('.nav-drop-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            if (window.innerWidth > 1024) return;
            e.stopPropagation();
            const drop    = btn.closest('.nav-drop');
            const opening = !drop.classList.contains('open');
            document.querySelectorAll('.nav-drop').forEach(d => d.classList.remove('open'));
            if (opening) drop.classList.add('open');
        });
    });
}"""

# ─── Helpers ──────────────────────────────────────────────────────────────────
def dlink(href, icon, title, sub, active_key, this_key):
    cls = ' active' if active_key == this_key else ''
    return (f'                <a href="{href}" class="nav-drop-link{cls}">\n'
            f'                    <span class="ndl-icon">{icon}</span>\n'
            f'                    <span class="ndl-body">'
            f'<span class="ndl-title">{title}</span>'
            f'<span class="ndl-sub">{sub}</span>'
            f'</span>\n                </a>')

def section(label):
    return f'                <div class="nav-drop-section">{label}</div>'

def nav_item(href, label, active_key, this_key):
    cls = 'nav-item active' if active_key == this_key else 'nav-item'
    return f'        <a href="{href}" class="{cls}">{label}</a>'

# ─── Nav HTML ─────────────────────────────────────────────────────────────────
def nav_html(page):
    stars_pages = {'sirius','star3d','betelgeuse','wr102','vega','star2d','star2d-adv'}
    sim_pages   = {'solar-fluid','stellar-wind','black-hole','rust'}

    stars_btn = 'nav-drop-btn active' if page in stars_pages else 'nav-drop-btn'
    sim_btn   = 'nav-drop-btn active' if page in sim_pages   else 'nav-drop-btn'
    ak = page

    return f"""\
<nav>
    <a href="index.html" class="nav-brand">
        <img src="ParkerPhaysics_logo1.png" class="nav-logo-img" alt="Parker Physics">
        Parker Physics
    </a>
    <button class="nav-burger" id="nav-burger" aria-label="Menu" aria-expanded="false">☰</button>
    <div class="nav-menu" id="nav-menu">
{nav_item('index.html',         'Home',          ak, 'home')}
{nav_item('space-weather.html', 'Space Weather', ak, 'space-weather')}
{nav_item('galactic-map.html',  'Galactic Map',  ak, 'galactic')}
{nav_item('threejs.html',       'Solar System',  ak, 'solar-system')}
{nav_item('sun.html',           'The Sun',       ak, 'sun')}
{nav_item('earth.html',         'Earth View',    ak, 'earth')}

        <!-- ── Stars dropdown ── -->
        <div class="nav-drop" id="nav-drop-stars">
            <button class="{stars_btn}" aria-haspopup="true">Stars ▾</button>
            <div class="nav-drop-menu">
{section('3D Stellar Systems')}
{dlink('sirius.html',          '✦', 'Sirius A System',    'A1V Blue Star + White Dwarf Binary',      ak, 'sirius')}
{dlink('star3d.html',          '🔵','Sirius Planetary',   'Exoplanetary Orbital Mechanics',           ak, 'star3d')}
{dlink('betelgeuse.html',      '🔴','Betelgeuse',         'Red Supergiant α Ori — Pulsating',        ak, 'betelgeuse')}
{dlink('vega.html',            '⚪','Vega',               'Rapid Rotator A0Vp — Oblateness &amp; Wind', ak, 'vega')}
{dlink('wr102.html',           '💜','WR 102',             'Wolf-Rayet — Hottest Known Star',          ak, 'wr102')}
{section('Stellar Modeling')}
{dlink('star2d.html',          '📐','2D Stellar Modeler', 'Interactive Cross-Section Physics',        ak, 'star2d')}
{dlink('star2d-advanced.html', '🔬','Advanced 2D Solar',  'High-Fidelity 2D Solar Physics Engine',   ak, 'star2d-adv')}
            </div>
        </div>

        <!-- ── Simulations dropdown ── -->
        <div class="nav-drop" id="nav-drop-sims">
            <button class="{sim_btn}" aria-haspopup="true">Simulations ▾</button>
            <div class="nav-drop-menu">
{section('Fluid &amp; Particle Physics')}
{dlink('solar-fluid.html',      '🌊','Solar Fluid Dynamics',  'Navier-Stokes MHD on the Solar Surface',  ak, 'solar-fluid')}
{dlink('stellar-wind.html',     '💨','Stellar Wind',          'Parker Spiral Particle Simulation',        ak, 'stellar-wind')}
{dlink('black-hole-fluid.html', '🕳','Black Hole Accretion',  'WebGL2 Accretion Disk + Gravitational Lensing', ak, 'black-hole')}
{section('Tools')}
{dlink('rust.html',             '⚙', 'Rust / WASM Engine',   'WebAssembly High-Performance Compute',     ak, 'rust')}
            </div>
        </div>

        <!-- Auth pushed to the far right by the spacer -->
        <div class="nav-spacer"></div>
        <div class="nav-auth-sep"></div>
        <a href="#login"  class="nav-item nav-login">Log In</a>
        <a href="#signup" class="nav-item nav-signup">Sign Up</a>
    </div>
</nav>"""

# ─── File list ────────────────────────────────────────────────────────────────
FILES = [
    ('index.html',           'home'),
    ('galactic-map.html',    'galactic'),
    ('threejs.html',         'solar-system'),
    ('sun.html',             'sun'),
    ('earth.html',           'earth'),
    ('space-weather.html',   'space-weather'),
    ('rust.html',            'rust'),
    ('sirius.html',          'sirius'),
    ('star3d.html',          'star3d'),
    ('betelgeuse.html',      'betelgeuse'),
    ('wr102.html',           'wr102'),
    ('vega.html',            'vega'),
    ('star2d.html',          'star2d'),
    ('star2d-advanced.html', 'star2d-adv'),
    ('solar-fluid.html',     'solar-fluid'),
    ('stellar-wind.html',    'stellar-wind'),
    ('black-hole-fluid.html','black-hole'),
]

# ─── Regex helpers ────────────────────────────────────────────────────────────
CSS_BLOCK_RE = re.compile(
    r'/\*\s*[─\-]*\s*Nav\s*[─\-]*.*?\*/'
    r'.*?'
    r'@media\s*\([^)]*max-width[^)]*\)\s*\{'
    r'(?:[^{}]|\{[^{}]*\})*'
    r'\}',
    re.DOTALL | re.IGNORECASE
)

def find_nav_block(html):
    start = html.find('<nav>')
    if start == -1: start = html.find('<nav ')
    if start == -1: return None, None
    depth, i = 0, start
    while i < len(html):
        if   html[i:i+4] == '<nav': depth += 1; i += 4
        elif html[i:i+6] == '</nav>':
            depth -= 1
            if depth == 0: return start, i + 6
            i += 6
        else: i += 1
    return None, None

LEGACY_JS_PATTERNS = [
    re.compile(
        r'(?:(?:const|var)\s+(?:burger|_navBurger)\s*=.*?'
        r'(?:document\.querySelectorAll\([\'"]\.nav-drop-btn[\'"]\).*?\}\s*\}\s*\);?))',
        re.DOTALL
    ),
    re.compile(
        r'(?:document\.getElementById\([\'"](?:burger|nav-burger)[\'"]\)\s*\.addEventListener.*?'
        r'(?:document\.querySelectorAll\([\'"]\.nav-drop-btn[\'"]\).*?\}\s*\}\s*\);?))',
        re.DOTALL
    ),
    re.compile(
        r'if\s*\(_navBurger\s*&&\s*_navMenu\)\s*\{.*?\n\}',
        re.DOTALL
    ),
    re.compile(
        r'//\s*[─=]+\s*Nav[^\n]*\n'
        r'(?:document\.getElementById\([\'"]burger[\'"]\).*?'
        r'(?:document\.querySelectorAll\([\'"]\.nav-drop-btn[\'"]\).*?\}\s*\}\s*\);?))',
        re.DOTALL
    ),
]

def replace_nav_js(html, new_js):
    for pat in LEGACY_JS_PATTERNS:
        m = pat.search(html)
        if m:
            return html[:m.start()] + new_js + html[m.end():]
    return html

# ─── Run ──────────────────────────────────────────────────────────────────────
changed, skipped = [], []

for fname, page_key in FILES:
    fpath = os.path.join(BASE, fname)
    if not os.path.exists(fpath):
        skipped.append(fname + ' (not found)'); continue

    with open(fpath, 'r', encoding='utf-8') as f:
        html = f.read()
    original = html

    m = CSS_BLOCK_RE.search(html)
    if m:
        html = html[:m.start()] + NAV_CSS + html[m.end():]

    ns, ne = find_nav_block(html)
    if ns is not None:
        html = html[:ns] + nav_html(page_key) + html[ne:]
    else:
        skipped.append(fname + ' (no <nav>)'); continue

    html = replace_nav_js(html, NAV_JS)

    if html != original:
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(html)
        changed.append(fname)
    else:
        skipped.append(fname + ' (unchanged)')

print('Changed:', changed)
print('Skipped:', skipped)
