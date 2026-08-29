import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixture, jsonRequest, profilePayload, referenceSlot } from "./helpers/local-routes.mjs";
import { exactDays, loadSchedule, weekdayOrder } from "../app/lib/helper-schedule.ts";

const route = "app/api/helper/profile/route.ts";
function setup(t) {
  const f = fixture(); t.after(() => f.sql.close());
  f.add = (id, day, start = 480, end = 840, pattern = null, status = "open") => f.sql.prepare(`INSERT INTO availability_slots
    (id,helper_user_id,day_of_week,start_minute,end_minute,day_pattern,status) VALUES (?,'helper',?,?,?,?,?)`).run(id, day, start, end, pattern, status);
  f.get = async () => (await f.load(route).GET(new Request("https://example.test/api"))).json();
  f.save = (extra = {}) => { const { availability: unused, ...payload } = profilePayload; void unused; return f.load(route).PUT(jsonRequest({ ...payload, ...extra })); };
  f.rows = () => f.sql.prepare("SELECT * FROM availability_slots ORDER BY id").all();
  return f;
}

for (const days of [[3], ...weekdayOrder.filter(day => day !== 3).map(day => [day]), [1, 0], [2, 4, 6], [1, 3, 5, 0]]) {
  test(`exact stored weekdays ${days} survive load/save/load without expansion`, async t => {
    const f = setup(t);
    days.forEach(day => f.add(`day-${day}`, day));
    const loaded = await f.get();
    assert.equal(loaded.schedule.kind, "common");
    assert.deepEqual(loaded.availability[0].days, days);
    assert.equal(loaded.availability[0].start, "08:00");
    assert.equal(loaded.availability[0].end, "14:00");
    assert.equal((await f.save({ availability: loaded.availability })).status, 200);
    assert.deepEqual((await f.get()).schedule, loaded.schedule);
    assert.deepEqual(f.sql.prepare("SELECT DISTINCT day_of_week FROM availability_slots WHERE status='open'").all().map(row => row.day_of_week).sort(), [...days].sort());
  });
}

test("all 127 nonempty subsets retain actual weekdays in Monday–Sunday output order", () => {
  for (let mask = 1; mask < 128; mask++) {
    const days = weekdayOrder.filter((_, index) => mask & (1 << index));
    const schedule = loadSchedule(days.map(day => ({ day_of_week: day, start_minute: 15, end_minute: 1440 })));
    assert.deepEqual(schedule.windows[0].days, days);
    assert.equal(schedule.windows[0].start, "00:15");
    assert.equal(schedule.windows[0].end, "24:00");
  }
});

test("null, empty, malformed and contradictory metadata never override stored weekdays", async t => {
  const f = setup(t);
  [null, "", "invalid", "every_day", "mon_sat", "{}"].forEach((pattern, index) => f.add(`duplicate-${index}`, 0, 480, 840, pattern));
  f.add("retired", 1, 480, 840, "mon_fri", "inactive");
  const loaded = await f.get();
  assert.deepEqual(loaded.availability[0].days, [0]);
  assert.equal(loaded.availability.length, 1);
  assert.equal((await f.save({ availability: loaded.availability })).status, 200);
  assert.deepEqual((await f.get()).schedule, loaded.schedule);
  assert.equal(f.rows().length, 7);
});

test("heterogeneous legacy hours remain byte-for-byte unchanged by unrelated saves", async t => {
  const f = setup(t); f.add("wed", 3); f.add("sun", 0, 600, 900);
  const loaded = await f.get();
  assert.equal(loaded.schedule.kind, "heterogeneous");
  assert.equal(loaded.schedule.requiresConfirmation, true);
  assert.deepEqual(loaded.availability, []);
  assert.equal(loaded.schedule.windows.length, 2);
  const before = f.rows();
  assert.equal((await f.save({ yearsExperience: 7 })).status, 200);
  assert.deepEqual(f.rows(), before);
  const replacement = [{ days: [3, 0], start: "08:00", end: "15:00" }];
  assert.equal((await f.save({ availability: replacement })).status, 409);
  assert.deepEqual(f.rows(), before);
  assert.equal((await f.save({ availability: replacement, replaceSchedule: true })).status, 200);
  assert.deepEqual((await f.get()).availability[0].days, [3, 0]);
  assert.ok(f.rows().some(row => row.id === "wed" && row.status === "inactive"));
});

