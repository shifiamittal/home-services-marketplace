const INDIA_OFFSET_MINUTES = 330;

export function indiaLocalDateMinuteToUtcMs(localDate: string, minuteOfDay: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1_440) {
    throw new Error("Invalid local service time.");
  }
  const [year, month, day] = localDate.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 0, 0)
    - INDIA_OFFSET_MINUTES * 60 * 1_000
    + minuteOfDay * 60 * 1_000;
}

export function serviceCompletionAvailableAt(scheduledFor: string, finalEndMinute: number) {
  return new Date(indiaLocalDateMinuteToUtcMs(scheduledFor.slice(0, 10), finalEndMinute)).toISOString();
}

export function mayCompleteServiceDay(scheduledFor: string, finalEndMinute: number, nowMs = Date.now()) {
  return nowMs >= indiaLocalDateMinuteToUtcMs(scheduledFor.slice(0, 10), finalEndMinute);
}
