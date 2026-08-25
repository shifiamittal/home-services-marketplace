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

const expiryCandidates = `
  SELECT id FROM booking_requests
  WHERE status = 'pending' AND response_due_at <= ?
  ORDER BY response_due_at ASC, created_at ASC, id ASC
  LIMIT ?
`;

export function pendingExpiryStatements(db: D1Database, cutoff: string) {
  return [
    db.prepare(
      `WITH expiry_candidates AS (${expiryCandidates})
       INSERT INTO workflow_transitions (id, entity_type, entity_id, from_state, to_state, actor_user_id)
       SELECT 'booking-request-expired:' || id, 'booking_request', id, 'pending', 'expired', NULL
       FROM expiry_candidates`,
    ).bind(cutoff, PENDING_EXPIRY_BATCH_LIMIT),
    db.prepare(
      `WITH expiry_candidates AS (${expiryCandidates})
       DELETE FROM slot_claims
       WHERE booking_id IS NULL AND request_id IN (SELECT id FROM expiry_candidates)`,
    ).bind(cutoff, PENDING_EXPIRY_BATCH_LIMIT),
    db.prepare(
      `WITH expiry_candidates AS (${expiryCandidates})
       UPDATE booking_requests SET status = 'expired', updated_at = CURRENT_TIMESTAMP
       WHERE status = 'pending' AND id IN (SELECT id FROM expiry_candidates)`,
    ).bind(cutoff, PENDING_EXPIRY_BATCH_LIMIT),
  ];
}

export async function expirePendingRequests(db: D1Database) {
  const cutoff = new Date().toISOString();
  await db.batch(pendingExpiryStatements(db, cutoff));
}
