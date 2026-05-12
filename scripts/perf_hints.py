#!/usr/bin/env python3
"""Add resource hints to pages that use Three.js via the importmap so the
browser starts fetching the module before the inline scripts execute.

Adds (when missing):
- <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
- <link rel="modulepreload" href="<three.module.js>" crossorigin>

CRITICAL placement: the block goes IMMEDIATELY AFTER the
<script type="importmap"> closing tag, not earlier in <head>. A
modulepreload counts as a module load; per the HTML spec, once any
module has started loading the import map is invalidated and bare
specifiers like `import 'three'` fail with "was not remapped to
anything". Putting the modulepreload after the importmap keeps the
specifier-resolution working.

The block is fenced with HTML comments so re-running the script
replaces in place rather than appending. If an old version of this
script placed the block earlier in <head>, this version REMOVES that
old block before inserting the new one in the correct location.
"""
from __future__ import annotations
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

THREE_MODULE_URL_RE = re.compile(
    r'(https://cdn\.jsdelivr\.net/npm/three@[^"\']+/build/three\.module\.js)'
)
IMPORTMAP_RE = re.compile(
    r'<script\s+type=["\']importmap["\']\s*>.*?</script>', re.S | re.I
)

BLOCK_START = "<!-- perf-hints:start -->"
BLOCK_END = "<!-- perf-hints:end -->"
EXISTING_BLOCK_RE = re.compile(
    r"\n?" + re.escape(BLOCK_START) + r".*?" + re.escape(BLOCK_END) + r"\n?",
    re.S,
)


def hints_block(three_url: str) -> str:
    return (
        f"{BLOCK_START}\n"
        '<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>\n'
        '<link rel="dns-prefetch" href="https://cdn.jsdelivr.net">\n'
        f'<link rel="modulepreload" href="{three_url}" crossorigin>\n'
        f"{BLOCK_END}"
    )


def process(path: Path) -> bool:
    html = path.read_text(encoding="utf-8")
    m = THREE_MODULE_URL_RE.search(html)
    if not m:
        return False
    three_url = m.group(1)

    # Always start by stripping any prior block (it may be in the wrong
    # position from a previous version of this script).
    html_clean = EXISTING_BLOCK_RE.sub("", html)

    # Locate the importmap. Without one, bare-specifier modules can't
    # resolve and modulepreload is the wrong tool — skip.
    imap = IMPORTMAP_RE.search(html_clean)
    if not imap:
        return False

    block = hints_block(three_url)
    insert_at = imap.end()
    new_html = html_clean[:insert_at] + "\n" + block + html_clean[insert_at:]

    if new_html == html:
        return False
    path.write_text(new_html, encoding="utf-8")
    return True


def main() -> None:
    pages = sorted(p for p in ROOT.glob("*.html") if THREE_MODULE_URL_RE.search(
        p.read_text(encoding="utf-8")
    ))
    changed = 0
    for p in pages:
        if process(p):
            print(f"  + {p.name}")
            changed += 1
        else:
            print(f"  = {p.name}")
    print(f"\n{changed} pages updated, {len(pages) - changed} already current.")


if __name__ == "__main__":
    main()
