#!/usr/bin/env python3
"""Add resource hints to pages that use Three.js via the importmap so the
browser starts fetching the module before the inline scripts execute.

Adds (when missing):
- <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
- <link rel="modulepreload" href="<three.module.js>" crossorigin>

Insertion point: immediately after the <meta charset=...> line so the
hints are processed as early as possible during HTML parsing. The block
is fenced with HTML comments so re-running the script replaces in place
rather than appending.
"""
from __future__ import annotations
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

THREE_MODULE_URL_RE = re.compile(
    r'(https://cdn\.jsdelivr\.net/npm/three@[^"\']+/build/three\.module\.js)'
)
META_CHARSET_RE = re.compile(r'<meta\s+charset=["\'][^"\']+["\']\s*/?>', re.I)

BLOCK_START = "<!-- perf-hints:start -->"
BLOCK_END = "<!-- perf-hints:end -->"
EXISTING_BLOCK_RE = re.compile(
    re.escape(BLOCK_START) + r".*?" + re.escape(BLOCK_END), re.S
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
    block = hints_block(m.group(1))

    if EXISTING_BLOCK_RE.search(html):
        new_html = EXISTING_BLOCK_RE.sub(block, html)
    else:
        meta = META_CHARSET_RE.search(html)
        if not meta:
            return False
        insert_at = meta.end()
        prefix = html[:insert_at]
        if not prefix.endswith("\n"):
            prefix += "\n"
        new_html = prefix + block + "\n" + html[insert_at:]

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
