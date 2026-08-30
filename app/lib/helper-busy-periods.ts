import { exactDays, formatMinute, minuteOfDay, validWindow } from "./helper-schedule";

export type BusyPeriod = { days: number[]; start: number; end: number };
export type BusyEditorPeriod = { id: string; days: number[]; start: string; end: string };

export function parseBusyPeriods(value: unknown): BusyPeriod[] {
  if (!Array.isArray(value) || value.length > 28) throw new Error("Add valid recurring busy periods.");
  const periods: BusyPeriod[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Add valid recurring busy periods.");
    const row = item as Record<string, unknown>;
    if (!Object.keys(row).every(key => ["id", "days", "start", "end"].includes(key))) throw new Error("Add valid recurring busy periods.");
    let days: number[];
    try { days = exactDays(row.days); } catch { throw new Error("Choose working days for every busy period."); }
    const start = minuteOfDay(row.start), end = minuteOfDay(row.end);
    if (!validWindow({ day_of_week: days[0], start_minute: start, end_minute: end })) throw new Error("Choose an end time after the start time.");
    periods.push({ days, start, end });
  }
  const expanded = periods.flatMap(period => period.days.map(day => ({ day, start: period.start, end: period.end })));
  for (let first = 0; first < expanded.length; first += 1) for (let second = first + 1; second < expanded.length; second += 1) {
    if (expanded[first].day === expanded[second].day && expanded[first].start < expanded[second].end && expanded[second].start < expanded[first].end) {
      throw new Error("Busy periods cannot overlap on the same day.");
    }
  }
  return periods;
}

export function loadBusyPeriods(rows: Array<{ id: string; day_of_week: number; start_minute: number; end_minute: number }>): BusyEditorPeriod[] {
  const groups = new Map<string, BusyEditorPeriod>();
  for (const row of rows) {
    const key = `${row.start_minute}:${row.end_minute}`;
    const group = groups.get(key) ?? { id: row.id, days: [], start: formatMinute(row.start_minute), end: formatMinute(row.end_minute) };
    group.days = exactDays([...group.days, row.day_of_week]);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function saveBusyPeriods(db: D1Database, helperId: string, periods: BusyPeriod[]) {
  const desired = periods.flatMap(period => period.days.map(day => ({ day, start: period.start, end: period.end })));
  const json = JSON.stringify(desired);
  const statements = [
    db.prepare(`SELECT json(CASE WHEN EXISTS (
      SELECT 1 FROM json_each(?) p WHERE NOT EXISTS (
        SELECT 1 FROM availability_slots a WHERE a.helper_user_id=? AND a.status='open'
          AND a.day_of_week=json_extract(p.value,'$.day')
          AND a.start_minute<=json_extract(p.value,'$.start') AND a.end_minute>=json_extract(p.value,'$.end')
      )
    ) THEN 'busy_outside_working_hours' ELSE 'true' END)`).bind(json, helperId),
    db.prepare(`WITH commitments AS (
      SELECT rs.day_of_week day,rs.start_minute start,rs.end_minute end FROM request_slots rs JOIN booking_requests br ON br.id=rs.request_id
        WHERE br.helper_user_id=? AND br.status='pending' AND julianday(br.response_due_at)>julianday('now')
      UNION ALL SELECT bs.day_of_week,bs.start_minute,bs.end_minute FROM booking_slots bs JOIN bookings b ON b.id=bs.booking_id
        WHERE b.helper_user_id=? AND b.status IN ('trial','active','ending'))
      SELECT json(CASE WHEN EXISTS (SELECT 1 FROM commitments c JOIN json_each(?) p
        WHERE c.day=json_extract(p.value,'$.day') AND json_extract(p.value,'$.start')<c.end+15 AND c.start<json_extract(p.value,'$.end')+15)
        THEN 'busy_commitment_conflict' ELSE 'true' END)`).bind(helperId, helperId, json),
    db.prepare("UPDATE external_busy_periods SET status='inactive',updated_at=CURRENT_TIMESTAMP WHERE helper_user_id=? AND status='active'").bind(helperId),
  ];
  for (const item of desired) statements.push(
    db.prepare(`UPDATE external_busy_periods SET status='active',updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT id FROM external_busy_periods
      WHERE helper_user_id=? AND day_of_week=? AND start_minute=? AND end_minute=? AND status='inactive' ORDER BY created_at,id LIMIT 1)`)
      .bind(helperId, item.day, item.start, item.end),
    db.prepare(`INSERT INTO external_busy_periods(id,helper_user_id,day_of_week,start_minute,end_minute,status)
      SELECT ?,?,?,?,?, 'active' WHERE NOT EXISTS (SELECT 1 FROM external_busy_periods WHERE helper_user_id=? AND day_of_week=? AND start_minute=? AND end_minute=? AND status='active')`)
      .bind(crypto.randomUUID(), helperId, item.day, item.start, item.end, helperId, item.day, item.start, item.end),
  );
  return statements;
}
