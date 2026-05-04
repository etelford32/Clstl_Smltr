# Security Policy — Parker Physics App / Telford Projects LLC

This document is the responsible-disclosure policy referenced from
[`/.well-known/security.txt`](./.well-known/security.txt).

## Reporting a vulnerability

Please email **security@parkerphysics.app** with:

- A clear description of the issue and the affected endpoint, page, or
  component.
- Steps to reproduce, ideally with a minimal proof of concept.
- The impact you believe an attacker could achieve.
- Any logs, screenshots, or HTTP traces that help us reproduce.

If the issue involves sensitive data (account takeover paths, exposed keys,
SQL injection, RCE, or similar), please request a PGP key in your first
message and we will coordinate an encrypted channel.

## Our commitments

- We will **acknowledge** your report within **3 business days**.
- We will keep you informed about our investigation and the planned fix.
- We will not pursue legal action against researchers who:
  - act in good faith and follow this policy,
  - make a reasonable effort to avoid privacy violations, service disruption,
    and data destruction,
  - do not attempt to extort, coerce, or extract financial gain beyond the
    scope of any published bug-bounty program (we do not currently run one),
  - give us a reasonable window to remediate before any public disclosure
    (we suggest a 90-day default; we are happy to extend or shorten by
    mutual agreement).
- We will credit you in the Acknowledgments section below if you would
  like, after the issue is resolved.

## Out of scope

The following do **not** qualify as vulnerabilities for the purpose of this
policy:

- Reports based solely on missing security headers without a demonstrable
  exploit path.
- Self-XSS that requires the victim to paste arbitrary code into their own
  console.
- Denial-of-service through volumetric request floods.
- Issues in third-party services (NOAA, NASA, JPL, NWS, Vercel, Supabase,
  Stripe) that we proxy or depend on — please report those upstream.
- Findings affecting only browsers or libraries that are end-of-life or
  more than two major versions out of date.
- Rate-limit bypasses that do not result in resource exhaustion or
  unauthorized access to data.
- Reports generated solely by automated scanners without manual analysis.

## Safe-harbor scope

This policy applies to:

- `parkerphysics.app` and `*.parkerphysics.app`
- `parkerphysics.com` and `*.parkerphysics.com`
- `parkersphysics.com` and `*.parkersphysics.com`
- API endpoints under `/api/` and `/v1/` on the domains above

Out of safe harbor:

- Any system that is not owned or operated by Telford Projects LLC.
- Subdomains explicitly marked as "preview," "experimental," or third-party.

## Acknowledgments

We thank the following researchers for responsibly disclosing security
issues. (List will be populated as reports come in.)

_None yet — submissions welcome via the contact above._