test("a concurrent heterogeneous schedule cannot bypass replacement confirmation", async t => {
  const f = setup(t); f.add("wed", 3);
  const loaded = await f.get();
  f.db.beforeBatch = () => f.add("sun", 0, 600, 900);
  const response = await f.save({ availability: loaded.availability });
  assert.equal(response.status, 409);
  assert.ok((await response.json()).fields.availability);
  assert.equal(f.rows().filter(row => row.status === "open").length, 2);
});

test("explicit replacement protects live commitments and every history reference", async t => {
  const f = setup(t); referenceSlot(f, "accepted", "active"); f.add("sun", 0, 600, 900);
  f.sql.exec("INSERT INTO slot_claims(id,helper_user_id,day_of_week,minute_of_day,request_id,booking_id) VALUES ('claim','helper',1,510,'request','booking')");
  const before = f.rows();
  const bookings = f.sql.prepare("SELECT * FROM booking_slots").all();
  const claims = f.sql.prepare("SELECT * FROM slot_claims").all();
  const response = await f.save({ replaceSchedule: true, availability: [{ days: [0], start: "10:00", end: "15:00" }] });
  assert.equal(response.status, 409);
  assert.ok((await response.json()).fields.availability);
  assert.deepEqual(f.rows(), before);
  assert.equal((await f.save({ replaceSchedule: true, availability: [{ days: [1, 0], start: "08:00", end: "15:00" }] })).status, 200);
  assert.deepEqual(f.sql.prepare("SELECT * FROM booking_slots").all(), bookings);
  assert.deepEqual(f.sql.prepare("SELECT * FROM slot_claims").all(), claims);
  assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
  assert.ok(f.rows().some(row => row.id === "old"));
});

test("audit failure rolls back the complete explicit replacement", async t => {
  const f = setup(t); f.add("wed", 3); f.add("sun", 0, 600, 900);
  const before = f.rows();
  f.sql.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON analytics_events BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  assert.equal((await f.save({ replaceSchedule: true, availability: [{ days: [3], start: "08:00", end: "14:00" }] })).status, 500);
  assert.deepEqual(f.rows(), before);
});

test("invalid legacy days and intervals are never normalized into availability", async t => {
  for (const [day, start, end] of [[7, 480, 840], [-1, 480, 840], [3, 1320, 120], [3, 481, 840], [3, 480, 480]]) {
    const f = setup(t); f.add("invalid", day, start, end);
    const before = f.rows();
    assert.equal((await f.get()).schedule.kind, "invalid");
    assert.deepEqual((await f.get()).availability, []);
    assert.equal((await f.save()).status, 200);
    assert.deepEqual(f.rows(), before);
    assert.equal((await f.save({ availability: [{ days: [day], start: "22:00", end: "02:00" }] })).status, 400);
    assert.deepEqual(f.rows(), before);
  }
  for (const days of [null, [], [null], ["3"], [7], [-1], [1.5]]) assert.throws(() => exactDays(days));
});

test("empty or retired-only schedules have no fallback weekdays", async t => {
  const f = setup(t); f.add("old", 3, 480, 840, null, "inactive");
  assert.equal((await f.get()).schedule.kind, "empty");
  assert.deepEqual((await f.get()).availability, []);
  assert.equal((await f.save()).status, 409);
});

test("rendered common editor has seven days; heterogeneous schedule requires confirmation", t => {
  const f = setup(t);
  const { HelperWorkingHours } = f.load("app/components/helper-working-hours.tsx");
  const value = { id: "one", days: [3], start: "08:00", end: "14:00" };
  const props = { value, onChange() {}, onReplace() {} };
  const editor = renderToStaticMarkup(createElement(HelperWorkingHours, { ...props, legacy: null }));
  assert.equal((editor.match(/type="checkbox"/g) ?? []).length, 7);
  assert.equal((editor.match(/checked=""/g) ?? []).length, 1);
  const legacy = renderToStaticMarkup(createElement(HelperWorkingHours, { ...props, legacy: { kind: "heterogeneous", windows: [value] } }));
  assert.match(legacy, /Replace my legacy schedule/);
  assert.match(legacy, /Wednesday/);
  assert.doesNotMatch(legacy, /type="checkbox"/);
});
