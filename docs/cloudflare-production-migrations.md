# Initial production D1 bootstrap

This manual-only workflow is intentionally limited to Nivasa's initial production
database bootstrap. It is not a general ongoing migration system. It reads the
`CLOUDFLARE_API_TOKEN` GitHub Actions secret and never deploys a Worker or
changes R2, secrets, Workers.dev, preview URLs, or provider settings.

Before using the workflow, create a protected GitHub Environment named exactly
`production` and restrict it to the `main` branch. Store
`CLOUDFLARE_API_TOKEN` only as a secret in that environment. Never store or
duplicate the production token as a repository-level secret; the workflow must
fail if the protected environment does not supply it.

The reviewed migration hashes and exact table and index manifests are safety
boundaries for this bootstrap. Any future schema change requires a separately
reviewed update to those manifests and to the workflow's operating model.

## Run a preflight

1. Open **Actions** → **Cloudflare production migrations** → **Run workflow**.
2. Select the `main` branch. Any dispatch against another branch is skipped
   before the `production` environment is accessed or any workflow step runs.
3. Choose `preflight` for **operation** and leave **confirmation** empty.
4. Select **Run workflow** and review the authentication, pending migration,
   remote schema, ledger, row-count, and private-R2 results.

Preflight is read-only and may be rerun safely.

## Apply the initial migrations

1. First complete a successful `preflight` run from `main`.
2. Open **Run workflow** again and select the repository's default `main`
   branch.
3. Choose `apply` and enter this exact confirmation phrase:

   `APPLY_NIVASA_PRODUCTION_MIGRATIONS`

4. Select **Run workflow** and review the guarded preflight and post-migration
   verification.

Apply fails closed unless the configured production resource identifiers match,
the database is fresh, and exactly the 11 reviewed migrations are pending. The
fixed production concurrency group prevents overlapping migration runs.

## Partial-migration recovery

D1 records each successful migration as it completes. If a later migration
fails, the earlier successful migrations remain applied. This workflow then
intentionally refuses an automatic retry because the remote database is in an
unexpected partial state.

Recovery requires inspecting the remote migration ledger and database state,
resolving the underlying cause, and carrying out a separately reviewed manual
recovery. Never delete migration-ledger rows or rerun the workflow blindly.
