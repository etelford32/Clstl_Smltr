"""Remove inline CSS rules that are exact duplicates of rules in
js/nav-styles.css.

Conservative: only top-level rules whose selector + declarations match
the shared file (after whitespace/comma normalization) are removed.
Page-specific overrides, hover states, @media blocks, and any rule with
even a single different declaration are preserved untouched.

Run: python3 scripts/nav_css_dedup.py [page.html ...]
With no args, runs in --dry-run mode against the heavy pages and
prints byte savings without writing.

Flags:
  --apply   write changes
"""
from __future__ import annotations
import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAV_PREFIXES = ("nav", ".nav-", ".burger-", ".ndl-")

DEFAULT_PAGES = [
    "earth.html",
    "galactic-map.html",
    "sun.html",
    "star3d.html",
    "space-weather.html",
    "threejs.html",
    "mission-planner.html",
    "time-machine.html",
    "betelgeuse.html",
    "vega.html",
    "wr102.html",
    "sirius.html",
    "achernar.html",
    "sagittarius.html",
    "ton618.html",
    "moon.html",
    "stellar-wind.html",
    "solar-fluid.html",
    "satellites.html",
    "operations.html",
    "missions.html",
    "launch-planner.html",
    "upper-atmosphere.html",
    "jupiter-system.html",
    "gravity-lab.html",
    "index.html",
]


def normalize_selector(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    parts = [p.strip() for p in s.split(",")]
    return ", ".join(sorted(parts))


def normalize_decls(body: str) -> str:
    parts = []
    for p in body.split(";"):
        p = p.strip()
        if not p:
            continue
        if ":" not in p:
            parts.append(p)
            continue
        k, v = p.split(":", 1)
        k = k.strip().lower()
        v = re.sub(r"\s+", " ", v.strip())
        v = re.sub(r"\s*,\s*", ",", v)
        v = re.sub(r"\(\s+", "(", v)
        v = re.sub(r"\s+\)", ")", v)
        parts.append(f"{k}: {v}")
    return "; ".join(sorted(parts))


def parse_top_level_rules(css: str) -> list[tuple[int, int, str, str]]:
    """Return list of (start, end, selector_norm, decls_norm) for
    top-level rules, skipping over @media/@supports blocks. Comments
    in the source are not stripped from the offsets."""
    out: list[tuple[int, int, str, str]] = []
    i = 0
    n = len(css)
    in_block_comment = False
    while i < n:
        # Skip whitespace and block comments
        while i < n and css[i] in " \t\r\n":
            i += 1
        if i + 1 < n and css[i:i+2] == "/*":
            j = css.find("*/", i + 2)
            i = (j + 2) if j != -1 else n
            continue
        if i >= n:
            break
        # Find next "{"
        brace = css.find("{", i)
        if brace == -1:
            break
        sel = css[i:brace].strip()
        if sel.startswith("@"):
            # Skip nested block by depth tracking
            depth = 1
            j = brace + 1
            while j < n and depth > 0:
                if css[j] == "{":
                    depth += 1
                elif css[j] == "}":
                    depth -= 1
                j += 1
            i = j
            continue
        # Find matching close brace
        depth = 1
        j = brace + 1
        while j < n and depth > 0:
            if css[j] == "{":
                depth += 1
            elif css[j] == "}":
                depth -= 1
            j += 1
        body = css[brace + 1: j - 1]
        out.append((i, j, normalize_selector(sel), normalize_decls(body)))
        i = j
    return out


def is_nav_selector(sel: str) -> bool:
    parts = [p.strip() for p in sel.split(",")]
    for p in parts:
        for tok in p.split():
            if tok.startswith(NAV_PREFIXES):
                return True
        if p == "nav" or p.startswith("nav "):
            return True
    return False


def build_shared_index() -> dict[str, str]:
    css = (ROOT / "js" / "nav-styles.css").read_text(encoding="utf-8")
    rules = parse_top_level_rules(css)
    return {sel: decls for _, _, sel, decls in rules}


def dedup_inline_style(inline_css: str, shared: dict[str, str]) -> tuple[str, list[str]]:
    rules = parse_top_level_rules(inline_css)
    removed: list[str] = []
    keep_intervals: list[tuple[int, int]] = []
    last = 0
    for start, end, sel, decls in rules:
        if is_nav_selector(sel) and sel in shared and shared[sel] == decls:
            keep_intervals.append((last, start))
            removed.append(sel)
            last = end
            continue
    keep_intervals.append((last, len(inline_css)))
    new_css = "".join(inline_css[a:b] for a, b in keep_intervals)
    # Collapse runs of >2 blank lines that may now appear after removal.
    new_css = re.sub(r"\n[ \t]*\n[ \t]*\n+", "\n\n", new_css)
    return new_css, removed


STYLE_BLOCK_RE = re.compile(r"(<style\b[^>]*>)(.*?)(</style>)", re.S | re.I)


def process(html_path: Path, shared: dict[str, str], apply: bool) -> tuple[int, int, list[str]]:
    html = html_path.read_text(encoding="utf-8")
    sm = STYLE_BLOCK_RE.search(html)
    if not sm:
        return 0, 0, []
    inline = sm.group(2)
    new_inline, removed = dedup_inline_style(inline, shared)
    if not removed:
        return 0, 0, []
    new_html = html[: sm.start(2)] + new_inline + html[sm.end(2):]
    bytes_saved = len(html) - len(new_html)
    if apply:
        html_path.write_text(new_html, encoding="utf-8")
    return bytes_saved, len(removed), removed


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pages", nargs="*", help="HTML files (default: heavy pages)")
    ap.add_argument("--apply", action="store_true", help="write changes")
    args = ap.parse_args()

    pages = args.pages or DEFAULT_PAGES
    shared = build_shared_index()
    total_saved = 0
    total_removed = 0
    for name in pages:
        path = ROOT / name
        if not path.exists():
            print(f"  ! missing: {name}")
            continue
        saved, n_removed, removed_sels = process(path, shared, args.apply)
        if n_removed:
            tag = "applied" if args.apply else "would remove"
            print(f"  {tag}: {name} — {n_removed} rules, {saved:,} bytes")
            total_saved += saved
            total_removed += n_removed
        else:
            print(f"  =       : {name}")
    print(
        f"\nTotal: {total_removed} rules, {total_saved:,} bytes "
        f"({'applied' if args.apply else 'dry-run; pass --apply to write'})"
    )


if __name__ == "__main__":
    main()
