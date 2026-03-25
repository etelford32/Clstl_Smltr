#!/usr/bin/env python3
"""
fix_nav_js.py — removes leftover old nav JS fragments from all HTML files.

Two problems to fix:
 A) Files that have our new _navBurger block FOLLOWED BY a leftover
    dangling old nav JS fragment (innerWidth > 768 + stray }  });)
 B) Files that still have the old (function(){...})() IIFE and are
    missing our new _navBurger block entirely.
"""
import re, os

BASE = os.path.dirname(os.path.abspath(__file__))

NEW_NAV_JS = """\
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

# ── Pattern A: leftover dangling fragment after our new block ─────────────────
# Matches the stray "    document.querySelectorAll...innerWidth > 768..." tail
# including the orphaned closing }  }); that follows it.
LEFTOVER_RE = re.compile(
    r'\n[ \t]*document\.querySelectorAll\([\'"]\.nav-drop-btn[\'"]\)'
    r'\.forEach\((?:function\(btn\)|btn\s*=>)\s*\{.*?'
    r'innerWidth\s*[><=!]+\s*768.*?'   # the tell-tale 768 guard
    r'\}\s*\)\s*;?\s*'                  # closes the forEach
    r'(?:\}\s*\n)?'                     # optional stray }
    r'(?:\}\);\s*\n)?',                 # optional stray });
    re.DOTALL
)

# ── Pattern B: old IIFE nav block (full replacement target) ───────────────────
# Handles both styles:
#   (function() { var burger = getElementById... })();
#   (function(){ ... })()
IIFE_RE = re.compile(
    r'//\s*Nav[^\n]*\n'
    r'\s*\(function\s*\(\)\s*\{.*?'
    r'\}\s*\)\s*\(\s*\)\s*;',
    re.DOTALL
)

FILES = [
    'betelgeuse.html', 'earth.html', 'galactic-map.html', 'index.html',
    'rust.html', 'sirius.html', 'solar-fluid.html', 'space-weather.html',
    'star2d-advanced.html', 'star2d.html', 'star3d.html', 'sun.html',
    'threejs.html', 'vega.html', 'wr102.html', 'black-hole-fluid.html',
    'stellar-wind.html',
]

changed, skipped = [], []

for fname in FILES:
    fpath = os.path.join(BASE, fname)
    if not os.path.exists(fpath):
        skipped.append(fname + ' (missing)'); continue

    html = open(fpath, encoding='utf-8').read()
    orig = html

    # ── Fix A: remove dangling leftover fragment ──────────────────────────────
    if '_navBurger' in html and re.search(r'innerWidth\s*>\s*768', html):
        html = LEFTOVER_RE.sub('\n', html)

    # ── Fix B: replace old IIFE with new nav JS ───────────────────────────────
    if '_navBurger' not in html and IIFE_RE.search(html):
        html = IIFE_RE.sub(NEW_NAV_JS, html)

    if html != orig:
        open(fpath, 'w', encoding='utf-8').write(html)
        changed.append(fname)
    else:
        skipped.append(fname + ' (unchanged)')

print('Changed:', changed)
print('Skipped:', skipped)
