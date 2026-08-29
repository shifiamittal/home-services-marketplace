import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import {
  ORDERED_MIGRATION_NAMES,
  computeMigrationPlan,
  expectedSchemaManifest,
  parsePendingMigrationOutput,
  requireDeploymentReady,
  requireR2RolloutReady,
  validateProductionConfiguration,
  validateRepositoryMigrations,
  validateSchemaForPlan,
} from "../scripts/production-migration-contract.mjs";

const established = ORDERED_MIGRATION_NAMES.slice(0, 11);
const incremental = ORDERED_MIGRATION_NAMES.slice(11);
const tables = ["users"];
const expectedTarget = {
  workerName: "nivasa-home-help",
  accountId: "0c53a1d6277d240fe99359ce0495fe9d",
  databaseId: "508b580c-9da0-41ad-97d2-4695047eb2b0",
  databaseName: "nivasa-production",
  bucketName: "nivasa-private-address-proofs",
};
const reviewedConfig = {
  name: "nivasa-home-help",
  account_id: "0c53a1d6277d240fe99359ce0495fe9d",
  workers_dev: true,
  preview_urls: false,
  d1_databases: [{
    binding: "DB",
    database_id: "508b580c-9da0-41ad-97d2-4695047eb2b0",
    database_name: "nivasa-production",
    migrations_dir: "./drizzle",
  }],
  r2_buckets: [{ binding: "BUCKET", bucket_name: "nivasa-private-address-proofs" }],
};

test("the reviewed public Workers.dev configuration passes", () => {
  assert.doesNotThrow(() => validateProductionConfiguration(reviewedConfig, expectedTarget));
});

test("the checked-in reviewed production configuration passes", () => {
  const source = readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotThrow(() => validateProductionConfiguration(JSON.parse(source), expectedTarget));
});

for (const [name, mutate] of [
  ["workers_dev false", (config) => { config.workers_dev = false; }],
  ["workers_dev missing", (config) => { delete config.workers_dev; }],
  ["workers_dev non-boolean", (config) => { config.workers_dev = "true"; }],
  ["preview_urls true", (config) => { config.preview_urls = true; }],
  ["preview_urls missing", (config) => { delete config.preview_urls; }],
  ["preview_urls non-boolean", (config) => { config.preview_urls = 0; }],
  ["account mismatch", (config) => { config.account_id = "wrong"; }],
  ["Worker name mismatch", (config) => { config.name = "wrong"; }],
  ["D1 binding mismatch", (config) => { config.d1_databases[0].binding = "WRONG"; }],
  ["D1 database name mismatch", (config) => { config.d1_databases[0].database_name = "wrong"; }],
  ["R2 binding mismatch", (config) => { config.r2_buckets[0].binding = "WRONG"; }],
  ["R2 bucket name mismatch", (config) => { config.r2_buckets[0].bucket_name = "wrong"; }],
]) {
  test(`rejects ${name}`, () => {
    const config = structuredClone(reviewedConfig);
    mutate(config);
    assert.throws(() => validateProductionConfiguration(config, expectedTarget));
  });
}

test("rejects custom routes", () => {
  assert.throws(() => validateProductionConfiguration({ ...reviewedConfig, routes: [] }, expectedTarget));
});

test("empty database bootstraps with all 13 migrations in order", () => {
  const plan = computeMigrationPlan({ ledger: [], pending: ORDERED_MIGRATION_NAMES, applicationTables: [] });
  assert.deepEqual(plan.pending, ORDERED_MIGRATION_NAMES);
});

test("established database applies only 0011 and 0012 in order", () => {
  const plan = computeMigrationPlan({ ledger: established, pending: incremental, applicationTables: tables });
  assert.deepEqual(plan.pending, ["0011_fancy_exiles.sql", "0012_confused_starbolt.sql"]);
});

test("empty D1 bootstrap accepts empty R2", () => {
  const plan = computeMigrationPlan({ ledger: [], pending: ORDERED_MIGRATION_NAMES, applicationTables: [] });
  assert.doesNotThrow(() => requireR2RolloutReady(plan, { r2Private: true, r2HasObjects: false }));
});

test("empty D1 bootstrap rejects nonempty R2", () => {
  const plan = computeMigrationPlan({ ledger: [], pending: ORDERED_MIGRATION_NAMES, applicationTables: [] });
  assert.throws(
    () => requireR2RolloutReady(plan, { r2Private: true, r2HasObjects: true }),
    /empty D1 bootstrap requires an empty R2 bucket/,
  );
});

for (const r2HasObjects of [false, true]) {
  test(`established migration prefix through 0010 accepts ${r2HasObjects ? "nonempty" : "empty"} R2`, () => {
    const plan = computeMigrationPlan({ ledger: established, pending: incremental, applicationTables: tables });
    assert.doesNotThrow(() => requireR2RolloutReady(plan, { r2Private: true, r2HasObjects }));
  });
}

