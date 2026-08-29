import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const ORDERED_MIGRATIONS = Object.freeze([
  ["0000_wet_obadiah_stane.sql", "a9928b0f74532b2a9868827546bcf18fb97086ca310cee3421cccc0ecdfe8f78"],
  ["0001_spooky_freak.sql", "61daa01c43f63d54ffe09534ce72e3617c1454f259bceb15e3e7b510fec1c248"],
  ["0002_tired_manta.sql", "41948f7a56919b0be9a6b3356298e5b1039b84f29de9e18c7dfa0c18681bba62"],
  ["0003_lyrical_iron_monger.sql", "02b78d1df2e7081c1d277c44a8a63e9bd43af36ad6432cf48effa89a9014b6dd"],
  ["0004_puzzling_tag.sql", "2c8eaab75f31b99185a0e4333f897fbf873f940dbf1ead59e401d5869b979ee5"],
  ["0005_optimal_newton_destine.sql", "9641b391a1e43796be88eac8ee6ce34fc80e2e0645a6c6e5dd2e17231ceb5efc"],
  ["0006_oval_ultimates.sql", "a8f46796e64c3b516e29e8946148877aa9236321c66c81f633cad1333d72a03c"],
  ["0007_strange_calypso.sql", "1f3df6c92ddea8a92905b20983f8ebd1ba6b2bce98809ff75e9c6d2f0d89056d"],
  ["0008_wealthy_lady_deathstrike.sql", "905ba2617b25cb811c1a1480f83b5648ca611e9f1a9a70be173a91cf52f8024b"],
  ["0009_unusual_black_cat.sql", "4ed94d05f1a4a9d4f15d299ba347416251c1dd856954fc9bde878e8b2ecd9e55"],
  ["0010_lonely_boom_boom.sql", "b0df0eb0dcdfe6df2d9bd5485dad818abc44181abf5623655a9ab44d7b51f148"],
  ["0011_fancy_exiles.sql", "cf92154d7df0a5128a7189e5f541faf98498b56480004481455f134defc186f3"],
  ["0012_confused_starbolt.sql", "1794c24b701122ccda5cd23717ffceb469fe59cc9c4b6ee59c3767ad81a27d79"],
].map(([name, sha256]) => Object.freeze({ name, sha256 })));

export const ORDERED_MIGRATION_NAMES = Object.freeze(ORDERED_MIGRATIONS.map(({ name }) => name));

const MIGRATION_SCHEMA_EFFECTS = Object.freeze([
  {
    tablesAdded: [
      "analytics_events", "availability_slots", "booking_requests", "booking_slots",
      "booking_status_history", "bookings", "consents", "helper_offerings", "helper_profiles",
      "issue_status_history", "issues", "notification_log", "request_slots", "resident_addresses",
      "resident_profiles", "reviews", "sessions", "user_roles", "users", "verification_documents",
    ],
    indexesAdded: [
      "analytics_events_name_time_idx", "analytics_events_user_time_idx",
      "availability_slots_helper_day_idx", "booking_requests_resident_idx",
      "booking_requests_helper_idx", "booking_slots_booking_idx", "booking_slots_slot_unique",
      "booking_status_history_booking_idx", "bookings_request_unique", "bookings_resident_status_idx",
      "bookings_helper_status_idx", "consents_user_idx", "helper_offerings_helper_idx",
      "helper_offerings_package_unique", "issue_status_history_issue_idx", "issues_case_number_unique",
      "issues_status_created_idx", "notification_log_user_idx", "notification_log_status_idx",
      "request_slots_request_idx", "request_slots_held_slot_unique", "resident_addresses_user_idx",
      "reviews_booking_author_unique", "reviews_subject_idx", "sessions_user_idx",
      "sessions_token_unique", "user_roles_user_role_unique", "users_mobile_unique",
      "verification_documents_helper_idx",
    ],
  },
  { tablesAdded: ["service_visits"], indexesAdded: ["service_visits_booking_date_idx", "service_visits_status_date_idx"] },
  { indexesRemoved: ["user_roles_user_role_unique"], indexesAdded: ["user_roles_user_unique"] },
  { indexesAdded: ["availability_slots_group_idx"] },
  {},
  { indexesAdded: ["booking_slots_time_idx", "request_slots_time_idx"] },
  {},
  {
    tablesAdded: ["booking_cancellations", "trial_payments"],
    indexesAdded: ["booking_cancellations_booking_unique", "trial_payments_booking_unique", "trial_payments_resident_status_idx", "trial_payments_helper_status_idx"],
  },
  { tablesAdded: ["push_subscriptions"], indexesAdded: ["push_subscriptions_endpoint_unique", "push_subscriptions_user_status_idx"] },
  {},
  {
    tablesAdded: ["issue_case_counter", "slot_claims", "workflow_transitions"],
    indexesAdded: [
      "slot_claims_helper_day_minute_unique", "slot_claims_request_idx", "slot_claims_booking_idx",
      "workflow_transitions_once_unique", "notification_log_dedupe_unique",
      "booking_requests_one_pending_per_resident", "booking_status_history_transition_unique",
      "service_visits_slot_trial_unique",
    ],
  },
  {},
  { tablesAdded: ["external_busy_periods"], indexesAdded: ["external_busy_periods_helper_day_idx"] },
].map((effect) => Object.freeze({
  tablesAdded: Object.freeze(effect.tablesAdded ?? []),
  indexesAdded: Object.freeze(effect.indexesAdded ?? []),
  indexesRemoved: Object.freeze(effect.indexesRemoved ?? []),
})));

