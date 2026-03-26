#!/usr/bin/env python3
"""Add consistent cv-btn strip and ⚡ Space Weather icon to all sim pages."""

import re, sys, os

BASE = os.path.dirname(os.path.abspath(__file__))

# ─── Helpers ──────────────────────────────────────────────────────────────────

def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()

def write(path, content):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"  ✓ {os.path.basename(path)}")

def insert_after(html, anchor, insertion, unique=True):
    """Insert text after the first occurrence of anchor."""
    idx = html.find(anchor)
    if idx == -1:
        raise ValueError(f"Anchor not found: {anchor!r}")
    pos = idx + len(anchor)
    return html[:pos] + insertion + html[pos:]

def insert_before(html, anchor, insertion):
    idx = html.find(anchor)
    if idx == -1:
        raise ValueError(f"Anchor not found: {anchor!r}")
    return html[:idx] + insertion + html[idx:]

def already_has(html, marker):
    return marker in html

# ─── Common CSS for pages without cv-btn ──────────────────────────────────────

CV_BTN_CSS_COMMON = """
/* ─── Floating control buttons ──────────────────────────────────── */
.cv-btn {
    position: absolute; z-index: 60;
    background: rgba(4,2,0,.80); backdrop-filter: blur(8px);
    border: 1px solid rgba(255,160,0,.30); border-radius: 7px;
    color: #ffb830; cursor: pointer; font-family: inherit;
    font-size: 12px; padding: 6px 11px; transition: all .2s;
    touch-action: manipulation; text-decoration: none; display: inline-block;
}
.cv-btn:hover { background: rgba(255,140,0,.20); border-color:#ff8c00; }
"""

# ─── Space Weather button HTML ─────────────────────────────────────────────────

def sw_btn(right_px):
    return f'<a href="space-weather.html" class="cv-btn" id="btn-sw" title="Live Space Weather Data" style="top:12px;right:{right_px}px;">⚡ Weather</a>'

def sw_btn_bottom(right_px=12):
    return f'<a href="space-weather.html" class="cv-btn" id="btn-sw" title="Live Space Weather Data" style="bottom:16px;right:{right_px}px;">⚡ Weather</a>'

# ─── Per-page edits ────────────────────────────────────────────────────────────

def patch_sun(html):
    """sun.html – already has cv-btn strip. Add ⚡ Weather at right:215px."""
    if already_has(html, 'id="btn-sw"'):
        return html
    # Add CSS after SDO btn CSS
    html = html.replace(
        '#btn-sdo { top:12px; right:115px; }',
        '#btn-sdo { top:12px; right:115px; }\n#btn-sw  { top:12px; right:215px; }'
    )
    # Add button after btn-sdo in HTML
    html = insert_after(html,
        '<button class="cv-btn" id="btn-sdo" title="Live SDO imagery">🔭 SDO Live</button>',
        '\n        <a href="space-weather.html" class="cv-btn" id="btn-sw" title="Live Space Weather Data">⚡ Weather</a>'
    )
    return html


def patch_page_with_controls(html, filename, css_hover_color=None):
    """Pages that have ☰ Controls at right:12px (no SDO) – add ⚡ Weather at right:105px."""
    if already_has(html, 'id="btn-sw"'):
        return html
    # Add CSS: #btn-sw after #btn-center
    html = re.sub(
        r'(#btn-center\s*\{\s*bottom:[^}]+\})',
        r'\1\n#btn-sw      { top:12px; right:105px; }',
        html, count=1
    )
    # Add HTML button after btn-panel-open
    html = re.sub(
        r'(<button class="cv-btn" id="btn-panel-open"[^<]*</button>)',
        r'\1\n        <a href="space-weather.html" class="cv-btn" id="btn-sw" title="Live Space Weather Data">⚡ Weather</a>',
        html, count=1
    )
    return html


