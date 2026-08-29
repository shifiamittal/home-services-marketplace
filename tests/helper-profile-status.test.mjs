import assert from "node:assert/strict";
import test from "node:test";
import { fixture, jsonRequest } from "./helpers/local-routes.mjs";

const route = "app/api/helper/profile/route.ts";
function setup(t) {
  const f = fixture();
  t.after(() => f.sql.close());
  f.patch = (paused = true) => f.load(route).PATCH(jsonRequest({ paused }, "PATCH"));
  f.status = () => f.sql.prepare("SELECT profile_status FROM helper_profiles WHERE user_id='helper'").get().profile_status;
  f.auditCount = () => f.sql.prepare("SELECT count(*) AS n FROM analytics_events WHERE event_name='helper_profile_status_changed'").get().n;
  return f;
}
function fail(f, table, operation) {
  f.sql.exec(`CREATE TRIGGER synthetic_failure BEFORE ${operation} ON ${table}
    BEGIN SELECT RAISE(ABORT, 'SENTINEL_PRIVATE'); END;`);
}

test("status PATCH analytics failure rolls back and retry records exactly one transition", async t => {
  const f = setup(t);
  fail(f, "analytics_events", "INSERT");
  const response = await f.patch();
  assert.equal(response.status, 500);
  assert.equal(f.status(), "active");
  assert.equal(f.auditCount(), 0);
  const body = await response.json();
  assert.match(body.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(JSON.stringify([body, f.logs]).includes("SENTINEL_PRIVATE"), false);
  f.sql.exec("DROP TRIGGER synthetic_failure");
  assert.equal((await f.patch()).status, 200);
  assert.equal(f.status(), "paused");
  assert.equal(f.auditCount(), 1);
  assert.equal((await f.patch()).status, 409);
  assert.equal(f.auditCount(), 1);
});

test("status PATCH update failure creates no audit and discloses no exception", async t => {
  const f = setup(t);
  fail(f, "helper_profiles", "UPDATE");
  const response = await f.patch();
  assert.equal(response.status, 500);
  assert.equal(f.status(), "active");
  assert.equal(f.auditCount(), 0);
  assert.equal(JSON.stringify([await response.json(), f.logs]).includes("SENTINEL_PRIVATE"), false);
});

test("status PATCH success persists both writes and supports resume", async t => {
  const f = setup(t);
  assert.deepEqual(await (await f.patch()).json(), { saved: true, profileStatus: "paused" });
  assert.equal(f.status(), "paused");
  assert.equal(f.auditCount(), 1);
  assert.equal((await f.patch(false)).status, 200);
  assert.equal(f.status(), "active");
  assert.equal(f.auditCount(), 2);
});

test("status PATCH rejects a competing transition inside the atomic operation", async t => {
  const f = setup(t);
  f.db.beforeBatch = async () => {
    assert.equal((await f.patch()).status, 200);
  };
  assert.equal((await f.patch()).status, 409);
  assert.equal(f.status(), "paused");
  assert.equal(f.auditCount(), 1);
});

test("status PATCH rechecks moderation and user eligibility inside the batch", async t => {
  for (const mutation of [
    "UPDATE helper_profiles SET profile_status='blocked' WHERE user_id='helper'",
    "UPDATE users SET status='blocked' WHERE id='helper'",
  ]) {
    const f = setup(t);
    f.db.beforeBatch = () => f.sql.exec(mutation);
    assert.equal((await f.patch()).status, 409);
    assert.equal(f.auditCount(), 0);
  }
});

test("status PATCH rejects unauthorized roles, cross-origin requests and noneditable states", async t => {
  const f = setup(t);
  f.session.roles = ["resident"];
  assert.equal((await f.patch()).status, 403);
  f.session.roles = ["provider"];
  assert.equal((await f.load(route).PATCH(new Request("https://example.test/api", {
    method: "PATCH", headers: { origin: "https://other.test" }, body: JSON.stringify({ paused: true }),
  }))).status, 403);
  for (const status of ["draft", "blocked", "paused"]) {
    f.sql.prepare("UPDATE helper_profiles SET profile_status=? WHERE user_id='helper'").run(status);
    assert.equal((await f.patch()).status, 409);
    assert.equal(f.status(), status);
  }
  assert.equal(f.auditCount(), 0);
});