if (MIGRATION_SCHEMA_EFFECTS.length !== ORDERED_MIGRATIONS.length) {
  throw new Error("Migration schema contract is incomplete");
}

export function expectedSchemaManifest(appliedCount) {
  if (!Number.isInteger(appliedCount) || appliedCount < 0 || appliedCount > ORDERED_MIGRATIONS.length) {
    throw new Error("Applied migration count is outside the authoritative contract");
  }
  const tables = new Set();
  const indexes = new Set();
  for (const effect of MIGRATION_SCHEMA_EFFECTS.slice(0, appliedCount)) {
    for (const name of effect.indexesRemoved) {
      if (!indexes.delete(name)) throw new Error(`Schema contract removes an unknown index: ${name}`);
    }
    for (const name of effect.tablesAdded) {
      if (tables.has(name)) throw new Error(`Schema contract adds a duplicate table: ${name}`);
      tables.add(name);
    }
    for (const name of effect.indexesAdded) {
      if (indexes.has(name)) throw new Error(`Schema contract adds a duplicate index: ${name}`);
      indexes.add(name);
    }
  }
  return Object.freeze({ tables: Object.freeze([...tables].sort()), indexes: Object.freeze([...indexes].sort()) });
}

function requireNameManifest(value, label) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new Error(`${label} is malformed`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
}