def patch_add_strip(html, filename, pos_style, anchor_html, before=False):
    """Pages without cv-btn strip – add CSS block and single button."""
    if already_has(html, 'id="btn-sw"'):
        return html
    if already_has(html, '.cv-btn {'):
        # Page has cv-btn CSS already (shouldn't happen for these pages but just in case)
        pass
    else:
        # Add CSS before </style> closest to body
        # Find last </style> before </head> or first <body>
        match = list(re.finditer(r'</style>', html))
        if not match:
            raise ValueError(f"No </style> found in {filename}")
        # Use the last </style> in <head> (before body)
        body_idx = html.find('<body')
        candidates = [m for m in match if m.start() < body_idx]
        if candidates:
            target = candidates[-1]
        else:
            target = match[0]
        ins_pos = target.start()
        html = html[:ins_pos] + CV_BTN_CSS_COMMON + html[ins_pos:]

    # Add the button HTML at the anchor point
    btn_html = f'\n        <a href="space-weather.html" class="cv-btn" id="btn-sw" title="Live Space Weather Data" style="{pos_style}">⚡ Weather</a>'
    if before:
        html = insert_before(html, anchor_html, btn_html + '\n        ')
    else:
        html = insert_after(html, anchor_html, btn_html)
    return html


def patch_space_weather(html):
    """space-weather.html – add strip without self-link. Add Reset button."""
    if already_has(html, 'id="btn-sw"') or already_has(html, 'btn-sw-here'):
        return html
    # Find the heliosphere canvas element as anchor
    # Add .cv-btn CSS first
    if not already_has(html, '.cv-btn {'):
        match = list(re.finditer(r'</style>', html))
        body_idx = html.find('<body')
        candidates = [m for m in match if m.start() < body_idx]
        target = candidates[-1] if candidates else match[0]
        ins_pos = target.start()
        css = """
/* ─── Floating control buttons ──────────────────────────────────── */
.cv-btn {
    position: absolute; z-index: 60;
    background: rgba(0,10,30,.80); backdrop-filter: blur(8px);
    border: 1px solid rgba(0,160,255,.30); border-radius: 7px;
    color: #60c0ff; cursor: pointer; font-family: inherit;
    font-size: 12px; padding: 6px 11px; transition: all .2s;
    touch-action: manipulation; text-decoration: none; display: inline-block;
}
.cv-btn:hover { background: rgba(0,140,255,.18); border-color:#0088ff; }
#btn-sw-here { top:12px; right:12px; }
"""
        html = html[:ins_pos] + css + html[ins_pos:]

    # Find a good anchor – the helio canvas
    anchor = '<canvas id="helio-canvas"'
    if anchor not in html:
        # fallback
        anchor = '<div id="helio-wrap"'
    if anchor not in html:
        print(f"  ⚠ space-weather.html: couldn't find canvas anchor, skipping btn")
        return html

    btn_html = '\n        <button class="cv-btn" id="btn-sw-here" title="Current Space Weather" style="top:12px;right:12px;" onclick="document.getElementById(\'helio-canvas\').dispatchEvent(new Event(\'reset\'))">⊙ Reset View</button>'
    html = insert_before(html, anchor, btn_html + '\n        ')
    return html


