import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { claimMinutes } from "../app/lib/workflow-integrity.ts";

function insertClaims(db, helperId, requestId, slots) {
  const claims = claimMinutes(slots);
  const insert = db.prepare(`
    INSERT INTO slot_claims (helper_id, day, minute, request_id)
    SELECT ?, json_extract(value, '$.day'), json_extract(value, '$.minute'), ?
    FROM json_each(?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    insert.run(helperId, requestId, JSON.stringify(claims));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function transition(db, entityType, entityId, fromState, toState) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO workflow_transitions (entity_type, entity_id, from_state, to_state) VALUES (?, ?, ?, ?)")
      .run(entityType, entityId, fromState, toState);
    db.prepare("INSERT INTO effects (entity_id, effect) VALUES (?, ?)").run(entityId, toState);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("database claims reject simultaneous overlapping holds and preserve non-overlapping capacity", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE slot_claims (
      helper_id TEXT NOT NULL,
      day INTEGER NOT NULL,
      minute INTEGER NOT NULL,
      request_id TEXT NOT NULL,
      UNIQUE(helper_id, day, minute)
    );
  `);
  insertClaims(db, "helper-1", "request-1", [{ dayOfWeek: 1, start: 480, end: 510 }]);
  assert.throws(
    () => insertClaims(db, "helper-1", "request-2", [{ dayOfWeek: 1, start: 524, end: 554 }]),
    /UNIQUE constraint failed/,
  );
  assert.doesNotThrow(
    () => insertClaims(db, "helper-1", "request-3", [{ dayOfWeek: 1, start: 525, end: 555 }]),
  );
  assert.equal(db.prepare("SELECT COUNT(DISTINCT request_id) AS count FROM slot_claims").get().count, 2);
});

test("acceptance versus withdrawal and two acceptance attempts produce one effect", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE workflow_transitions (entity_type TEXT, entity_id TEXT, from_state TEXT, to_state TEXT,
      UNIQUE(entity_type, entity_id, from_state));
    CREATE TABLE effects (entity_id TEXT, effect TEXT);
  `);
  transition(db, "booking_request", "request-1", "pending", "accepted");
  assert.throws(() => transition(db, "booking_request", "request-1", "pending", "withdrawn"), /UNIQUE constraint failed/);
  assert.throws(() => transition(db, "booking_request", "request-1", "pending", "accepted"), /UNIQUE constraint failed/);
  assert.deepEqual(db.prepare("SELECT effect FROM effects").all().map(row => row.effect), ["accepted"]);
});

test("cancellation versus completion and repeated actions produce one effect per state", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE workflow_transitions (entity_type TEXT, entity_id TEXT, from_state TEXT, to_state TEXT,
      UNIQUE(entity_type, entity_id, from_state));
    CREATE TABLE effects (entity_id TEXT, effect TEXT);
  `);
  transition(db, "booking", "booking-1", "trial:0", "trial:1");
  assert.throws(() => transition(db, "booking", "booking-1", "trial:0", "cancelled"), /UNIQUE constraint failed/);
  assert.throws(() => transition(db, "booking", "booking-1", "trial:0", "trial:1"), /UNIQUE constraint failed/);
  transition(db, "booking", "booking-1", "trial:1", "cancelled");
  assert.throws(() => transition(db, "booking", "booking-1", "trial:1", "cancelled"), /UNIQUE constraint failed/);
  assert.deepEqual(db.prepare("SELECT effect FROM effects ORDER BY rowid").all().map(row => row.effect), ["trial:1", "cancelled"]);
});

test("atomic issue counter allocates distinct case numbers for competing submissions", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE issue_case_counter (id INTEGER PRIMARY KEY, next_case_number INTEGER NOT NULL); INSERT INTO issue_case_counter VALUES (1, 1001); CREATE TABLE issues (id TEXT PRIMARY KEY, case_number INTEGER UNIQUE);");
  const submit = id => {
    db.exec("BEGIN IMMEDIATE");
    db.exec("UPDATE issue_case_counter SET next_case_number = next_case_number + 1 WHERE id = 1");
    db.prepare("INSERT INTO issues SELECT ?, next_case_number - 1 FROM issue_case_counter WHERE id = 1").run(id);
    db.exec("COMMIT");
  };
  await Promise.all([Promise.resolve().then(() => submit("issue-1")), Promise.resolve().then(() => submit("issue-2"))]);
  assert.deepEqual(db.prepare("SELECT case_number FROM issues ORDER BY case_number").all().map(row => row.case_number), [1001, 1002]);
});
