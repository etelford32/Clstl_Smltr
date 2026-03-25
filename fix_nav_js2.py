#!/usr/bin/env python3
"""
fix_nav_js2.py — replaces the entire broken nav JS section in every HTML file
with the canonical, correct nav JS block.

The previous fix_nav_js.py's LEFTOVER_RE accidentally ate the querySelectorAll
drop handler from our new nav JS (greedy cross-match between the two
querySelectorAll occurrences). This script does a clean full replacement.
"""
import re, os

BASE = os.path.dirname(os.path.abspath(__file__))

CANONICAL_JS = """// ─── Nav ─────────────────────────────────────────────────────────────────────
const _navBurger = document.getElementById('nav-burger');
const _navMenu   = document.getElementById('nav-menu');
if (_navBurger && _navMenu) {
    _navBurger.addEventListener('click', () => {
        const open = _navMenu.classList.toggle('open');
        _navBurger.textContent = open ? '\\u2715' : '\\u2630';
        _navBurger.setAttribute('aria-expanded', open);
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('nav')) {
            _navMenu.classList.remove('open');
            _navBurger.textContent = '\\u2630';
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

# Match from the first nav comment (// ─── Nav or // ── NAV) through the
# closing } of if(_navBurger) block, plus any stray }); or }); that follow.
NAV_JS_RE = re.compile(
    r'(?://\s*[─\-]+\s*NAV[^\n]*\n)?'       # optional "// ── NAV burger" line
    r'(?://\s*[─\-]+\s*Nav[^\n]*\n)+'        # one or more "// ─── Nav" lines
    r'const _navBurger\s*=.*?'               # const _navBurger = ...
    r'if\s*\(_navBurger\s*&&\s*_navMenu\)\s*\{.*?\n\}'  # if block
    r'(?:\s*\n\}\);?)?'                      # optional stray }); or })
    r'(?:\s*\n\}\);?)?',                     # optional second stray });
    re.DOTALL
)

FILES = [
    'betelgeuse.html', 'black-hole-fluid.html', 'earth.html',
    'galactic-map.html', 'index.html', 'rust.html', 'sirius.html',
    'solar-fluid.html', 'space-weather.html', 'star2d-advanced.html',
    'star2d.html', 'star3d.html', 'stellar-wind.html', 'sun.html',
    'threejs.html', 'vega.html', 'wr102.html',
]

changed, skipped = [], []
for fname in FILES:
    fpath = os.path.join(BASE, fname)
    if not os.path.exists(fpath):
        skipped.append(fname + ' (missing)'); continue

    html = open(fpath, encoding='utf-8').read()
    orig = html

    m = NAV_JS_RE.search(html)
    if m:
        html = html[:m.start()] + CANONICAL_JS + html[m.end():]
        if html != orig:
            open(fpath, 'w', encoding='utf-8').write(html)
            changed.append(fname)
        else:
            skipped.append(fname + ' (no change)')
    else:
        skipped.append(fname + ' (pattern not found)')

print('Changed:', changed)
print('Skipped:', skipped)