def patch_earth(html):
    """earth.html – layer-panel occupies top-right. Add ⚡ Weather at bottom-right."""
    if already_has(html, 'id="btn-sw"'):
        return html
    if not already_has(html, '.cv-btn {'):
        match = list(re.finditer(r'</style>', html))
        body_idx = html.find('<body')
        candidates = [m for m in match if m.start() < body_idx]
        target = candidates[-1] if candidates else match[0]
        ins_pos = target.start()
        css = """
/* ─── Space Weather button ───────────────────────────────────────── */
.cv-btn {
    position: absolute; z-index: 60;
    background: rgba(0,10,20,.80); backdrop-filter: blur(8px);
    border: 1px solid rgba(0,200,255,.30); border-radius: 7px;
    color: #00c6ff; cursor: pointer; font-family: inherit;
    font-size: 12px; padding: 6px 11px; transition: all .2s;
    touch-action: manipulation; text-decoration: none; display: inline-block;
}
.cv-btn:hover { background: rgba(0,200,255,.15); border-color:#00c6ff; }
"""
        html = html[:ins_pos] + css + html[ins_pos:]

    # Add button before closing </div> of canvas-wrap or after layer-panel
    anchor = '<div id="layer-panel">'
    btn_html = '<a href="space-weather.html" class="cv-btn" id="btn-sw" title="Live Space Weather Data" style="bottom:16px;right:12px;">⚡ Weather</a>\n\n    '
    html = insert_before(html, anchor, btn_html)
    return html


def patch_galactic(html):
    """galactic-map.html – sidebar-toggle at top:14px;right:14px. Add ⚡ at right:120px."""
    if already_has(html, 'id="btn-sw"'):
        return html
    if not already_has(html, '.cv-btn {'):
        match = list(re.finditer(r'</style>', html))
        body_idx = html.find('<body')
        candidates = [m for m in match if m.start() < body_idx]
        target = candidates[-1] if candidates else match[0]
        ins_pos = target.start()
        css = """
/* ─── Space Weather link button ─────────────────────────────────── */
.cv-btn {
    position: absolute; z-index: 60;
    background: rgba(4,2,20,.80); backdrop-filter: blur(8px);
    border: 1px solid rgba(160,100,255,.30); border-radius: 7px;
    color: #c090ff; cursor: pointer; font-family: inherit;
    font-size: 12px; padding: 6px 11px; transition: all .2s;
    touch-action: manipulation; text-decoration: none; display: inline-block;
}
.cv-btn:hover { background: rgba(160,100,255,.18); border-color:#a060ff; }
"""
        html = html[:ins_pos] + css + html[ins_pos:]

    # Add button after sidebar-toggle HTML
    anchor = '<button id="sidebar-toggle">☰ Panel</button>'
    btn_html = '\n        <a href="space-weather.html" class="cv-btn" id="btn-sw" title="Live Space Weather Data" style="top:14px;right:120px;">⚡ Weather</a>'
    html = insert_after(html, anchor, btn_html)
    return html


def patch_star3d(html):
    """star3d.html – sidebar-toggle at top:16px;right:16px. Add ⚡ at right:120px."""
    if already_has(html, 'id="btn-sw"'):
        return html
    if not already_has(html, '.cv-btn {'):
        match = list(re.finditer(r'</style>', html))
        body_idx = html.find('<body')
        candidates = [m for m in match if m.start() < body_idx]
        target = candidates[-1] if candidates else match[0]
        ins_pos = target.start()
        css = """
/* ─── Space Weather link button ─────────────────────────────────── */
        .cv-btn {
            position: absolute; z-index: 60;
            background: rgba(4,2,0,.80); backdrop-filter: blur(8px);
            border: 1px solid rgba(255,215,0,.30); border-radius: 7px;
            color: #ffd700; cursor: pointer; font-family: inherit;
            font-size: 12px; padding: 6px 11px; transition: all .2s;
            touch-action: manipulation; text-decoration: none; display: inline-block;
        }
        .cv-btn:hover { background: rgba(255,215,0,.15); border-color:#ffd700; }
"""
        html = html[:ins_pos] + css + html[ins_pos:]

    # Add button after sidebar-toggle HTML
    anchor = '<button id="sidebar-toggle">&#9776; Panel</button>'
    btn_html = '\n        <a href="space-weather.html" class="cv-btn" id="btn-sw" title="Live Space Weather Data" style="top:16px;right:120px;">⚡ Weather</a>'
    html = insert_after(html, anchor, btn_html)
    return html


