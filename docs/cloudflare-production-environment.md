# Cloudflare production environment

The independent Cloudflare deployment uses `wrangler.jsonc`. Secret values must
be configured in Cloudflare and must never be committed, placed in Wrangler
`vars`, or copied from the existing Sites deployment. This document names the
required runtime configuration without containing any values.

## Secrets

| Name | Required | Purpose |
| --- | --- | --- |
| `NIVASA_SESSION_SECRET` | Yes | HMAC key for Nivasa session tokens. |
| `MSG91_AUTH_KEY` | Yes | Server-side MSG91 API authentication. |
| `VAPID_PRIVATE_JWK` | For web push | Private VAPID signing key in JWK form. |

## Non-secret configuration

These values are exposed to the browser or are identifiers rather than
credentials. Configure them as Worker variables in the production environment.

| Name | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_MSG91_WIDGET_ID` | Yes | MSG91 browser widget identifier. |
| `NEXT_PUBLIC_MSG91_WIDGET_TOKEN` | Yes | Browser-delivered MSG91 widget token. It is intentionally returned by the public configuration endpoint and must be restricted in MSG91. |
| `GOOGLE_MAPS_BROWSER_KEY` | Yes | Browser-delivered Google Maps key. Restrict it to the production domain and required APIs. |
| `VAPID_PUBLIC_KEY` | For web push | Public VAPID application-server key returned to browsers. |
| `VAPID_SUBJECT` | For web push | VAPID contact subject, such as a controlled `mailto:` URI. |
| `MSG91_SENDER_ID` | Optional | MSG91 sender identifier for booking notifications. |
| `MSG91_NEW_REQUEST_FLOW_ID` | Optional | MSG91 flow identifier for a new booking request. |
| `MSG91_BOOKING_ACCEPTED_FLOW_ID` | Optional | MSG91 flow identifier for an accepted booking. |
| `MSG91_BOOKING_DECLINED_FLOW_ID` | Optional | MSG91 flow identifier for a declined booking. |

## Cloudflare bindings

Bindings are configured in `wrangler.jsonc`; they are not environment-variable
values and do not require API credentials in application code.

| Binding | Cloudflare resource | Purpose |
| --- | --- | --- |
| `DB` | D1 `nivasa-production` | Structured application data. |
| `BUCKET` | Private R2 bucket `nivasa-private-address-proofs` | Address-proof objects. Do not enable a custom domain or `r2.dev` URL. |
| `ASSETS` | Generated `dist/client` static assets | Vinext static asset fetcher. |
| `IMAGES` | Cloudflare Images binding | Vinext image optimization. |

## Deployment safety

- `npm run build` remains the Sites-compatible build and retains the logical
  bindings from `.openai/hosting.json`. Its local-only Wrangler base is
  `build/wrangler.sites.jsonc`, which prevents production resource identifiers
  from entering the Sites artifact.
- `npm run build:production` explicitly selects `wrangler.jsonc` for the
  independent Cloudflare artifact.
- `npm run cloudflare:deploy:dry-run` builds and validates without uploading.
- `npm run cloudflare:d1:migrations:list` reads pending production migrations.
- `npm run cloudflare:d1:migrations:apply` changes production data and must be
  run only during an explicitly approved migration window.
- `npm run cloudflare:deploy` performs a real Worker deployment and must be run
  only after an explicitly approved release.

The compatibility date is `2026-08-25`. Cloudflare enables Node.js
compatibility by default for compatibility dates on or after `2026-08-04`, but
the installed Cloudflare Vite plugin still validates Vinext's Node.js imports
against an explicit flag. `wrangler.jsonc` therefore includes
`nodejs_compat` so local build validation and the production runtime agree.
