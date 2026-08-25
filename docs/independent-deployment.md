# Nivasa independent deployment checklist

The application is already portable to a Cloudflare account owned by Nivasa. The source uses a Cloudflare Worker, D1, R2, standard environment variables and committed Drizzle migrations. No product rewrite is required.

## Before the external pilot

1. Store the latest source in the Nivasa GitHub repository and protect the main branch.
2. Create a Cloudflare account owned by Nivasa, with billing and recovery contacts controlled by the founder.
3. Create a production D1 database and apply every committed migration in `drizzle/` in order.
4. Create a private R2 bucket for address-proof documents. Do not allow public bucket access.
5. Configure Worker bindings using the existing logical names `DB` and `BUCKET`.
6. Configure production secrets and public configuration:
   - `NIVASA_SESSION_SECRET`
   - `MSG91_AUTH_KEY`
   - `NEXT_PUBLIC_MSG91_WIDGET_ID`
   - `NEXT_PUBLIC_MSG91_WIDGET_TOKEN`
   - `GOOGLE_MAPS_BROWSER_KEY`
   - `VAPID_PRIVATE_JWK`
   - `VAPID_PUBLIC_KEY`
   - `VAPID_SUBJECT`
7. Restrict the Google Maps browser key to the production Nivasa domain and required APIs.
8. Restrict MSG91 configuration to the production domain and retain only required permissions.
9. Deploy through GitHub with separate production secrets; never commit secret values.
10. Connect the Nivasa domain, force HTTPS and verify secure cookies, OTP sign-in, maps and Android push notifications.

## Data ownership and migration

- Export structured pilot data directly from D1 using the Cloudflare dashboard or Wrangler, and import it into the Nivasa-owned D1 database.
- Copy private R2 objects server-to-server and preserve each `r2_object_key` referenced by `verification_documents`.
- Revoke existing sessions after migration so users sign in again on the independent domain.
- Validate record counts for users, profiles, offerings, availability, requests, bookings, visits, payments, issues, consents, notifications and analytics.
- Keep address proofs out of CSV exports and operational analytics.

## Minimum production operations

- Daily D1 export or backup with a documented restore test.
- R2 object retention and deletion policy for address proofs.
- Error logging and alerts for OTP, booking, upload, payment-state and notification failures.
- A privacy request process for data correction and deletion.
- A manual issue-resolution process for safety, misconduct and payment cases.
- A rollback path to the last known-good deployment.

## Launch gate

Run one clean resident-helper lifecycle on the production domain: account creation, helper setup, matching, request hold, acceptance, two paid-trial visits, cancellation/payment handling, issue reporting and notification delivery. Confirm that every screen returns to the same backend-derived booking state after refresh and sign-in, and confirm that an operator can export D1 data outside the customer application.
