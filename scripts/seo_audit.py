#!/usr/bin/env python3
"""SEO audit — inventory every public HTML page in the repo and report
title length, description length, H1 presence, canonical correctness,
OG/Twitter coverage, JSON-LD presence, and image alt-text gaps.
"""
from __future__ import annotations
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://parkersphysics.com"

# Pages we consider "public" (excludes auth-walled, internal admin, dev tools)
EXCLUDE = {
    "404.html",
    "account.html",
    "admin.html",
    "auth-callback.html",
    "dashboard.html",
    "design-tokens.html",
    "feedback.html",
    "reset-password.html",
    "rust.html",
    "status.html",
    "superadmin.html",
}

TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S | re.I)
META_DESC_RE = re.compile(
    r'<meta\s+name=["\']description["\']\s+content="(.*?)"\s*/?>', re.I | re.S
)
CANONICAL_RE = re.compile(
    r'<link\s+rel=["\']canonical["\']\s+href="(.*?)"', re.I | re.S
)
H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.S | re.I)
H2_RE = re.compile(r"<h2[^>]*>", re.I)
OG_RE = re.compile(
    r'<meta\s+property=["\']og:([a-z_:]+)["\']\s+content="(.*?)"', re.I | re.S
)
TW_RE = re.compile(
    r'<meta\s+name=["\']twitter:([a-z_:]+)["\']\s+content="(.*?)"', re.I | re.S
)
JSONLD_RE = re.compile(
    r'<script\s+type=["\']application/ld\+json["\']\s*>', re.I
)
IMG_RE = re.compile(r"<img\b([^>]*)>", re.I)
ALT_RE = re.compile(r'\balt=["\'](.*?)["\']', re.I)
A_HREF_RE = re.compile(r'<a\b[^>]*\bhref=["\']([^"\']+)["\']', re.I)


def strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s).strip()


def get_sitemap_urls() -> set[str]:
    ns = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
    tree = ET.parse(ROOT / "sitemap.xml")
    return {u.findtext(ns + "loc") for u in tree.getroot().findall(ns + "url")}


def page_canonical_path(canonical: str) -> str:
    if not canonical.startswith(SITE):
        return canonical
    p = canonical[len(SITE):] or "/"
    return p


def audit_file(path: Path) -> dict:
    html = path.read_text(encoding="utf-8", errors="replace")
    title_m = TITLE_RE.search(html)
    title = strip_html(title_m.group(1)) if title_m else ""
    desc_m = META_DESC_RE.search(html)
    desc = desc_m.group(1) if desc_m else ""
    canonical_m = CANONICAL_RE.search(html)
    canonical = canonical_m.group(1) if canonical_m else ""
    h1_count = len(H1_RE.findall(html))
    h2_count = len(H2_RE.findall(html))
    og = {m.group(1).lower(): m.group(2) for m in OG_RE.finditer(html)}
    tw = {m.group(1).lower(): m.group(2) for m in TW_RE.finditer(html)}
    jsonld_count = len(JSONLD_RE.findall(html))

    imgs = IMG_RE.findall(html)
    img_total = len(imgs)
    img_missing_alt = 0
    img_empty_alt = 0
    for tag in imgs:
        alt_m = ALT_RE.search(tag)
        if not alt_m:
            img_missing_alt += 1
        elif not alt_m.group(1).strip():
            img_empty_alt += 1

    # Internal/external links
    hrefs = A_HREF_RE.findall(html)
    internal = sum(
        1 for h in hrefs
        if h.startswith("/") or h.startswith(SITE) or
        (not h.startswith(("http://", "https://", "mailto:", "tel:", "#", "javascript:")))
    )
    external = sum(
        1 for h in hrefs
        if h.startswith(("http://", "https://")) and SITE not in h
    )

    return {
        "title": title,
        "title_len": len(title),
        "desc": desc,
        "desc_len": len(desc),
        "canonical": canonical,
        "h1_count": h1_count,
        "h2_count": h2_count,
        "og_keys": sorted(og.keys()),
        "tw_keys": sorted(tw.keys()),
        "og_image": og.get("image", ""),
        "jsonld_count": jsonld_count,
        "img_total": img_total,
        "img_missing_alt": img_missing_alt,
        "img_empty_alt": img_empty_alt,
        "links_internal": internal,
        "links_external": external,
        "size_kb": round(len(html) / 1024, 1),
    }


