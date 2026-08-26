# Initial private Cloudflare Worker rollout

The **Cloudflare private production deployment** workflow is a manual-only,
initial-rollout control for creating or updating `nivasa-home-help` without
making it publicly reachable. It has no push, pull-request, schedule, or
deployment trigger. It never applies D1 migrations, changes D1 records, writes
R2 objects, enables Workers.dev, enables preview URLs, or attaches a route or
custom domain.

The workflow is bound to the protected GitHub Environment named exactly
`production`, whose deployment branch policy must permit only `main`. Dispatch
the workflow only with the `main` branch selected. A non-main dispatch skips the
entire job before environment secrets are made available.

## Production environment values

Store these only as `production` environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `NIVASA_SESSION_SECRET`
- `MSG91_AUTH_KEY`
- `VAPID_PRIVATE_JWK`

Store these as `production` environment variables:

- `NEXT_PUBLIC_MSG91_WIDGET_ID`
- `NEXT_PUBLIC_MSG91_WIDGET_TOKEN`
- `GOOGLE_MAPS_BROWSER_KEY`
- `VAPID_PUBLIC_KEY`
- `VAPID_SUBJECT`

Do not add a repository-level fallback for any production credential. The
Cloudflare token is scoped only to authenticated Cloudflare steps. Runtime
private values are scoped only to non-logging format validation and secret
installation steps; checkout, dependency installation, builds, tests, static
validation, and the dry run do not receive them.

For operational consistency, all eight application runtime values are installed
as encrypted Cloudflare Worker secrets. Five are intentionally returned to the
browser through narrowly scoped application configuration endpoints, but
storing them as Worker secrets prevents deployment from embedding values in
committed Wrangler configuration. This does not make the browser-visible values
private from application users.

## Run read-only preflight

1. Open **Actions** → **Cloudflare private production deployment** → **Run workflow**.
2. Select the repository's default `main` branch.
3. Choose `preflight` and leave the confirmation input empty.
4. Run the workflow and review every result.

Preflight validates the selected commit, locked build, tests, TypeScript,
Wrangler dry run, production readiness gate, exact storage and Worker target,
all runtime formats, the matching operational VAPID P-256 keypair, Cloudflare
account access, existing private Worker state, completed 11-migration D1 ledger,
zero pending migrations, and private R2 configuration. It permits either no
Worker or the exact existing private Worker so it remains safe after a partial
initial rollout. It does not require application tables to be empty and is safe
after pilot data exists.

The exact matched Worker's account-level List Workers route metadata is
validated when Cloudflare reports it: an empty array is accepted and any
reported route is rejected. Missing or null route metadata is treated as
unreported, not as independent proof of account-wide route absence. Public
access remains prevented by the reviewed source and generated configurations
declaring no routes, disabled Workers.dev and preview URLs, disabled Worker
subdomain and previews, and an empty custom-domain result filtered to the exact
Worker. The workflow does not enumerate zones or infer completeness from only
the zones visible to the token.

## Deploy the private Worker

1. Complete and review a successful `preflight` from `main`.
2. Dispatch the workflow again from `main`.
3. Choose `deploy-private`.
4. Enter the exact confirmation phrase:

   `DEPLOY_NIVASA_PRIVATE_WORKER`

5. Run the workflow and review the post-deployment verification.

Immediately before upload, the workflow repeats the branch, commit, target,
configuration, D1 ledger, R2 privacy, and existing Worker public-access checks.
It then uploads only the reviewed `nivasa-home-help` artifact, installs the eight
runtime values with Wrangler's bulk-secret stdin mechanism, and verifies their
names without retrieving their values. A temporary JSON file exists only under
`RUNNER_TEMP`, has mode `0600`, is never printed or uploaded, and is removed by
an `always()` cleanup step.

The operation is safely repeatable when an earlier run created the private
Worker but stopped before installing or verifying every secret. It rejects an
existing Worker with unexpected bindings, secret names, Workers.dev access,
preview URLs, any route metadata that Cloudflare reports, or custom domains.
Missing or null List Workers route metadata remains explicitly unreported;
private accessibility is established through the independent controls above.
Custom-domain absence is checked through Cloudflare's account-level endpoint
filtered to the exact Worker. Worker Versions are read from the endpoint's
documented `result.items` envelope, so an existing private Worker remains
inspectable during partial-deployment recovery.

## Readiness and public access

This rollout intentionally creates no public URL, so the workflow does not make
an HTTP request to `/__nivasa/readiness`. That endpoint will be verified only
after a separately reviewed change enables the intended public hostname.

The committed production configuration must continue to contain
`workers_dev: false`, `preview_urls: false`, and no `routes` entry. Cloudflare
documents that a disabled Workers.dev route can be re-enabled by a later
Wrangler deployment if `workers_dev: false` is removed, so this setting remains
an explicit deployment invariant.

## Rollback without storage rollback

The final verification prints the non-secret Worker version identifier. If the
private deployment must be rolled back, first review the target version and then
run a separately approved command from the exact production configuration:

```bash
npx wrangler rollback <VERSION_ID> --name nivasa-home-help --message "Reviewed private rollback"
```

Cloudflare rollback creates a new deployment that directs Worker traffic to the
selected prior Worker version. It does not restore or reverse D1 schema/data or
R2 objects. Do not delete or recreate D1 or R2 during a Worker rollback, and
re-run the read-only public-access, binding, secret-name, and storage checks
afterward.

## Official references

- [Wrangler deploy, secret bulk, versions, and rollback commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Worker secrets and bulk secret upload](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Workers.dev configuration and disabling public access](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Routes and domains](https://developers.cloudflare.com/workers/configuration/routing/)
- [Worker subdomain and preview URL metadata API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/)
- [Worker version metadata and bindings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/)
- [Worker custom-domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/)
- [Worker rollback behavior](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
