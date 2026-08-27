export type ProfileWindow = { day: number; start: number; end: number; pattern: string };

// Evaluated INSIDE the save batch, not just in a pre-read. Concurrent request
// creation is serialized with this check and has its own fresh-window guard.
export function commitmentGuard(db: D1Database, helperId: string, windows: ProfileWindow[]) {
  return db.prepare(`
    WITH commitments AS (
      SELECT rs.day_of_week AS day, rs.start_minute AS start, rs.end_minute AS end
      FROM request_slots rs JOIN booking_requests br ON br.id = rs.request_id
      WHERE br.helper_user_id = ? AND br.status = 'pending'
        AND julianday(br.response_due_at) > julianday('now')
      UNION ALL
      SELECT bs.day_of_week, bs.start_minute, bs.end_minute
      FROM booking_slots bs JOIN bookings b ON b.id = bs.booking_id
      WHERE b.helper_user_id = ? AND b.status IN ('trial', 'active', 'ending')
    )
    SELECT json(CASE WHEN EXISTS (
      SELECT 1 FROM commitments c WHERE NOT EXISTS (
        SELECT 1 FROM json_each(?) w
        WHERE json_extract(w.value, '$.day') = c.day
          AND json_extract(w.value, '$.start') <= c.start
          AND json_extract(w.value, '$.end') >= c.end
      )
    ) THEN 'profile_commitment_conflict' ELSE 'true' END)
  `).bind(helperId, helperId, JSON.stringify(windows));
}

export function saveAvailability(db: D1Database, helperId: string, windows: ProfileWindow[]) {
  const statements = [
    commitmentGuard(db, helperId, windows),
    // Never delete: historical request/booking foreign keys remain valid.
    db.prepare("UPDATE availability_slots SET status = 'inactive' WHERE helper_user_id = ? AND status = 'open'").bind(helperId),
  ];
  for (const window of windows) {
    const group = `${window.pattern}:${window.start}:${window.end}`;
    statements.push(
      db.prepare(`UPDATE availability_slots SET status = 'open', source_group_id = ?, day_pattern = ?
        WHERE id = (SELECT id FROM availability_slots WHERE helper_user_id = ?
          AND day_of_week = ? AND start_minute = ? AND end_minute = ?
          AND status = 'inactive' ORDER BY created_at, id LIMIT 1)`)
        .bind(group, window.pattern, helperId, window.day, window.start, window.end),
      db.prepare(`INSERT INTO availability_slots
        (id, helper_user_id, source_group_id, day_pattern, day_of_week, start_minute, end_minute, buffer_minutes, status)
        SELECT ?, ?, ?, ?, ?, ?, ?, 15, 'open'
        WHERE NOT EXISTS (SELECT 1 FROM availability_slots WHERE helper_user_id = ?
          AND day_of_week = ? AND start_minute = ? AND end_minute = ? AND status = 'open')`)
        .bind(crypto.randomUUID(), helperId, group, window.pattern, window.day, window.start, window.end,
          helperId, window.day, window.start, window.end),
    );
  }
  return statements;
}