test("every valid established prefix accepts existing private R2 objects", () => {
  for (let appliedCount = 1; appliedCount <= ORDERED_MIGRATION_NAMES.length; appliedCount += 1) {
    const plan = { applied: ORDERED_MIGRATION_NAMES.slice(0, appliedCount) };
    assert.doesNotThrow(() => requireR2RolloutReady(plan, { r2Private: true, r2HasObjects: true }));
  }
});

test("fully migrated database is deployment-ready", () => {
  const plan = computeMigrationPlan({ ledger: ORDERED_MIGRATION_NAMES, pending: [], applicationTables: tables });
  assert.doesNotThrow(() => requireDeploymentReady(plan));
});

for (let appliedCount = 0; appliedCount <= ORDERED_MIGRATION_NAMES.length; appliedCount += 1) {
  test(`schema and pending suffix match valid migration prefix ${appliedCount}`, () => {
    const manifest = expectedSchemaManifest(appliedCount);
    const plan = computeMigrationPlan({
      ledger: ORDERED_MIGRATION_NAMES.slice(0, appliedCount),
      pending: ORDERED_MIGRATION_NAMES.slice(appliedCount),
      applicationTables: manifest.tables,
    });
    assert.deepEqual(plan.pending, ORDERED_MIGRATION_NAMES.slice(appliedCount));
    assert.deepEqual(validateSchemaForPlan(plan, {
      applicationTables: manifest.tables,
      indexes: manifest.indexes,
    }), manifest);
  });
}

for (const [label, appliedCount] of [
  ["empty", 0], ["0000", 1], ["0001", 2], ["0007", 8],
  ["0010", 11], ["0011", 12], ["0012", 13],
]) {
  test(`${label} prefix has its exact expected schema`, () => {
    const manifest = expectedSchemaManifest(appliedCount);
    const plan = {
      applied: ORDERED_MIGRATION_NAMES.slice(0, appliedCount),
      pending: ORDERED_MIGRATION_NAMES.slice(appliedCount),
    };
    assert.doesNotThrow(() => validateSchemaForPlan(plan, {
      applicationTables: manifest.tables,
      indexes: manifest.indexes,
    }));
  });
}

test("prefix schema validation rejects missing and unexpected tables and indexes", () => {
  const appliedCount = 11;
  const manifest = expectedSchemaManifest(appliedCount);
  const plan = {
    applied: ORDERED_MIGRATION_NAMES.slice(0, appliedCount),
    pending: ORDERED_MIGRATION_NAMES.slice(appliedCount),
  };
  assert.throws(() => validateSchemaForPlan(plan, { applicationTables: manifest.tables.slice(1), indexes: manifest.indexes }));
  assert.throws(() => validateSchemaForPlan(plan, { applicationTables: [...manifest.tables, "external_busy_periods"], indexes: manifest.indexes }));
  assert.throws(() => validateSchemaForPlan(plan, { applicationTables: manifest.tables, indexes: manifest.indexes.slice(1) }));
  assert.throws(() => validateSchemaForPlan(plan, { applicationTables: manifest.tables, indexes: [...manifest.indexes, "unexpected_index"] }));
});

test("rejects a schema from a different valid ledger prefix", () => {
  const plan = {
    applied: ORDERED_MIGRATION_NAMES.slice(0, 11),
    pending: ORDERED_MIGRATION_NAMES.slice(11),
  };
  const future = expectedSchemaManifest(13);
  assert.throws(() => validateSchemaForPlan(plan, { applicationTables: future.tables, indexes: future.indexes }));
});

for (const [name, ledger] of [
  ["missing middle migration", [...established.slice(0, 5), ...established.slice(6)]],
  ["unknown migration", [...established.slice(0, 10), "0010_unknown.sql"]],
  ["duplicate migration", [...established, established.at(-1)]],
  ["reordered ledger", [...established.slice(0, 9), established[10], established[9]]],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => computeMigrationPlan({ ledger, pending: incremental, applicationTables: tables }));
  });
}

test("rejects a nonempty database with an empty ledger", () => {
  assert.throws(() => computeMigrationPlan({ ledger: [], pending: ORDERED_MIGRATION_NAMES, applicationTables: tables }));
});

