import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/local-routes.mjs";
import { png } from "./helpers/proof-images.mjs";

function setup(t) {
  const f = fixture(); t.after(() => f.sql.close());
  f.sql.exec("UPDATE helper_profiles SET verification_status='verified'; UPDATE verification_documents SET status='verified',reviewed_at='2026-01-01',review_note='SYNTHETIC_REVIEW'");
  f.objects.set("fixture/old.pdf", new Uint8Array([1, 2, 3]));
  f.post = () => {
    const body = new FormData(); body.append("file", new File([png], "proof.png", { type: "image/png" }));
    return f.load("app/api/helper/address-proof/route.ts").POST(new Request("https://example.test/api", { method: "POST", headers: { origin: "https://example.test" }, body }));
  };
  const tables = f.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('users','user_roles','sqlite_sequence') ORDER BY name").all();
  f.snapshot = () => tables.map(({ name }) => f.sql.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
  return f;
}
async function rejected(response, f) {
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.deepEqual(body, { error: "We could not save your changes. Refresh and try again." });
  assert.doesNotMatch(JSON.stringify([body, f.logs]), /blocked|deleted|helper|fixture|SYNTHETIC|private|SELECT|overflow|review/i);
}

for (const mutation of [
  "UPDATE users SET status='blocked' WHERE id='helper'",
  "UPDATE users SET status='deleted' WHERE id='helper'",
  "UPDATE users SET status='unknown' WHERE id='helper'",
  "UPDATE user_roles SET role='resident' WHERE user_id='helper'",
  "DELETE FROM user_roles WHERE user_id='helper'",
]) test(`proof batch rechecks eligibility: ${mutation}`, async t => {
  const f = setup(t), before = f.snapshot();
  f.db.beforeBatch = () => f.sql.exec(mutation);
  const executed = [];
  f.db.beforeStatement = (_, statement) => executed.push(statement.query);
  await rejected(await f.post(), f);
  assert.equal(executed.length, 1);
  assert.match(executed[0], /^SELECT/);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.objects.get("fixture/old.pdf"), new Uint8Array([1, 2, 3]));
  assert.equal(f.objects.size, 2); // Deferred R2-before-D1 orphan only.
});

for (const mutation of [
  "UPDATE verification_documents SET helper_user_id='resident' WHERE id='proof'",
  "UPDATE verification_documents SET status='rejected' WHERE id='proof'",
  "UPDATE verification_documents SET r2_object_key='fixture/concurrent.png' WHERE id='proof'",
  "UPDATE verification_documents SET status='deleted' WHERE id='proof'",
]) test(`proof batch rejects stale expected proof: ${mutation}`, async t => {
  const f = setup(t); let before;
  f.db.beforeBatch = () => { f.sql.exec(mutation); before = f.snapshot(); };
  await rejected(await f.post(), f);
  assert.deepEqual(f.snapshot(), before);
  assert.ok(f.objects.has("fixture/old.pdf"));
});

for (const initialProof of [true, false]) test(`competing uploads serialize with initial proof=${initialProof}`, async t => {
  const f = setup(t);
  if (!initialProof) f.sql.exec("DELETE FROM verification_documents");
  let winner;
  f.db.beforeBatch = async () => {
    assert.equal((await f.post()).status, 200);
    winner = f.snapshot();
  };
  await rejected(await f.post(), f);
  assert.deepEqual(f.snapshot(), winner);
  const current = f.sql.prepare("SELECT * FROM verification_documents WHERE status='pending'").all();
  assert.equal(current.length, 1);
  assert.ok(f.objects.has(current[0].r2_object_key));
  assert.equal(f.sql.prepare("SELECT count(*) n FROM analytics_events").get().n, 1);
});

for (const [table, operation] of [["helper_profiles", "UPDATE"], ["verification_documents", "UPDATE"], ["verification_documents", "INSERT"], ["analytics_events", "INSERT"]]) {
  test(`proof ${table} ${operation} failure rolls back the metadata batch`, async t => {
    const f = setup(t), before = f.snapshot();
    f.sql.exec(`CREATE TRIGGER synthetic_failure BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PRIVATE'); END`);
    const response = await f.post();
    assert.equal(response.status, 500);
    assert.deepEqual(f.snapshot(), before);
    assert.ok(f.objects.has("fixture/old.pdf"));
    assert.doesNotMatch(JSON.stringify([await response.json(), f.logs]), /SYNTHETIC|fixture|private\/|SELECT/);
    f.sql.exec("DROP TRIGGER synthetic_failure");
    assert.equal((await f.post()).status, 200);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM analytics_events").get().n, 1);
  });
}

test("proof upload before account block commits once; later upload cannot replace it", async t => {
  const f = setup(t);
  assert.equal((await f.post()).status, 200);
  f.sql.exec("UPDATE users SET status='blocked' WHERE id='helper'");
  const before = f.snapshot();
  await rejected(await f.post(), f);
  assert.deepEqual(f.snapshot(), before);
});

for (const status of ["blocked", "deleted"]) test(`first proof upload creates no metadata when account becomes ${status}`, async t => {
  const f = setup(t);
  f.sql.exec("DELETE FROM verification_documents; DELETE FROM helper_profiles");
  const before = f.snapshot();
  f.db.beforeBatch = () => f.sql.prepare("UPDATE users SET status=? WHERE id='helper'").run(status);
  await rejected(await f.post(), f);
  assert.deepEqual(f.snapshot(), before);
});

test("address invalidation racing proof replacement rejects the stale verified proof", async t => {
  const f = setup(t);
  f.sql.exec("UPDATE helper_profiles SET home_address='Fixture',latitude_e6=10000000,longitude_e6=20000000");
  let winner;
  f.db.beforeBatch = async () => {
    const { jsonRequest, profilePayload } = await import("./helpers/local-routes.mjs");
    const response = await f.load("app/api/helper/profile/route.ts").PUT(jsonRequest({ ...profilePayload, homeAddress: "New address" }));
    assert.equal(response.status, 200);
    winner = f.snapshot();
  };
  await rejected(await f.post(), f);
  assert.deepEqual(f.snapshot(), winner);
  assert.equal(f.sql.prepare("SELECT status FROM verification_documents WHERE id='proof'").get().status, "pending");
  assert.deepEqual(f.objects.get("fixture/old.pdf"), new Uint8Array([1, 2, 3]));
  assert.equal(f.sql.prepare("SELECT count(*) n FROM analytics_events WHERE event_name='address_proof_uploaded'").get().n, 0);
});
