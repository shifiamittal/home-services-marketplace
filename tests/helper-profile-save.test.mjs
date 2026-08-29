import assert from "node:assert/strict";
import test from "node:test";
import { fixture, jsonRequest, profilePayload } from "./helpers/local-routes.mjs";

const route = "app/api/helper/profile/route.ts";
function setup(t) {
  const f = fixture();
  t.after(() => f.sql.close());
  f.save = () => f.load(route).PUT(jsonRequest({ ...profilePayload, yearsExperience: 9 }));
  f.audits = () => f.sql.prepare("SELECT count(*) AS n FROM analytics_events WHERE event_name='helper_profile_saved'").get().n;
  f.snapshot = () => ["helper_profiles", "helper_offerings", "availability_slots", "analytics_events"].map(table => f.sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return f;
}

test("PUT cannot fail at the former post-commit read position", async t => {
  const f = setup(t);
  f.db.beforeRead = query => {
    if (query === "SELECT profile_status,verification_status FROM helper_profiles WHERE user_id = ?") throw new Error("SENTINEL_PRIVATE");
  };
  const response = await f.save();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { saved: true, profileStatus: "active", verificationStatus: "not_submitted", combinedPricesCalculated: true });
  assert.equal(f.audits(), 1);
});

for (const [table, operation] of [["analytics_events", "INSERT"], ["helper_profiles", "UPDATE"]]) {
  test(`PUT ${table} failure rolls back every write; retry commits exactly once`, async t => {
    const f = setup(t);
    const before = f.snapshot();
    f.sql.exec(`CREATE TRIGGER synthetic_failure BEFORE ${operation} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'SENTINEL_PRIVATE'); END;`);
    const response = await f.save();
    assert.equal(response.status, 500);
    assert.deepEqual(f.snapshot(), before);
    const body = await response.json();
    assert.match(body.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.doesNotMatch(JSON.stringify([body, f.logs]), /SENTINEL_PRIVATE|Fixture|latitude|years_experience/);
    f.sql.exec("DROP TRIGGER synthetic_failure");
    assert.equal((await f.save()).status, 200);
    assert.equal(f.audits(), 1);
  });
}

for (const status of ["paused", "blocked", "review"]) {
  test(`PUT returns authoritative concurrent ${status} status and preserves verification`, async t => {
    const f = setup(t);
    f.sql.exec("UPDATE helper_profiles SET verification_status='verified',home_address='Fixture',latitude_e6=10000000,longitude_e6=20000000");
    f.db.beforeBatch = () => f.sql.prepare("UPDATE helper_profiles SET profile_status=? WHERE user_id='helper'").run(status);
    const response = await f.save();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { saved: true, profileStatus: status, verificationStatus: "verified", combinedPricesCalculated: true });
    const saved = f.sql.prepare("SELECT profile_status,verification_status FROM helper_profiles WHERE user_id='helper'").get();
    assert.equal(saved.profile_status, status);
    assert.equal(saved.verification_status, "verified");
    assert.equal(f.audits(), 1);
  });
}

test("PUT response read failure inside the batch rolls back the audit and profile", async t => {
  const f = setup(t);
  const before = f.snapshot();
  f.db.beforeStatement = (_, statement) => {
    if (statement.query === "SELECT profile_status,verification_status FROM helper_profiles WHERE user_id = ?") throw new Error("SENTINEL_PRIVATE");
  };
  assert.equal((await f.save()).status, 500);
  assert.deepEqual(f.snapshot(), before);
  f.db.beforeStatement = null;
  assert.equal((await f.save()).status, 200);
  assert.equal(f.audits(), 1);
});
