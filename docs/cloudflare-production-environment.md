# Cloudflare production environment

The independent Cloudflare deployment uses `wrangler.jsonc`. Secret values must
be configured in Cloudflare and must never be committed, placed in Wrangler
`vars`, or copied from the existing Sites deployment. This document names the
required runtime configuration without containing any values.

## Secrets

| Name | Required | Source | Safe format | Purpose |
| --- | --- | --- | --- | --- |
| `NIVASA_SESSION_SECRET` | Yes | Generate locally with a cryptographically secure random generator | At least 32 random bytes encoded as 64 or more hexadecimal characters, or unpadded base64url | HMAC key for Nivasa session tokens. Never reuse a Sites value. |
| `MSG91_AUTH_KEY` | Yes | MSG91 dashboard | Non-empty opaque provider credential | Server-side MSG91 API authentication. |
| `VAPID_PRIVATE_JWK` | Yes | Generate locally as part of the production VAPID P-256 keypair | JSON object with `kty: "EC"`, `crv: "P-256"`, and 32-byte base64url `x`, `y`, and private `d` fields | Private web-push signing key. Keep the complete JWK secret; readiness verifies that it matches `VAPID_PUBLIC_KEY` and can sign. |

## Non-secret configuration

These values are exposed to the browser or are identifiers rather than
credentials. Configure them as Worker variables in the production environment.

| Name | Required | Source | Safe format and exposure | Purpose |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_MSG91_WIDGET_ID` | Yes | MSG91 widget configuration | Non-empty opaque identifier; intentionally browser-visible | MSG91 browser widget identifier. |
| `NEXT_PUBLIC_MSG91_WIDGET_TOKEN` | Yes | MSG91 widget configuration | Non-empty opaque widget token; intentionally browser-visible and restricted to the production origin in MSG91 | Browser widget authorization. This is not the private `MSG91_AUTH_KEY`. |
| `GOOGLE_MAPS_BROWSER_KEY` | Yes | Google Cloud console | Non-empty browser API key; intentionally browser-visible and restricted to the production HTTPS referrer and required Maps/Places APIs | Google Maps JavaScript and Places address search. |
| `VAPID_PUBLIC_KEY` | Yes | Public half of the locally generated production VAPID keypair | Unpadded base64url encoding of a 65-byte uncompressed P-256 public point beginning with byte `04`; intentionally browser-visible | Push subscription application-server key; readiness verifies its coordinates and a signature from the private key. |
| `VAPID_SUBJECT` | Yes | Application configuration | Controlled `mailto:` contact or credential-free HTTPS URI | VAPID administrator contact supplied to push services. |
| `MSG91_SENDER_ID` | Optional | MSG91/DLT configuration | Opaque identifier; not browser-exposed | Reserved for booking SMS notifications, whose sender is not currently invoked. |
| `MSG91_NEW_REQUEST_FLOW_ID` | Optional | MSG91 flow configuration | Opaque identifier; not browser-exposed | Reserved for the currently dormant booking SMS helper. |
| `MSG91_BOOKING_ACCEPTED_FLOW_ID` | Optional | MSG91 flow configuration | Opaque identifier; not browser-exposed | Reserved for the currently dormant booking SMS helper. |
| `MSG91_BOOKING_DECLINED_FLOW_ID` | Optional | MSG91 flow configuration | Opaque identifier; not browser-exposed | Reserved for the currently dormant booking SMS helper. |

## Cloudflare bindings

Bindings are configured in `wrangler.jsonc`; they are not environment-variable
values and do not require API credentials in application code.

| Binding | Cloudflare resource | Purpose |
| --- | --- | --- |
| `DB` | D1 `nivasa-production` | Structured application data. |
| `BUCKET` | Private R2 bucket `nivasa-private-address-proofs` | Address-proof objects. Do not enable a custom domain or `r2.dev` URL. |
| `ASSETS` | Generated `dist/client` static assets | Vinext static asset fetcher. |
| `IMAGES` | Cloudflare Images binding | Vinext image optimization. |

The eight settings marked required and all four bindings are validated only in
the independent Cloudflare production artifact. Every production request fails
with a generic `503` and `{ "ready": false }` when the configuration is
incomplete. A deployment verifier may request `/__nivasa/readiness`; it returns
only the boolean readiness state and never identifies an absent binding,
variable or secret. The normal local and ChatGPT Sites builds do not enable
this gate.

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