test("rejects repository file/list mismatch", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nivasa-migrations-"));
  try {
    writeFileSync(path.join(directory, ORDERED_MIGRATION_NAMES[0]), "SELECT 1;\n");
    assert.throws(() => validateRepositoryMigrations(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the repository contains exactly the authoritative 13 migration files", () => {
  assert.deepEqual(validateRepositoryMigrations("drizzle"), ORDERED_MIGRATION_NAMES);
});

test("every prefix manifest matches the table and index effects in its migration SQL", () => {
  const tables = new Set();
  const indexes = new Set();
  assert.deepEqual(expectedSchemaManifest(0), { tables: [], indexes: [] });
  for (const [index, name] of ORDERED_MIGRATION_NAMES.entries()) {
    const source = readFileSync(path.join("drizzle", name), "utf8");
    for (const match of source.matchAll(/CREATE TABLE `([^`]+)`/g)) tables.add(match[1]);
    for (const match of source.matchAll(/DROP INDEX `([^`]+)`/g)) indexes.delete(match[1]);
    for (const match of source.matchAll(/CREATE (?:UNIQUE )?INDEX `([^`]+)`/g)) indexes.add(match[1]);
    assert.deepEqual(expectedSchemaManifest(index + 1), {
      tables: [...tables].sort(),
      indexes: [...indexes].sort(),
    });
  }
});

test("rejects partial and ambiguous pending names", () => {
  assert.throws(() => parsePendingMigrationOutput("0011_fancy_exiles.sql.extra"));
  assert.throws(() => parsePendingMigrationOutput("0011_fancy_exiles.sql 0011_fancy_exiles.sql"));
});

test("deployment is rejected while either incremental migration remains pending", () => {
  for (const ledgerLength of [11, 12]) {
    const plan = computeMigrationPlan({
      ledger: ORDERED_MIGRATION_NAMES.slice(0, ledgerLength),
      pending: ORDERED_MIGRATION_NAMES.slice(ledgerLength),
      applicationTables: tables,
    });
    assert.throws(() => requireDeploymentReady(plan));
  }
});

test("the migration application sequence is exactly the computed suffix", () => {
  const applied = [];
  const plan = computeMigrationPlan({ ledger: established, pending: incremental, applicationTables: tables });
  for (const migration of plan.pending) applied.push(migration);
  assert.deepEqual(applied, ["0011_fancy_exiles.sql", "0012_confused_starbolt.sql"]);
  assert.equal(new Set(applied).size, applied.length);
});

test("both production workflows consume the shared migration contract", () => {
  const migrationWorkflow = readFileSync(".github/workflows/cloudflare-production-migrations.yml", "utf8");
  const deploymentWorkflow = readFileSync(".github/workflows/cloudflare-production-deployment.yml", "utf8");
  for (const workflow of [migrationWorkflow, deploymentWorkflow]) {
    assert.match(workflow, /scripts\/production-migration-contract\.mjs/);
    assert.doesNotMatch(workflow, /completed 11-entry ledger|reviewed 11 migrations|reviewed 11-file set/);
  }
  assert.equal((migrationWorkflow.match(/npm run cloudflare:d1:migrations:apply/g) ?? []).length, 1);
  assert.match(migrationWorkflow, /computeMigrationPlan/);
  assert.ok((migrationWorkflow.match(/validateSchemaForPlan/g) ?? []).length >= 3);
  assert.match(migrationWorkflow, /preflight\.rowCounts/);
  assert.doesNotMatch(migrationWorkflow, /rows\.length !== 27|expected\.length !== 27/);
  assert.match(deploymentWorkflow, /requireDeploymentReady/);
  assert.match(deploymentWorkflow, /complete 13-entry ledger verified; zero migrations pending/);
});

test("production migration and deployment scripts never access R2 object contents or mutate R2", () => {
  const files = [
    ".github/workflows/cloudflare-production-migrations.yml",
    ".github/workflows/cloudflare-production-deployment.yml",
    "scripts/cloudflare-production.sh",
  ];
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /^\s*(?:\.\/node_modules\/\.bin\/)?wrangler\s+r2\s+object\s+(?:get|put|delete)/im);
  assert.doesNotMatch(source, /\/r2\/buckets\/[^\s'"`]+\/objects\/[^?\s'"`]+/i);
  assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"][\s\S]{0,300}\/r2\/buckets\//i);
});

test("both workflows parse and every embedded Bash and JavaScript block is syntactically valid", () => {
  for (const file of [
    ".github/workflows/cloudflare-production-migrations.yml",
    ".github/workflows/cloudflare-production-deployment.yml",
  ]) {
    const document = yaml.load(readFileSync(file, "utf8"));
    assert.ok(document && typeof document === "object");
    for (const job of Object.values(document.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== "string") continue;
        const shell = spawnSync("bash", ["-n"], {
          input: step.run,
          encoding: "utf8",
        });
        assert.equal(shell.status, 0, `${file}: ${step.name ?? "unnamed step"}: ${shell.stderr}`);
        for (const part of step.run.split("<<'NODE'").slice(1)) {
          const source = part.split(/\n\s*NODE(?:\n|$)/, 1)[0].replace(/^\r?\n/, "");
          const javascript = spawnSync(process.execPath, ["--check", "--input-type=module"], {
            input: source,
            encoding: "utf8",
          });
          assert.equal(javascript.status, 0, `${file}: ${step.name ?? "unnamed step"}: ${javascript.stderr}`);
        }
        for (const match of step.run.matchAll(/node -e "([^"]*)"/g)) {
          const javascript = spawnSync(process.execPath, ["--check"], {
            input: match[1],
            encoding: "utf8",
          });
          assert.equal(javascript.status, 0, `${file}: ${step.name ?? "unnamed step"}: ${javascript.stderr}`);
        }
      }
    }
  }
});
