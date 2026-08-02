# Vendored @supabase/supabase-js

`supabase-js-2.111.0-umd.js` is the **unmodified** official UMD build:

- Package: `@supabase/supabase-js@2.111.0`
- File: `dist/umd/supabase.js` from the npm tarball (`npm pack @supabase/supabase-js@2`)
- sha256: `7396012594aa6d23bb373ebc25d1080bf3672fa847c3713f756520b40fd13453`
- Vendored: 2026-08-01

## Why self-hosted

Telemetry showed **946 sessions in 30 days** (spiking ~200/day Jul 19–23 2026)
failing `import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')`
and falling back to mock auth (`auth_failure` / `auth_init_fallback_to_mock`
in `client_telemetry`). For those sessions sign-in was impossible. Serving the
client from our own origin removes the third-party point of failure; the CDN
import remains as the fallback, so the failure now requires BOTH to be down.
Decision approved by the author 2026-08-01 (this was a CLAUDE.md §9 ask-first
item).

## How it loads

`js/supabase-config.js` injects this file as a **classic** `<script>` tag
(NOT a dynamic `import()`): the bundle is an IIFE assigned to top-level
`var supabase`, which only becomes `window.supabase` in sloppy/classic script
scope. A dynamic import would execute it into module scope and leave no
global. On local failure it falls back to the jsdelivr `+esm` CDN import.

## Upgrading

```sh
npm pack @supabase/supabase-js@2          # yields supabase-supabase-js-<v>.tgz
tar xzf supabase-supabase-js-<v>.tgz
cp package/dist/umd/supabase.js js/vendor/supabase-js-<v>-umd.js
sha256sum js/vendor/supabase-js-<v>-umd.js   # update this README
```

Then update `SUPABASE_LOCAL` in `js/supabase-config.js`, keep the old file
for one deploy cycle if you want instant rollback, and delete it after.
Keep the version in the FILENAME — it doubles as the cache-buster (pages
cache aggressively; a same-name swap would serve stale bytes for days).
