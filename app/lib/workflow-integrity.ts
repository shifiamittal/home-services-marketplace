export type ClaimSlot = { dayOfWeek: number; start: number; end: number };

export function isUniqueConstraintError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|constraint failed|SQLITE_CONSTRAINT/i.test(message);
}

export function transitionGuard(
  db: D1Database,
  entityType: string,
  entityId: string,
  fromState: string,
  toState: string,
  actorUserId: string | null,
) {
  return db.prepare(
    `INSERT INTO workflow_transitions (id, entity_type, entity_id, from_state, to_state, actor_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), entityType, entityId, fromState, toState, actorUserId);
}

export function claimMinutes(slots: ClaimSlot[]) {
  const claims: Array<{ day: number; minute: number }> = [];
  const seen = new Set<string>();
  for (const slot of slots) {
    for (let minute = slot.start; minute < slot.end + 15; minute += 1) {
      const day = (slot.dayOfWeek + Math.floor(minute / 1_440)) % 7;
      const minuteOfDay = minute % 1_440;
      const key = `${day}:${minuteOfDay}`;
      if (seen.has(key)) throw new Error("Requested service times overlap after the required travel buffer.");
      seen.add(key);
      claims.push({ day, minute: minuteOfDay });
    }
  }
  return claims;
}

export function insertSlotClaims(
  db: D1Database,
  helperUserId: string,
  requestId: string,
  slots: ClaimSlot[],
) {
  const claims = claimMinutes(slots);
  return db.prepare(
    `INSERT INTO slot_claims (id, helper_user_id, day_of_week, minute_of_day, request_id)
     SELECT ? || ':' || json_extract(value, '$.day') || ':' || json_extract(value, '$.minute'),
            ?, json_extract(value, '$.day'), json_extract(value, '$.minute'), ?
     FROM json_each(?)`,
  ).bind(requestId, helperUserId, requestId, JSON.stringify(claims));
}

export const PENDING_EXPIRY_BATCH_LIMIT = 50;

/** SQL expression for stored ISO/SQLite timestamps. Bare numbers, invalid
 * calendar dates and malformed times fail closed. Zone-less SQLite values
 * are UTC; offsets and millisecond fractions are handled by SQLite.
 * column is a trusted SQL identifier, never request data.
 */
export function deadlineInstant(column: string) {
  return `CASE WHEN typeof(${column}) = 'text'
    AND substr(${column}, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(substr(${column}, 1, 10), '+0 days') = substr(${column}, 1, 10)
    AND substr(${column}, 11, 1) IN ('T', ' ')
    AND substr(${column}, 12, 8) GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]'
    AND substr(${column}, 12, 2) <= '23'
    THEN julianday(${column}) END`;
}

const expiryCandidates = `
  SELECT id FROM booking_requests
  WHERE status = 'pending' AND NOT COALESCE(${deadlineInstant("response_due_at")} > julianday(?), 0)
  ORDER BY ${deadlineInstant("response_due_at")} ASC, created_at ASC, id ASC
  LIMIT ?
`;

export function pendingExpiryStatements(db: D1Database, cutoff: string, residentId?: string) {
  const candidates = residentId === undefined ? expiryCandidates
    : expiryCandidates.replace("WHERE status", "WHERE resident_user_id = ? AND status");
  const parameters = residentId === undefined ? [cutoff, PENDING_EXPIRY_BATCH_LIMIT]
    : [residentId, cutoff, PENDING_EXPIRY_BATCH_LIMIT];
  return [
    db.prepare(
      `WITH expiry_candidates AS (${candidates})
       INSERT INTO workflow_transitions (id, entity_type, entity_id, from_state, to_state, actor_user_id)
       SELECT 'booking-request-expired:' || id, 'booking_request', id, 'pending', 'expired', NULL
       FROM expiry_candidates`,
    ).bind(...parameters),
    db.prepare(
      `WITH expiry_candidates AS (${candidates})
       DELETE FROM slot_claims
       WHERE booking_id IS NULL AND request_id IN (SELECT id FROM expiry_candidates)`,
    ).bind(...parameters),
    db.prepare(
      `WITH expiry_candidates AS (${candidates})
       UPDATE booking_requests SET status = 'expired', updated_at = CURRENT_TIMESTAMP
       WHERE status = 'pending' AND id IN (SELECT id FROM expiry_candidates)`,
    ).bind(...parameters),
  ];
}

export async function expirePendingRequests(db: D1Database, cutoff = new Date().toISOString(), residentId?: string) {
  await db.batch(pendingExpiryStatements(db, cutoff, residentId));
}

// Canonical new-work eligibility; callers join helper_profiles hp to users u.
// Verification badges are separate from the existing active-profile policy.
export const ELIGIBLE_HELPER_SQL = "hp.profile_status = 'active' AND u.status = 'active'";
