export type StoredWindow = { day_of_week: number; start_minute: number; end_minute: number };
export type EditorWindow = { id: string; days: number[]; start: string; end: string };
export const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];

export function formatMinute(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function formatDisplayTime(value: string) {
  const minute = minuteOfDay(value);
  if (minute < 0) return value;
  const hour = Math.floor(minute / 60) % 24;
  return `${hour % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

export function daySummary(days: readonly number[]) {
  const selected = weekdayOrder.filter(day => days.includes(day));
  if (selected.length === 7) return "Every day";
  if (selected.length === 5 && selected.every((day, index) => day === weekdayOrder[index])) return "Weekdays";
  const shortNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return selected.map(day => shortNames[day]).join(", ");
}

export function betaTimeOptions(current: string, includeEnd = false) {
  const options = Array.from({ length: includeEnd ? 49 : 48 }, (_, index) => formatMinute(index * 30));
  if (minuteOfDay(current) >= 0 && !options.includes(current)) options.push(current);
  return options.sort((a, b) => minuteOfDay(a) - minuteOfDay(b));
}

export function minuteOfDay(value: unknown) {
  if (value === "24:00") return 1440;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return -1;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function exactDays(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new RangeError("Invalid weekdays");
  return weekdayOrder.filter(day => value.includes(day));
}

export function validWindow(row: StoredWindow) {
  return Number.isInteger(row.day_of_week) && row.day_of_week >= 0 && row.day_of_week <= 6
    && Number.isInteger(row.start_minute) && Number.isInteger(row.end_minute)
    && row.start_minute >= 0 && row.end_minute <= 1440 && row.end_minute > row.start_minute
    && row.start_minute % 15 === 0 && row.end_minute % 15 === 0;
}

// Group only actual day/time tuples. Legacy labels never determine availability.
export function loadSchedule(rows: StoredWindow[]) {
  if (rows.some(row => !validWindow(row))) {
    return { kind: "invalid" as const, requiresConfirmation: true, windows: [] as EditorWindow[] };
  }
  const groups = new Map<string, EditorWindow>();
  for (const row of rows) {
    const id = `${row.start_minute}:${row.end_minute}`;
    const group = groups.get(id) ?? { id, days: [], start: formatMinute(row.start_minute), end: formatMinute(row.end_minute) };
    group.days = exactDays([...group.days, row.day_of_week]);
    groups.set(id, group);
  }
  const windows = [...groups.values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const kind = windows.length === 0 ? "empty" : windows.length === 1 ? "common" : "heterogeneous";
  return { kind, requiresConfirmation: kind === "heterogeneous", windows };
}

// Checked inside the mutation batch, so a concurrent legacy schedule cannot
// be silently replaced based on a stale pre-read. Preservation does no writes.
export function scheduleWriteGuard(db: D1Database, helperId: string, preserve: boolean, replace: boolean) {
  return db.prepare(`SELECT json(CASE WHEN
    (? AND NOT EXISTS (SELECT 1 FROM availability_slots WHERE helper_user_id = ? AND status = 'open'))
    OR (NOT ? AND NOT ? AND (
      (SELECT count(*) FROM (SELECT DISTINCT start_minute, end_minute FROM availability_slots WHERE helper_user_id = ? AND status = 'open')) > 1
      OR EXISTS (SELECT 1 FROM availability_slots WHERE helper_user_id = ? AND status = 'open' AND (
        typeof(day_of_week) != 'integer' OR day_of_week NOT BETWEEN 0 AND 6
        OR typeof(start_minute) != 'integer' OR typeof(end_minute) != 'integer'
        OR start_minute < 0 OR end_minute > 1440 OR end_minute <= start_minute
        OR start_minute % 15 != 0 OR end_minute % 15 != 0))
    )) THEN 'profile_commitment_conflict' ELSE 'true' END)`)
    .bind(Number(preserve), helperId, Number(preserve), Number(replace), helperId, helperId);
}
