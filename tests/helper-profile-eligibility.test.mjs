import assert from "node:assert/strict";
import test from "node:test";
import { fixture, jsonRequest, profilePayload } from "./helpers/local-routes.mjs";

const route = "app/api/helper/profile/route.ts";
function setup(t) {
  const f = fixture(); t.after(() => f.sql.close());
  f.save = () => f.load(route).PUT(jsonRequest({ ...profilePayload, yearsExperience: 9 }));
  f.block = status => f.sql.prepare("UPDATE users SET status=? WHERE id='helper'").run(status);
  // Every application table except the deliberate account-state change:
  // profiles, addresses, proofs, offerings, schedules, history, claims, audits,
  // notifications and analytics must all remain unchanged after rejection.
  const tables = f.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'users' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  f.snapshot = () => tables.map(({ name }) => f.sql.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
  f.auditCount = () => f.sql.prepare("SELECT count(*) AS n FROM analytics_events WHERE event_name='helper_profile_saved'").get().n;
  f.bucket.put = async () => { throw new Error("Unexpected object write"); };
  f.bucket.delete = async () => { throw new Error("Unexpected object deletion"); };
  return f;
}

for (const status of ["blocked", "deleted", "unknown"]) {
  test(`PUT rechecks ${status} account inside the batch before any mutation`, async t => {
    const f = setup(t);
    const before = f.snapshot();
    f.db.beforeBatch = () => f.block(status);
    const response = await f.save();
    assert.equal(response.status, 409);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.auditCount(), 0);
    assert.equal(f.objects.size, 0);
    const body = await response.json();
    assert.deepEqual(body, { error: "Your account cannot save changes right now. Refresh and try again." });
    assert.doesNotMatch(JSON.stringify([body, f.logs]), /blocked|deleted|unknown|helper|Fixture|SELECT|UPDATE|integer overflow/);
    assert.equal((await f.save()).status, 409);
    assert.deepEqual(f.snapshot(), before);
    f.block("active");
    assert.equal((await f.save()).status, 200);
    assert.equal(f.auditCount(), 1);
  });
}

test("active account control commits a profile and exactly one audit", async t => {
  const f = setup(t);
  assert.equal((await f.save()).status, 200);
  assert.equal(f.sql.prepare("SELECT years_experience FROM helper_profiles WHERE user_id='helper'").get().years_experience, 9);
  assert.equal(f.auditCount(), 1);
});

test("PUT-before-block ordering commits once; later attempts are rejected without side effects", async t => {
  const f = setup(t);
  assert.equal((await f.save()).status, 200);
  f.block("blocked");
  const before = f.snapshot();
  assert.equal((await f.save()).status, 409);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.auditCount(), 1);
});

test("eligibility guard is first and fails before executing a mutation", async t => {
  const f = setup(t);
  f.block("blocked");
  const executed = [];
  f.db.beforeStatement = (_, statement) => executed.push(statement.query);
  assert.equal((await f.save()).status, 409);
  assert.equal(executed.length, 1);
  assert.match(executed[0], /SELECT/);
  assert.match(executed[0], /FROM users/);
  assert.doesNotMatch(executed[0], /INSERT|UPDATE|DELETE/);
});