export function validateSchemaForPlan(plan, { applicationTables, indexes }) {
  if (!plan || !Array.isArray(plan.applied)) throw new Error("Migration plan is malformed");
  requireNameManifest(applicationTables, "Application table manifest");
  requireNameManifest(indexes, "Index manifest");
  const expected = expectedSchemaManifest(plan.applied.length);
  if (JSON.stringify([...applicationTables].sort()) !== JSON.stringify(expected.tables)) {
    throw new Error("Remote application-table manifest does not match the applied migration prefix");
  }
  if (JSON.stringify([...indexes].sort()) !== JSON.stringify(expected.indexes)) {
    throw new Error("Remote index manifest does not match the applied migration prefix");
  }
  return expected;
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

export function validateProductionConfiguration(config, expected) {
  requirePlainObject(config, "Production configuration");
  requirePlainObject(expected, "Expected production target");
  const databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const buckets = Array.isArray(config.r2_buckets) ? config.r2_buckets : [];
  const databaseMatches = databases.filter((item) => item?.binding === "DB");
  const bucketMatches = buckets.filter((item) => item?.binding === "BUCKET");
  if (databaseMatches.length !== 1 || bucketMatches.length !== 1) {
    throw new Error("Production storage bindings are missing or duplicated");
  }
  const database = databaseMatches[0];
  const bucket = bucketMatches[0];
  const checks = [
    [config.name, expected.workerName, "Worker name"],
    [config.account_id, expected.accountId, "account ID"],
    [database.database_id, expected.databaseId, "D1 database ID"],
    [database.database_name, expected.databaseName, "D1 database name"],
    [database.migrations_dir, "./drizzle", "D1 migrations directory"],
    [bucket.bucket_name, expected.bucketName, "R2 bucket name"],
    [config.workers_dev, true, "Workers.dev setting"],
    [config.preview_urls, false, "preview URL setting"],
  ];
  for (const [actual, wanted, label] of checks) {
    if (actual !== wanted) throw new Error(`Unexpected ${label}`);
  }
  if (Object.hasOwn(config, "route") || Object.hasOwn(config, "routes")) {
    throw new Error("Production configuration must not declare routes or custom domains");
  }
  return Object.freeze({ database, bucket });
}

const exactMigrationName = /^\d{4}_[A-Za-z0-9_]+\.sql$/;

function requireMigrationArray(value, label) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !exactMigrationName.test(name))) {
    throw new Error(`${label} contains a malformed migration name`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains a duplicate migration`);
}

export function parsePendingMigrationOutput(output) {
  if (typeof output !== "string") throw new Error("Pending migration output is not text");
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  const sqlTokens = clean.match(/[^\s|│]+\.sql[^\s|│]*/g) ?? [];
  if (sqlTokens.some((token) => !exactMigrationName.test(token))) {
    throw new Error("Pending migration output contains a partial or malformed migration name");
  }
  requireMigrationArray(sqlTokens, "Pending migration output");
  return sqlTokens;
}

export function computeMigrationPlan({ ledger, pending, applicationTables }) {
  requireMigrationArray(ledger, "Migration ledger");
  requireMigrationArray(pending, "Pending migrations");
  if (!Array.isArray(applicationTables) || applicationTables.some((name) => typeof name !== "string")) {
    throw new Error("Application table manifest is malformed");
  }
  if (new Set(applicationTables).size !== applicationTables.length) {
    throw new Error("Application table manifest contains duplicates");
  }
  if (ledger.length > ORDERED_MIGRATION_NAMES.length) throw new Error("Migration ledger is longer than the repository contract");
  for (let index = 0; index < ledger.length; index += 1) {
    if (ledger[index] !== ORDERED_MIGRATION_NAMES[index]) {
      throw new Error("Migration ledger is not an exact ordered prefix");
    }
  }
  const suffix = ORDERED_MIGRATION_NAMES.slice(ledger.length);
  if (pending.length !== suffix.length || pending.some((name, index) => name !== suffix[index])) {
    throw new Error("Pending migrations are not the exact ordered suffix");
  }
  if (ledger.length === 0 && applicationTables.length !== 0) {
    throw new Error("A nonempty database cannot have an absent or empty migration ledger");
  }
  if (ledger.length !== 0 && applicationTables.length === 0) {
    throw new Error("A populated migration ledger cannot describe an empty database");
  }
  return Object.freeze({ applied: [...ledger], pending: [...suffix] });
}

export function requireDeploymentReady(plan) {
  if (!plan || !Array.isArray(plan.applied) || !Array.isArray(plan.pending)
      || plan.applied.length !== ORDERED_MIGRATION_NAMES.length || plan.pending.length !== 0
      || plan.applied.some((name, index) => name !== ORDERED_MIGRATION_NAMES[index])) {
    throw new Error("Application deployment requires the complete migration ledger and zero pending migrations");
  }
}

export function requireR2RolloutReady(plan, { r2Private, r2HasObjects }) {
  if (!plan || !Array.isArray(plan.applied)) throw new Error("Migration plan is malformed");
  if (r2Private !== true || typeof r2HasObjects !== "boolean") {
    throw new Error("R2 rollout state is malformed or not private");
  }
  if (plan.applied.length === 0 && r2HasObjects) {
    throw new Error("An empty D1 bootstrap requires an empty R2 bucket");
  }
  return Object.freeze({ r2Private, r2HasObjects });
}

export function validateRepositoryMigrations(directory) {
  const actualNames = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  if (actualNames.length !== ORDERED_MIGRATION_NAMES.length
      || actualNames.some((name, index) => name !== ORDERED_MIGRATION_NAMES[index])) {
    throw new Error("Repository migration files do not exactly match the authoritative ordered list");
  }
  for (const { name, sha256 } of ORDERED_MIGRATIONS) {
    const source = readFileSync(path.join(directory, name), "utf8").replaceAll("\r\n", "\n");
    const actual = createHash("sha256").update(source).digest("hex");
    if (actual !== sha256) throw new Error(`Migration checksum mismatch: ${name}`);
  }
  return [...ORDERED_MIGRATION_NAMES];
}
