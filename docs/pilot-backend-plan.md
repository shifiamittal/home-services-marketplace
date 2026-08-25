# Nivasa Pilot Backend Plan

## Decision

The pilot has no administrator interface. Verification decisions and issue resolutions are operational records maintained in the backend. Resident and home-helper issue reporting remains part of the product.

## Production architecture

- **Web application and APIs:** Cloudflare Worker/Vinext
- **Structured records:** Cloudflare D1
- **Private address-proof uploads:** Cloudflare R2
- **Authentication:** Indian mobile OTP provider behind a provider adapter
- **User session:** Secure, HttpOnly, SameSite cookie backed by a hashed server-side session record
- **Notifications:** Transactional SMS for OTP and booking lifecycle events
- **Offline analysis:** Bounded CSV exports generated from D1; no analytics dashboard in the pilot

## Authoritative records

The initial schema records:

- users, roles and sessions;
- resident profiles and private addresses;
- home-helper profiles, address-proof metadata, listed packages and availability;
- booking requests and every held recurring slot;
- accepted bookings, recurring slots, trial visits and booking-status history;
- resident and home-helper issues plus resolution history;
- reviews and consent versions;
- behavioral analytics events; and
- notification-delivery history.

Uploaded proof bytes live only in the private R2 bucket. D1 stores a random object key and non-sensitive metadata. Documents are never served through a public object URL.

## Booking integrity rules

1. A pending request holds all requested slots in one transaction for 24 hours.
2. A twice-daily request succeeds only if both recurring slots can be held for the same home helper.
3. Accepting converts every held slot into one confirmed booking atomically.
4. Declining, withdrawing or expiring releases every held slot.
5. The first two scheduled service visits are marked as paid-trial visits.
6. Cancelling during the trial releases future slots after completed work is recorded.
7. Continuing after the trial keeps the booking active through its 30-day cycle.

## Issue operations without an administrator UI

Every submitted issue receives a case number and stores the booking, reporter, reported user, category, description and timestamp. Internal review updates its status, resolution note and status history. No automated penalty or ranking change is applied during the pilot.

## Verification operations without an administrator UI

The home helper uploads an address proof. The private file and a pending “provided” record are created together. The pilot may activate a complete helper profile once a structurally valid private document exists, but residents see only “Address proof provided”; this is not presented as identity verification. A future authorization-gated review workflow may separately record `verified` or `rejected`.

## Post-beta scaling item

The pilot matching route currently loads active helpers, offerings, availability, reviews, and busy times into the Worker before ranking. Keep the controlled-beta population bounded. Before broader launch, move service, geographic, and availability prefiltering into indexed D1 queries, cap the candidate set, and paginate results.

## Pilot analytics events

At minimum, record:

- `otp_requested`, `otp_verified`, `signup_completed`;
- `helper_setup_started`, `helper_setup_submitted`, `helper_verified`;
- `requirement_created`, `matches_viewed`, `helper_profile_viewed`;
- `request_sent`, `request_withdrawn`, `request_accepted`, `request_declined`, `request_expired`;
- `booking_confirmed`, `trial_visit_completed`, `trial_cancelled`, `trial_completed`, `booking_continued`, `booking_cancelled`;
- `issue_submitted`, `review_submitted`; and
- notification delivery or failure.

Analytics properties must use internal IDs and product attributes. They must not contain mobile numbers, exact addresses, proof filenames, document numbers or free-text issue descriptions.

## Offline exports

Provide four owner-only exports:

1. **Supply:** helpers, verification status, packages, prices and open slots.
2. **Funnel:** account creation through booking confirmation by event and date.
3. **Marketplace:** requests, response time, acceptance, expiry, bookings and cancellations.
4. **Operations:** trial visits, issues, current status and resolution time.

## Implementation sequence

1. Deploy and migrate D1/R2 resources.
2. Add server-side data-access helpers and session middleware.
3. Connect real OTP request/verification and account creation.
4. Persist resident and home-helper onboarding, including private uploads.
5. Implement transactional slot matching, holds, acceptance and expiry.
6. Persist issue reporting, reviews and behavioral events.
7. Add transactional SMS and owner-only CSV exports.
8. Run privacy, authorization, concurrency and mobile acceptance tests before public beta.

## Deferred until after the pilot

- Administrator and analytics dashboards
- Platform membership payment
- Monthly home-helper compensation collection and commission
- Automated rematching, leave replacement or reliability penalties
- WhatsApp messaging
- Machine-learning matching