def patch_generic(html, filename, color, top_right='top:12px; right:12px;',
                  canvas_selector=None, anchor_comment=None):
    """Generic pages – add cv-btn CSS and Weather button near canvas."""
    if already_has(html, 'id="btn-sw"'):
        return html
    if not already_has(html, '.cv-btn {'):
        match = list(re.finditer(r'</style>', html))
        body_idx = html.find('<body')
        candidates = [m for m in match if m.start() < body_idx]
        if not candidates:
            candidates = match
        target = candidates[-1]
        ins_pos = target.start()
        css = f"""
/* ─── Space Weather link button ─────────────────────────────────── */
.cv-btn {{
    position: absolute; z-index: 60;
    background: rgba(4,2,0,.80); backdrop-filter: blur(8px);
    border: 1px solid {color}; border-radius: 7px;
    color: {color}; cursor: pointer; font-family: inherit;
    font-size: 12px; padding: 6px 11px; transition: all .2s;
    touch-action: manipulation; text-decoration: none; display: inline-block;
}}
.cv-btn:hover {{ background: rgba(255,140,0,.15); border-color:#ff8c00; color:#ffb830; }}
"""
        html = html[:ins_pos] + css + html[ins_pos:]

    # Find a good anchor – canvas element or canvas-area div
    btn_html = f'<a href="space-weather.html" class="cv-btn" id="btn-sw" title="Live Space Weather Data" style="{top_right}">⚡ Weather</a>\n\n        '

    # Try various anchors
    anchors = [
        '<canvas id="canvas"',
        '<div id="canvas-area">',
        '<div id="canvas-wrap">',
        '<canvas ',
    ]
    if canvas_selector:
        anchors.insert(0, canvas_selector)

    for anc in anchors:
        if anc in html:
            html = insert_before(html, anc, btn_html)
            return html

    # Fallback: insert after opening body tag
    html = insert_after(html, '<body>', '\n        ' + btn_html.rstrip())
    return html


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    pages = {
        'sun.html':             patch_sun,
        'threejs.html':         lambda h: patch_page_with_controls(h, 'threejs.html'),
        'betelgeuse.html':      lambda h: patch_page_with_controls(h, 'betelgeuse.html'),
        'sirius.html':          lambda h: patch_page_with_controls(h, 'sirius.html'),
        'vega.html':            lambda h: patch_page_with_controls(h, 'vega.html'),
        'wr102.html':           lambda h: patch_page_with_controls(h, 'wr102.html'),
        'space-weather.html':   patch_space_weather,
        'earth.html':           patch_earth,
        'galactic-map.html':    patch_galactic,
        'star3d.html':          patch_star3d,
        'solar-fluid.html':     lambda h: patch_generic(h, 'solar-fluid.html', '#ff8c00', 'top:12px; right:12px;'),
        'star2d.html':          lambda h: patch_generic(h, 'star2d.html', '#ffb830', 'top:12px; right:12px;'),
        'star2d-advanced.html': lambda h: patch_generic(h, 'star2d-advanced.html', '#ffb830', 'top:12px; right:12px;'),
        'stellar-wind.html':    lambda h: patch_generic(h, 'stellar-wind.html', '#60d8ff', 'top:12px; right:12px;'),
        'black-hole-fluid.html':lambda h: patch_generic(h, 'black-hole-fluid.html', '#cc44ff', 'top:12px; right:12px;', '<div id="panel">'),
    }

    print("Adding ⚡ Weather button to sim pages...")
    for fname, patcher in pages.items():
        path = os.path.join(BASE, fname)
        if not os.path.exists(path):
            print(f"  ⚠ {fname}: file not found, skipping")
            continue
        html = read(path)
        try:
            new_html = patcher(html)
            if new_html != html:
                write(path, new_html)
            else:
                print(f"  – {fname}: no changes (already patched?)")
        except ValueError as e:
            print(f"  ✗ {fname}: ERROR – {e}")

    print("\nDone.")

if __name__ == '__main__':
    main()
