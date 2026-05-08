"""Compare a page's inline nav CSS rules against js/nav-styles.css.

For each page, we:
1. Extract the inline <style> block.
2. Locate the contiguous nav-related region (selectors starting with
   `nav` or `.nav-` or `.burger-` or `.ndl-`).
3. Parse those rules into a normalized {selector -> {prop: value}} map.
4. Compare against the same parse of js/nav-styles.css.
5. Report:
   - Rules whose selector exists in shared with IDENTICAL declarations
     (safe to remove).
   - Rules whose selector exists in shared but declarations DIFFER
     (need manual review).
   - Rules whose selector is NOT in shared (page-specific; keep).
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

NAV_PREFIXES = ("nav", ".nav-", ".burger-", ".ndl-")


def parse_rules(css: str) -> list[tuple[str, str, str]]:
    """Returns list of (selector_normalized, decls_normalized, raw)."""
    # Strip comments
    css_nc = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    rules: list[tuple[str, str, str]] = []
    # Walk through, handling @media as a single block by skipping over them
    # for now (we'll handle media queries separately).
    i = 0
    while i < len(css_nc):
        # Find opening { of next rule
        m = re.search(r"\{", css_nc[i:])
        if not m:
            break
        brace_open = i + m.start()
        sel = css_nc[i:brace_open].strip()
        if not sel:
            i = brace_open + 1
            continue
        # Skip @media — they need separate handling
        if sel.startswith("@"):
            depth = 1
            j = brace_open + 1
            while j < len(css_nc) and depth > 0:
                if css_nc[j] == "{":
                    depth += 1
                elif css_nc[j] == "}":
                    depth -= 1
                j += 1
            i = j
            continue
        # Find matching close brace
        depth = 1
        j = brace_open + 1
        while j < len(css_nc) and depth > 0:
            if css_nc[j] == "{":
                depth += 1
            elif css_nc[j] == "}":
                depth -= 1
            j += 1
        body = css_nc[brace_open + 1 : j - 1]
        raw = css_nc[i:j]
        sel_norm = normalize_selector(sel)
        decls_norm = normalize_decls(body)
        rules.append((sel_norm, decls_norm, raw.strip()))
        i = j
    return rules


def normalize_selector(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    # normalize commas
    parts = [p.strip() for p in s.split(",")]
    return ", ".join(sorted(parts))


def normalize_decls(body: str) -> str:
    # Split on ; ignoring trailing whitespace; sort props
    parts = []
    for p in body.split(";"):
        p = p.strip()
        if not p:
            continue
        # split first colon
        if ":" not in p:
            parts.append(p)
            continue
        k, v = p.split(":", 1)
        k = k.strip().lower()
        v = re.sub(r"\s+", " ", v.strip())
        # Normalize whitespace around commas inside values so
        # `linear-gradient(45deg,#ff8c00,#ffd700)` and
        # `linear-gradient(45deg, #ff8c00, #ffd700)` compare equal.
        v = re.sub(r"\s*,\s*", ",", v)
        # Same for whitespace inside parens (after the open paren and before close)
        v = re.sub(r"\(\s+", "(", v)
        v = re.sub(r"\s+\)", ")", v)
        parts.append(f"{k}: {v}")
    return "; ".join(sorted(parts))


def looks_like_nav(selector: str) -> bool:
    parts = [p.strip() for p in selector.split(",")]
    for p in parts:
        # accept compound like "nav-burger.open .burger-line:nth-child(1)" etc.
        # Match if any token in compound starts with one of the prefixes.
        if any(t.lstrip().startswith(NAV_PREFIXES) for t in p.split()):
            return True
        if p == "nav" or p.startswith("nav "):
            return True
    return False


def extract_inline_style(html: str) -> str:
    m = re.search(r"<style\b[^>]*>(.*?)</style>", html, re.S | re.I)
    return m.group(1) if m else ""


def diff_page(html_path: Path, shared_rules: list[tuple[str, str, str]]) -> dict:
    html = html_path.read_text(encoding="utf-8")
    inline_css = extract_inline_style(html)
    inline_rules = parse_rules(inline_css)
    nav_inline = [r for r in inline_rules if looks_like_nav(r[0])]

    shared_index: dict[str, str] = {}  # sel -> decls
    for sel, decls, _ in shared_rules:
        shared_index[sel] = decls

    identical = []
    differ = []
    page_only = []

    for sel, decls, raw in nav_inline:
        if sel in shared_index:
            if shared_index[sel] == decls:
                identical.append((sel, raw))
            else:
                differ.append((sel, decls, shared_index[sel], raw))
        else:
            page_only.append((sel, raw))

    return {
        "path": html_path.name,
        "nav_inline_count": len(nav_inline),
        "identical": identical,
        "differ": differ,
        "page_only": page_only,
    }


def main(pages: list[str]) -> None:
    shared_css = (ROOT / "js" / "nav-styles.css").read_text(encoding="utf-8")
    shared_rules = parse_rules(shared_css)
    print(f"shared rules parsed: {len(shared_rules)}\n")

    for pname in pages:
        report = diff_page(ROOT / pname, shared_rules)
        print(f"\n=== {report['path']} ===")
        print(
            f"  nav-related inline rules: {report['nav_inline_count']}"
            f" | identical-to-shared: {len(report['identical'])}"
            f" | differ: {len(report['differ'])}"
            f" | page-only: {len(report['page_only'])}"
        )
        if report["differ"]:
            print("  -- DIFFERS --")
            for sel, page_decls, shared_decls, _ in report["differ"][:30]:
                print(f"    selector: {sel}")
                # show short delta
                page_set = set(page_decls.split("; "))
                shared_set = set(shared_decls.split("; "))
                only_page = page_set - shared_set
                only_shared = shared_set - page_set
                if only_page:
                    print(f"      page only: {sorted(only_page)}")
                if only_shared:
                    print(f"      shared only: {sorted(only_shared)}")
        if report["page_only"]:
            print("  -- PAGE-ONLY (would keep) --")
            for sel, _ in report["page_only"][:30]:
                print(f"    {sel}")


if __name__ == "__main__":
    main(sys.argv[1:] or [
        "earth.html",
        "galactic-map.html",
        "sun.html",
        "star3d.html",
        "space-weather.html",
    ])
