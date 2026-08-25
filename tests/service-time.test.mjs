import assert from "node:assert/strict";
import test from "node:test";

import {
  indiaLocalDateMinuteToUtcMs,
  mayCompleteServiceDay,
  serviceCompletionAvailableAt,
} from "../app/lib/service-time.ts";

test("converts an India-local service end time to the correct instant", () => {
  const endMinute = 8 * 60 + 30;
  assert.equal(
    serviceCompletionAvailableAt("2026-08-25T08:00:00.000Z", endMinute),
    "2026-08-25T03:00:00.000Z",
  );
  assert.equal(
    indiaLocalDateMinuteToUtcMs("2026-08-25", endMinute),
    Date.parse("2026-08-25T03:00:00.000Z"),
  );
});

test("does not allow completion before the final visit ends", () => {
  const scheduledFor = "2026-08-25T08:00:00.000Z";
  const endMinute = 8 * 60 + 30;
  assert.equal(mayCompleteServiceDay(scheduledFor, endMinute, Date.parse("2026-08-24T20:16:00.000Z")), false);
  assert.equal(mayCompleteServiceDay(scheduledFor, endMinute, Date.parse("2026-08-25T02:59:59.999Z")), false);
  assert.equal(mayCompleteServiceDay(scheduledFor, endMinute, Date.parse("2026-08-25T03:00:00.000Z")), true);
});
