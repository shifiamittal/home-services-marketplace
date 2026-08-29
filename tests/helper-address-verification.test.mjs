import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fixture, jsonRequest, profilePayload, referenceSlot } from "./helpers/local-routes.mjs";

const route = "app/api/helper/profile/route.ts";
function setup(t) {
  const f = fixture(); t.after(() => f.sql.close());
  f.sql.exec(`UPDATE helper_profiles SET home_address='Fixture',latitude_e6=10000000,longitude_e6=20000000,verification_status='verified';
    UPDATE verification_documents SET status='verified',reviewed_at='2026-01-01 12:00:00',review_note='SYNTHETIC_REVIEW';
    INSERT INTO analytics_events(id,user_id,event_name,properties_json) VALUES ('historical','helper','synthetic_historical_verification','{"verified":true}');
    INSERT INTO verification_documents(id,helper_user_id,document_type,r2_object_key,original_filename,content_type,size_bytes,status,reviewed_at,review_note)
      VALUES ('retired','helper','other_address_proof','fixture/retired','old.png','image/png',3,'deleted','2025-01-01','SYNTHETIC_HISTORY');`);
  referenceSlot(f, "accepted", "active");
  f.objects.set("fixture/old.pdf", new Uint8Array([1, 2, 3]));
  f.bucket.put = f.bucket.delete = async () => { throw Error("Unexpected proof byte mutation"); };
  f.save = (extra = {}) => f.load(route).PUT(jsonRequest({ ...profilePayload, ...extra }));
  f.get = async () => (await f.load(route).GET(new Request("https://example.test/api"))).json();
  f.proof = () => f.sql.prepare("SELECT * FROM verification_documents WHERE id='proof'").get();
  f.profile = () => f.sql.prepare("SELECT * FROM helper_profiles WHERE user_id='helper'").get();
  f.audits = () => f.sql.prepare("SELECT * FROM analytics_events WHERE event_name='helper_profile_saved' ORDER BY rowid").all().map(row => JSON.parse(row.properties_json));
  const tables = f.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  f.snapshot = () => tables.map(({name}) => f.sql.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
  f.history = () => ["booking_requests", "request_slots", "bookings", "booking_slots", "booking_status_history"].map(table => f.sql.prepare(`SELECT * FROM ${table}`).all()).concat([
    f.sql.prepare("SELECT * FROM verification_documents WHERE id='retired'").all(),
    f.sql.prepare("SELECT * FROM analytics_events WHERE id='historical'").all(),
  ]);
  return f;
}

for (const extra of [
  { homeAddress: "Different unit" }, { locality: "Different locality" },
  { latitude: 10.000001 }, { longitude: 20.000001 }, { latitude: null, longitude: null },
  { homeAddress: "fixture" }, { homeAddress: "Fixture, unit 2" },
  { homeAddress: "Different unit", latitude: undefined, longitude: undefined },
]) test(`meaningful address revision invalidates current verification: ${JSON.stringify(extra)}`, async t => {
  const f = setup(t), proof = f.proof(), history = f.history();
  assert.equal((await f.save(extra)).status, 200);
  assert.equal(f.profile().verification_status, "pending");
  assert.equal(f.profile().home_address, extra.homeAddress ?? "Fixture");
  assert.deepEqual({ ...f.proof() }, { ...proof, status: "pending" });
  assert.deepEqual(f.history(), history);
  assert.deepEqual(f.objects.get("fixture/old.pdf"), new Uint8Array([1, 2, 3]));
  assert.equal(f.audits().length, 1);
  assert.equal(f.audits()[0].addressVerificationInvalidated, true);
  assert.equal(f.audits()[0].previousVerificationStatus, "verified");
  const presented = await f.get();
  assert.equal(presented.profile.verificationStatus, "pending");
  assert.equal(presented.addressProof.status, "pending");
  assert.doesNotMatch(JSON.stringify(f.audits()), /Different|Fixture|SYNTHETIC|fixture\/|latitude|longitude|review_note/);
  assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
});

for (const extra of [
  { homeAddress: "\t Fixture \u00a0", locality: "\ufeffFixture\n" },
  { latitude: 10.0000001, longitude: 20.0000001 },
  { latitude: undefined, longitude: undefined },
  { yearsExperience: 9 }, { travelDistanceKm: 8 },
  { services: { houseCleaning: [], utensils: { frequency: "twice", onceDailyMonthlyPricePaise: 35_000 } }, offerings: undefined },
  { availability: [{ days: [1, 2, 3, 4, 5, 6, 0], start: "08:00", end: "14:00" }] },
  { availability: undefined },
]) test(`equivalent address or unrelated edit preserves verification: ${JSON.stringify(extra)}`, async t => {
  const f = setup(t), proof = f.proof(), history = f.history();
  assert.equal((await f.save(extra)).status, 200);
  assert.equal(f.profile().verification_status, "verified");
  assert.deepEqual(f.proof(), proof);
  assert.deepEqual(f.history(), history);
  assert.equal(f.profile().latitude_e6, 10000000);
  assert.equal(f.audits()[0].addressVerificationInvalidated, false);
});

test("stored Unicode outer whitespace and legacy effective locality are canonically equivalent", async t => {
  const f = setup(t);
  f.sql.prepare("UPDATE helper_profiles SET home_address=?,home_locality=?").run("\u00a0Fixture\t", "\ufeffFixture\n");
  assert.equal((await f.save()).status, 200);
  assert.equal(f.profile().verification_status, "verified");
  f.sql.exec("UPDATE helper_profiles SET home_address=NULL");
  assert.equal((await f.save()).status, 200);
  assert.equal(f.profile().verification_status, "verified");
});

for (const [table, operation] of [["analytics_events", "INSERT"], ["verification_documents", "UPDATE"], ["helper_profiles", "UPDATE"], ["helper_offerings", "INSERT"]]) {
  test(`address ${table} failure rolls back address, verification and audit`, async t => {
    const f = setup(t), before = f.snapshot();
    f.sql.exec(`CREATE TRIGGER synthetic_failure BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PRIVATE'); END`);
    assert.equal((await f.save({ homeAddress: "Different unit" })).status, 500);
    assert.deepEqual(f.snapshot(), before);
    f.sql.exec("DROP TRIGGER synthetic_failure");
    assert.equal((await f.save({ homeAddress: "Different unit" })).status, 200);
    assert.equal(f.audits().length, 1);
  });
}

test("final response read failure rolls back invalidation and the new address", async t => {
  const f = setup(t), before = f.snapshot();
  f.db.beforeStatement = (_, statement) => {
    if (statement.query === "SELECT profile_status,verification_status FROM helper_profiles WHERE user_id = ?") throw Error("Synthetic");
  };
  assert.equal((await f.save({ longitude: 21 })).status, 500);
  assert.deepEqual(f.snapshot(), before);
});

test("stale save cannot preserve verification of a concurrently changed address", async t => {
  const f = setup(t);
  f.db.beforeBatch = async () => {
    assert.equal((await f.save({ homeAddress: "Concurrent address", latitude: 11 })).status, 200);
    // Simulate an existing manual backend review; no verification endpoint.
    f.sql.exec("UPDATE helper_profiles SET verification_status='verified'; UPDATE verification_documents SET status='verified' WHERE id='proof'");
  };
  assert.equal((await f.save()).status, 200);
  assert.equal(f.profile().home_address, "Fixture");
  assert.equal(f.profile().verification_status, "pending");
  assert.equal(f.proof().status, "pending");
  assert.equal(f.audits().filter(row => row.addressVerificationInvalidated).length, 2);
});

test("concurrent equivalent saves do not restore or repeatedly invalidate verification", async t => {
  const f = setup(t);
  f.db.beforeBatch = async () => assert.equal((await f.save({ homeAddress: "New address" })).status, 200);
  assert.equal((await f.save({ homeAddress: "New address" })).status, 200);
  assert.equal(f.profile().verification_status, "pending");
  assert.equal(f.audits().filter(row => row.addressVerificationInvalidated).length, 1);
  assert.equal((await f.save({ homeAddress: "Fixture" })).status, 200);
  assert.equal(f.profile().verification_status, "pending");
});

test("proof replacement racing an address edit retains only pending current verification", async t => {
  const f = setup(t);
  f.db.beforeBatch = () => f.sql.exec("UPDATE helper_profiles SET verification_status='pending'; UPDATE verification_documents SET status='pending' WHERE id='proof'");
  assert.equal((await f.save({ homeAddress: "New address" })).status, 200);
  assert.equal(f.profile().verification_status, "pending");
  assert.equal(f.proof().status, "pending");
});

test("resident proof-provided presentation makes no address-verified claim", () => {
  const source = readFileSync("app/page.tsx", "utf8");
  assert.match(source, /Address proof provided/);
  assert.doesNotMatch(source, /Address verified|addressVerified/);
});

for (const legacyAddress of [null, "", "\t\u00a0"]) test(`legacy effective address preserves verification with omitted coordinates: ${JSON.stringify(legacyAddress)}`, async t => {
  const f = setup(t), proof = f.proof(), history = f.history();
  f.sql.prepare("UPDATE helper_profiles SET home_address=? WHERE user_id='helper'").run(legacyAddress);
  assert.equal((await f.save({ latitude: undefined, longitude: undefined })).status, 200);
  assert.equal(f.profile().home_address, "Fixture");
  assert.equal(f.profile().latitude_e6, 10000000);
  assert.equal(f.profile().longitude_e6, 20000000);
  assert.equal(f.profile().verification_status, "verified");
  assert.deepEqual(f.proof(), proof);
  assert.deepEqual(f.history(), history);
  assert.equal(f.audits()[0].addressVerificationInvalidated, false);
});

test("concurrent legacy canonicalization preserves the current confirmed coordinates", async t => {
  const f = setup(t);
  f.db.beforeBatch = () => f.sql.exec("UPDATE helper_profiles SET home_address=NULL,latitude_e6=11000000,longitude_e6=21000000 WHERE user_id='helper'");
  assert.equal((await f.save({ latitude: undefined, longitude: undefined })).status, 200);
  assert.equal(f.profile().latitude_e6, 11000000);
  assert.equal(f.profile().longitude_e6, 21000000);
  assert.equal(f.profile().verification_status, "verified");
  assert.equal(f.proof().status, "verified");
  assert.equal(f.audits()[0].addressVerificationInvalidated, false);
});

test("schedule conflict rolls back the address revision and verification history", async t => {
  const f = setup(t), before = f.snapshot();
  const response = await f.save({ homeAddress: "Different unit", availability: [{ days: [0], start: "08:00", end: "14:00" }] });
  assert.equal(response.status, 409);
  assert.deepEqual(f.snapshot(), before);
});
