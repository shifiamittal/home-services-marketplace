# Guarded Cloudflare public production deployment

The **Cloudflare production deployment** workflow is manual-only. It performs a
read-only `preflight` or a guarded `deploy-public` of the existing
`nivasa-home-help` Worker. Public access is limited to:

`https://nivasa-home-help.nivasa-app.workers.dev`

The workflow has no push, pull-request, schedule, or deployment trigger. It
never applies D1 migrations, changes D1 records, writes R2 objects, creates or
changes routes or custom domains, enables preview URLs, deletes the Worker, or
installs or changes Worker secrets.

The job is bound to the protected GitHub Environment named exactly
`production`, whose deployment branch policy must permit only `main`. Dispatch
the workflow only with `main` selected. A non-main dispatch skips the entire job
before environment secrets are made available.

## Required production state

Store `CLOUDFLARE_API_TOKEN` only as a `production` environment secret. Do not
add a repository-level fallback. The token is scoped only to authenticated
Cloudflare inspection and deployment steps; checkout, dependency installation,
builds, tests, static validation, and the Wrangler dry run do not receive it.

The existing Worker must already contain exactly these eight encrypted secret
names:

- `NIVASA_SESSION_SECRET`
- `MSG91_AUTH_KEY`
- `NEXT_PUBLIC_MSG91_WIDGET_ID`
- `NEXT_PUBLIC_MSG91_WIDGET_TOKEN`
- `GOOGLE_MAPS_BROWSER_KEY`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_JWK`
- `VAPID_SUBJECT`

This workflow checks only the secret-name set. It never retrieves, prints,
rewrites, or passes their values. Five settings are intentionally returned to
the browser through narrowly scoped application configuration endpoints, but
their storage as Worker secrets prevents them from being embedded in committed
Wrangler configuration. This does not make browser-visible configuration
private from application users.

Before public launch, provider dashboards must permit the production hostname
where applicable: MSG91 widget allowed domains, Google Maps browser-key HTTP
referrers, and any push-provider origin restrictions must include
`https://nivasa-home-help.nivasa-app.workers.dev`.

## Run read-only preflight

1. Open **Actions** → **Cloudflare production deployment** → **Run workflow**.
2. Select the repository's default `main` branch.
3. Choose `preflight` and leave the confirmation input empty.
4. Run the workflow and review every result.

Preflight validates the selected commit, locked production build, tests,
TypeScript, credential-free Wrangler dry run, exact source and generated
configuration, artifact hashes, exact Cloudflare account and resource targets,
the existing Worker and all four bindings, the exact eight Worker secret names,
the completed 11-entry D1 migration ledger with zero pending migrations, and
private R2 configuration. It accepts the reviewed Worker in either its current
private state or an already-public, otherwise exact state so a successful
deployment can be inspected and repeated safely. It does not require
application tables to be empty and is safe after pilot data exists.

The exact matched Worker's account-level List Workers route metadata is checked
when Cloudflare reports it: an empty array is accepted and any reported route is
rejected. Missing or null route metadata is treated only as unreported. Route
absence is instead enforced by the reviewed source and generated configuration,
which contain no `route` or `routes` entry, together with the absence of any
route-creation command. The exact service-filtered custom-domain result must be
empty. Preview URLs must remain disabled. No zone enumeration is required.

## Deploy publicly on Workers.dev

1. Complete and review a successful `preflight` from `main`.
2. Confirm provider-domain restrictions are ready for the production hostname.
3. Dispatch the workflow again from `main`.
4. Choose `deploy-public`.
5. Enter the exact confirmation phrase:

   `DEPLOY_NIVASA_PUBLIC_WORKER`

6. Run the workflow and review the final verification.

Immediately before deployment, the workflow repeats the branch, commit, exact
target, configuration and artifact hashes, D1 ledger and pending state, R2
privacy, Worker bindings, secret-name set, route metadata and exact
custom-domain checks. It deploys the reviewed artifact with
`wrangler deploy --strict`. The committed and generated configuration require
`workers_dev: true`, `preview_urls: false`, and no routes or custom domains.

The workflow does not reinstall the eight existing secrets. If any required
name is missing or unexpected, it stops before deployment. After deployment it
requires Workers.dev to be enabled, preview URLs to be disabled, the filtered
custom-domain result to remain empty, every reported route list to be empty,
the exact four bindings and eight secret names to remain present, a usable
Worker version, the exact D1 migration state, and private R2 storage. The final
URL is derived from the exact Worker name and Cloudflare's authenticated live
account namespace, which must equal `nivasa-app`. The account-subdomain GET is
validated during preflight, fresh pre-deployment inspection, and final
verification. Missing, malformed or different namespace metadata fails closed;
the derived URL must equal the exact reviewed HTTPS hostname above.

The operation supports recovery from a prior public deployment whose upload
succeeded but whose final verification was interrupted. The fresh inspection
must still prove the complete reviewed state before another deployment can run.

## Readiness and end-to-end verification

After a successful public deployment, verify:

- `GET https://nivasa-home-help.nivasa-app.workers.dev/__nivasa/readiness`
  returns HTTP 200 and only `{"ready":true}`;
- the public hostname serves the expected application and static assets;
- OTP login works with an authorized test phone and MSG91 accepts the hostname;
- Google Maps/Places loads under the production referrer restriction;
- session creation, logout, same-origin requests, cookies and redirects remain
  on the Workers.dev origin;
- push subscription and service-worker scope work on the Workers.dev origin;
- an address-proof upload made with an approved test account is retrievable only
  through the authenticated application path and the R2 bucket remains private.

These application checks can create controlled test records or objects and are
therefore deliberately outside this deployment workflow. Review and clean up
test data through separately authorized application procedures.

## Disable public access without deleting storage

This workflow does not provide an emergency public-access mutation outside its
reviewed deployment path. To disable Workers.dev, prepare and review a separate
change that restores `workers_dev: false` while retaining
`preview_urls: false`, no routes, no custom domain, the same Worker name and the
same D1/R2 bindings. Deploy that reviewed configuration through a separately
approved guarded operation and verify the Worker subdomain is disabled.

Do not delete the Worker, remove its secrets, recreate D1 or R2, reverse
migrations, or delete production data as part of an access rollback. Disabling
Workers.dev changes reachability only; D1 and private R2 remain attached and
unchanged.

## Official references

- [Wrangler deploy and versions commands](https://developers.cloudflare.com/workers/wrangler/commands/)
- [Workers.dev configuration](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Routes and domains](https://developers.cloudflare.com/workers/configuration/routing/)
- [Worker subdomain and preview URL metadata API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/)
- [Worker version metadata and bindings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/)
- [Worker custom-domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/)
