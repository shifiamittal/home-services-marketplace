import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  expirePendingRequests,
  PENDING_EXPIRY_BATCH_LIMIT,
} from "../app/lib/workflow-integrity.ts";

const fixedNow = "2030-01-07T10:00:00.000Z";

class D1TestAdapter {
  constructor(database) {
    this.database = database;
    this.preparedCount = 0;
    this.beforeBatch = null;
    this.beforeStatement = null;
  }

  prepare(sql) {
    this.preparedCount += 1;
    return { bind: (...parameters) => ({ sql, parameters }) };
  }

  async batch(statements) {
    this.beforeBatch?.();
    this.beforeBatch = null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const [index, statement] of statements.entries()) {
        this.beforeStatement?.(index, statement);
        results.push(this.database.prepare(statement.sql).run(...statement.parameters));
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function setup() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE booking_requests (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      response_due_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE workflow_transitions (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      actor_user_id TEXT,
      UNIQUE(entity_type, entity_id, from_state)
    );
    CREATE TABLE slot_claims (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      booking_id TEXT
    );
  `);
  return { database, d1: new D1TestAdapter(database) };
}

function addRequest(database, id, status = "pending", expired = true) {
  database.prepare(
    "INSERT INTO booking_requests VALUES (?, ?, ?, ?, ?)",
  ).run(
    id,
    status,
    expired ? "2000-01-01 00:00:00" : "2999-01-01 00:00:00",
    `2000-01-01 00:00:${id.slice(-2).padStart(2, "0")}`,
    "2000-01-01 00:00:00",
  );
  database.prepare("INSERT INTO slot_claims VALUES (?, ?, NULL)").run(`claim-${id}`, id);
}

function count(database, table, where = "1 = 1") {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count;
}

test("bounded expiry is a constant-size no-op when no requests are expired", async () => {
  const { database, d1 } = setup();
  addRequest(database, "future-01", "pending", false);
  await expirePendingRequests(d1, fixedNow);
  assert.equal(d1.preparedCount, 3);
  assert.equal(count(database, "booking_requests", "status = 'expired'"), 0);
  assert.equal(count(database, "slot_claims"), 1);
  assert.equal(count(database, "workflow_transitions"), 0);
});

test("fewer than the limit expire atomically and repeated cleanup is idempotent", async () => {
  const { database, d1 } = setup();
  for (let index = 0; index < 7; index += 1) addRequest(database, `expired-${index.toString().padStart(2, "0")}`);
  addRequest(database, "future-99", "pending", false);
  await expirePendingRequests(d1, fixedNow);
  assert.equal(count(database, "booking_requests", "status = 'expired'"), 7);
  assert.equal(count(database, "workflow_transitions"), 7);
  assert.equal(count(database, "slot_claims"), 1);
  await expirePendingRequests(d1, fixedNow);
  assert.equal(d1.preparedCount, 6);
  assert.equal(count(database, "workflow_transitions"), 7);
  assert.equal(count(database, "slot_claims"), 1);
});

test("large backlogs process one deterministic bounded batch per invocation", async () => {
  const { database, d1 } = setup();
  const backlog = PENDING_EXPIRY_BATCH_LIMIT + 9;
  for (let index = 0; index < backlog; index += 1) addRequest(database, `request-${index.toString().padStart(2, "0")}`);
  await expirePendingRequests(d1, fixedNow);
  assert.equal(d1.preparedCount, 3);
  assert.equal(count(database, "booking_requests", "status = 'expired'"), PENDING_EXPIRY_BATCH_LIMIT);
  assert.equal(count(database, "slot_claims"), 9);
  const remaining = database.prepare("SELECT id FROM booking_requests WHERE status = 'pending' ORDER BY response_due_at, created_at, id").all().map(row => row.id);
  assert.deepEqual(remaining, Array.from({ length: 9 }, (_, offset) => `request-${(PENDING_EXPIRY_BATCH_LIMIT + offset).toString().padStart(2, "0")}`));
  await expirePendingRequests(d1, fixedNow);
  assert.equal(d1.preparedCount, 6);
  assert.equal(count(database, "booking_requests", "status = 'expired'"), backlog);
  assert.equal(count(database, "slot_claims"), 0);
  assert.equal(count(database, "workflow_transitions"), backlog);
});

test("a request transitioned before the transactional batch is not expired or released", async () => {
  const { database, d1 } = setup();
  addRequest(database, "accepted-01");
  addRequest(database, "expired-02");
  d1.beforeBatch = () => {
    database.prepare("UPDATE booking_requests SET status = 'accepted' WHERE id = 'accepted-01'").run();
    database.prepare("INSERT INTO workflow_transitions VALUES ('accepted-transition', 'booking_request', 'accepted-01', 'pending', 'accepted', 'helper')").run();
  };
  await expirePendingRequests(d1, fixedNow);
  assert.equal(database.prepare("SELECT status FROM booking_requests WHERE id = 'accepted-01'").get().status, "accepted");
  assert.equal(count(database, "slot_claims", "request_id = 'accepted-01'"), 1);
  assert.equal(database.prepare("SELECT status FROM booking_requests WHERE id = 'expired-02'").get().status, "expired");
  assert.equal(count(database, "slot_claims", "request_id = 'expired-02'"), 0);
  assert.equal(count(database, "workflow_transitions"), 2);
});

test("all statements retain one cutoff when a request deadline passes during the batch", async () => {
  const { database, d1 } = setup();
  addRequest(database, "expired-01");
  const crossingDeadline = "2030-01-07T10:00:01.000Z";
  let clock = fixedNow;
  database.prepare(
    "INSERT INTO booking_requests VALUES (?, 'pending', ?, ?, ?)",
  ).run("crossing-02", crossingDeadline, "2000-01-01 00:00:02", "2000-01-01 00:00:00");
  database.prepare("INSERT INTO slot_claims VALUES (?, ?, NULL)").run("claim-crossing-02", "crossing-02");

  const cutoffs = [];
  let advancedPastDeadline = false;
  d1.beforeStatement = (index, statement) => {
    cutoffs.push(statement.parameters[0]);
    if (index === 1 && !advancedPastDeadline) {
      clock = "2030-01-07T10:00:01.020Z";
      advancedPastDeadline = true;
    }
  };
  await expirePendingRequests(d1, clock);

  assert.equal(new Set(cutoffs).size, 1);
  assert.ok(cutoffs[0] < crossingDeadline);
  assert.equal(database.prepare("SELECT status FROM booking_requests WHERE id = 'expired-01'").get().status, "expired");
  assert.equal(count(database, "slot_claims", "request_id = 'expired-01'"), 0);
  assert.equal(count(database, "workflow_transitions", "entity_id = 'expired-01'"), 1);
  assert.equal(database.prepare("SELECT status FROM booking_requests WHERE id = 'crossing-02'").get().status, "pending");
  assert.equal(count(database, "slot_claims", "request_id = 'crossing-02'"), 1);
  assert.equal(count(database, "workflow_transitions", "entity_id = 'crossing-02'"), 0);

  await expirePendingRequests(d1, clock);
  assert.equal(database.prepare("SELECT status FROM booking_requests WHERE id = 'crossing-02'").get().status, "expired");
  assert.equal(count(database, "slot_claims", "request_id = 'crossing-02'"), 0);
  assert.equal(count(database, "workflow_transitions", "entity_id = 'crossing-02'"), 1);
});