def main() -> None:
    pages = sorted(p.name for p in ROOT.glob("*.html") if p.name not in EXCLUDE)
    sitemap_urls = get_sitemap_urls()

    print(f"# SEO audit — {len(pages)} public pages\n")
    print(f"{'page':<28} {'tlen':>4} {'dlen':>4} {'h1':>3} {'h2':>3} {'og':>3} {'tw':>3} {'ld':>3} {'imgs':>5} {'alt?':>5} {'kb':>5}  canonical_in_sitemap")

    issues: list[str] = []

    for name in pages:
        path = ROOT / name
        a = audit_file(path)
        canonical = a["canonical"]
        in_sitemap = canonical in sitemap_urls if canonical else False
        og_count = len(a["og_keys"])
        tw_count = len(a["tw_keys"])
        alt_problem = a["img_missing_alt"] + a["img_empty_alt"]
        flag_canon = "" if canonical else "—"
        flag_sm = "✓" if in_sitemap else ("·" if not canonical else "✗")
        print(
            f"{name:<28} {a['title_len']:>4} {a['desc_len']:>4} "
            f"{a['h1_count']:>3} {a['h2_count']:>3} {og_count:>3} {tw_count:>3} "
            f"{a['jsonld_count']:>3} {a['img_total']:>5} {alt_problem:>5} "
            f"{a['size_kb']:>5}  {flag_sm} {flag_canon}"
        )

        # Collect issues
        if not canonical:
            issues.append(f"  no canonical: {name}")
        elif canonical not in sitemap_urls and name not in ("signup.html", "signin.html"):
            issues.append(f"  canonical not in sitemap: {name} -> {canonical}")
        if not a["title"]:
            issues.append(f"  no <title>: {name}")
        elif a["title_len"] > 60:
            issues.append(f"  title too long ({a['title_len']}): {name}")
        elif a["title_len"] < 25 and name != "404.html":
            issues.append(f"  title short ({a['title_len']}): {name}")
        if not a["desc"]:
            issues.append(f"  no meta description: {name}")
        else:
            if a["desc_len"] > 165:
                issues.append(f"  description too long ({a['desc_len']}): {name}")
            elif a["desc_len"] < 70:
                issues.append(f"  description too short ({a['desc_len']}): {name}")
        if a["h1_count"] == 0:
            issues.append(f"  no <h1>: {name}")
        elif a["h1_count"] > 1:
            issues.append(f"  multiple <h1> ({a['h1_count']}): {name}")
        if og_count < 5:
            issues.append(f"  thin OG ({og_count} props): {name}")
        if tw_count < 3:
            issues.append(f"  thin Twitter ({tw_count} props): {name}")
        if a["jsonld_count"] == 0:
            issues.append(f"  no JSON-LD: {name}")
        if alt_problem:
            issues.append(
                f"  imgs missing alt: {name} (missing={a['img_missing_alt']} empty={a['img_empty_alt']} of {a['img_total']})"
            )
        if a["og_image"] and not a["og_image"].startswith(("http://", "https://")):
            issues.append(f"  relative og:image: {name} -> {a['og_image']}")

    # Sitemap entries that don't resolve to a file
    print(f"\n# Sitemap URLs not resolving to a local HTML file:")
    for u in sorted(sitemap_urls):
        path = u.removeprefix(SITE).lstrip("/") or "index.html"
        if "." not in path.split("/")[-1]:
            path = f"{path}.html"
        if not (ROOT / path).exists():
            print(f"  ! {u} -> expected {path} (missing)")

    # Public HTML files NOT in sitemap
    print(f"\n# Public HTML files not in the sitemap:")
    in_sm_basenames = {
        u.removeprefix(SITE).lstrip("/") or "index.html"
        for u in sitemap_urls
    }
    in_sm_basenames = {
        n if "." in n.split("/")[-1] else f"{n}.html" for n in in_sm_basenames
    }
    for name in pages:
        if name not in in_sm_basenames:
            print(f"  ? {name}")

    print(f"\n# Issues ({len(issues)}):")
    for i in issues:
        print(i)


if __name__ == "__main__":
    main()
