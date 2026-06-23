# Supabase branching baseline — runbook

> **Problem this fixes:** Supabase database branching (GitHub integration) builds
> each PR a fresh, empty preview database and **replays the migration history**
> onto it. But the recorded history (`supabase_migrations.schema_migrations`)
> starts at `20260512145405 session_heartbeat_fix` — there is **no base-schema
> migration before it**. The base tables (`user_sessions`, `user_profiles`,
> `weather_grid_cache`, …) were created via the SQL editor long ago and never
> recorded, so on an empty preview DB the first migration hits
> `ERROR: relation "public.user_sessions" does not exist (42P01)`.
> `main`/prod is unaffected (it already has everything). Every preview branch
> fails identically (PR #835 in June, PR #889 now) — this is pre-existing.
>
> **Fix (canonical):** Adopt CLI-managed migrations. `supabase db pull` captures
> the *full current schema* from prod into one baseline file under
> `supabase/migrations/`. Once the repo has that directory, branching replays
> the repo files — the baseline creates the whole schema first, so preview
> branches build green.

---

## Why this is run by hand (not by the agent)

The agent's sandbox has **no Supabase CLI, no DB credentials, and can't reach
`db.aijsboodkivnhzfstvdq.supabase.co` (port 5432 blocked)**. `supabase db pull`
must run from a machine that can log in and reach the database — i.e. yours.
The agent *can* verify the result afterward via the Supabase MCP (re-trigger the
preview branch and check its status).

## Prerequisites
- Supabase CLI ≥ 1.200 (`brew install supabase/tap/supabase` or see docs).
- `supabase login` (creates the access token).
- The project's **database password** (Dashboard → Project Settings → Database).
- Run everything from the repo root on the **`claude/adoring-heisenberg-1whbj7`**
  branch (so the `supabase/` dir lands on the PR that's failing).

## Steps

```bash
# 0. repo root, on the feature branch
git switch claude/adoring-heisenberg-1whbj7

# 1. scaffold supabase/ (creates config.toml + .gitignore for YOUR CLI version)
supabase init                      # if it says "already exists", that's fine

# 2. point config at the project, then link (prompts for the DB password)
#    set:  project_id = "aijsboodkivnhzfstvdq"   in supabase/config.toml
supabase link --project-ref aijsboodkivnhzfstvdq

# 3. capture the full current schema as the baseline migration.
#    Writes supabase/migrations/<timestamp>_remote_schema.sql (the whole schema).
supabase db pull

# 4. (likely needed) reconcile the 15 already-recorded remote migrations so the
#    CLI treats them as applied rather than trying to re-run them. `db pull`
#    usually prints the exact `migration repair` commands; if it lists them as
#    "reverted"/missing locally, mark them applied:
supabase migration list            # see local vs remote
#    for each remote-only version it flags:
# supabase migration repair --status applied <version>

# 5. commit the generated files
git add supabase/
git commit -m "supabase: adopt CLI migrations + full-schema baseline for branch builds"
git push
```

## Verify (the agent can do this part)

After you push step 5, the GitHub integration rebuilds the **#889** preview
branch against the new `supabase/migrations/`. Ping the agent and it will, via
the Supabase MCP:
1. `list_branches` → confirm `claude/adoring-heisenberg-1whbj7` flips from
   `MIGRATIONS_FAILED` → `MIGRATIONS_PASSED`/`FUNCTIONS_DEPLOYED`.
2. If it still fails, pull `branch-action` + the preview project's `postgres`
   logs, identify the next missing object, and tell you the precise follow-up
   (usually one more `migration repair`, or a tweak to the baseline).

A clean preview build is the proof. Nothing here touches prod data — `db pull`
only *reads* prod; the baseline only *runs* on the empty preview DB.

## Gotchas
- **Don't** hand-edit `schema_migrations` on prod — let the CLI own it.
- If `db pull` errors on an extension or `auth`/`storage` object, re-run with
  `--schema public` first to get the app schema, then widen as needed.
- Keep `supabase/.branches/` and `supabase/.temp/` git-ignored (the generated
  `.gitignore` handles this).
- From now on, **new schema changes go through `supabase migration new …` +
  `supabase db push`** (or the agent's `apply_migration`, which also records to
  `schema_migrations`) so the history stays replayable and branches keep working.
