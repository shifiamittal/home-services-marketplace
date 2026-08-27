import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

// Synthetic in-memory D1 adapter. No network, providers, credentials or disk DB.
export function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON");
  const migrations = readdirSync("drizzle").filter(name => /^\d{4}.*\.sql$/.test(name)).sort();
  if (migrations.length !== 11) throw new Error("Review migration fixture count");
  for (const file of migrations) sql.exec(readFileSync(path.join("drizzle", file), "utf8"));
  const db = {
    beforeBatch: null,
    prepare(query) {
      let values = [];
      const statement = {
        query,
        bind(...args) { values = args; return statement; },
        async first() { return sql.prepare(query).get(...values) ?? null; },
        async all() { return { results: sql.prepare(query).all(...values), success: true }; },
        async run() { const result = sql.prepare(query).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
      return statement;
    },
    async batch(statements) {
      if (db.beforeBatch) { const hook = db.beforeBatch; db.beforeBatch = null; hook(); }
      sql.exec("BEGIN IMMEDIATE");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.all());
        sql.exec("COMMIT");
        return result;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  const session = { user_id: "helper", role: "provider", roles: ["provider"], name: "Synthetic helper", mobile_e164: "+10000000000" };
  const logs = [];
  const objects = new Map();
  const bucket = {
    failPut: false, failDelete: false,
    async put(key, bytes) { if (bucket.failPut) throw new Error("SENTINEL_PRIVATE"); if (!objects.has(key)) objects.set(key, bytes); return {}; },
    async delete(key) { if (bucket.failDelete) throw new Error("SENTINEL_PRIVATE"); objects.delete(key); },
  };
  const cache = new Map();
  function load(filename, override) {
    const full = path.resolve(filename);
    if (!override && cache.has(full)) return cache.get(full).exports;
    const loadedModule = { exports: {} };
    if (!override) cache.set(full, loadedModule);
    const source = override ?? readFileSync(full, "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const require = id => {
      if (id === "react" || id === "react/jsx-runtime") return createRequire(import.meta.url)(id);
      if (id === "cloudflare:workers") return { env: { BUCKET: bucket } };
      const resolved = path.resolve(path.dirname(full), id);
      if (resolved.endsWith(path.join("lib", "auth"))) return {
        getD1: async () => db, getSession: async () => session,
        roleForStorage: role => role === "provider" ? "helper" : role,
        assertSameOrigin(request) { if (request.headers.get("origin") !== new URL(request.url).origin) throw Response.json({ error: "Invalid origin" }, { status: 403 }); },
      };
      if (resolved.endsWith(path.join("lib", "push"))) return { sendPushToUser: async () => undefined };
      if (!id.startsWith(".")) throw new Error("Unexpected test dependency: " + id);
      return load(existsSync(resolved) ? resolved : resolved + ".ts");
    };
    vm.runInNewContext(compiled, { module: loadedModule, exports: loadedModule.exports, require, Response, Request, File, FormData,
      URL, crypto, Uint8Array, TextEncoder, TextDecoder, Buffer, Error,
      console: { error: (...args) => logs.push(args.join(" ")) }, fetch() { throw new Error("Network forbidden"); } }, { filename: full });
    return loadedModule.exports;
  }
  sql.exec(`INSERT INTO users(id,name,mobile_e164) VALUES ('helper','Synthetic helper','+10000000000'),('resident','Synthetic resident','+10000000001');
    INSERT INTO resident_profiles(user_id) VALUES ('resident');
    INSERT INTO resident_addresses(id,resident_user_id,house_or_flat,locality,latitude_e6,longitude_e6,is_primary)
      VALUES ('address','resident','Fixture','Fixture',0,0,1);
    INSERT INTO helper_profiles(user_id,home_locality,profile_status) VALUES ('helper','Fixture','active');
    INSERT INTO verification_documents(id,helper_user_id,document_type,r2_object_key,original_filename,content_type,size_bytes,status)
      VALUES ('proof','helper','other_address_proof','fixture/old.pdf','fixture.pdf','application/pdf',20,'pending');`);
  return { sql, db, load, session, logs, bucket, objects };
}

export function jsonRequest(body, method = "PUT") {
  return new Request("https://example.test/api", { method, headers: { origin: "https://example.test", "content-type": "application/json" }, body: JSON.stringify(body) });
}

export const profilePayload = {
  locality: "Fixture", homeAddress: "Fixture", latitude: 0, longitude: 0,
  travelDistanceKm: 5, yearsExperience: 2,
  offerings: [{ serviceType: "utensils_once", homeSize: "not_applicable", monthlyPriceRupees: 500 }],
  availability: [{ days: "mon_sat", start: "08:00", end: "12:00" }],
};

export function referenceSlot(f, requestStatus = "withdrawn", bookingStatus) {
  f.sql.exec(`INSERT INTO availability_slots(id,helper_user_id,day_of_week,start_minute,end_minute,status) VALUES ('old','helper',1,480,720,'open');
    INSERT INTO booking_requests(id,resident_user_id,helper_user_id,resident_address_id,package_snapshot_json,monthly_price_paise,requested_start_date,status,response_due_at)
      VALUES ('request','resident','helper','address','{"fixture":true}',50000,'2099-01-01','${requestStatus}',datetime('now','+1 day'));
    INSERT INTO request_slots(id,request_id,availability_slot_id,visit_ordinal,day_of_week,start_minute,end_minute)
      VALUES ('request-slot','request','old',1,1,510,540);`);
  if (bookingStatus) f.sql.exec(`INSERT INTO bookings(id,request_id,resident_user_id,helper_user_id,status,cycle_started_at,cycle_ends_at)
    VALUES ('booking','request','resident','helper','${bookingStatus}','2099-01-01','2099-02-01');
    INSERT INTO booking_slots(id,booking_id,availability_slot_id,visit_ordinal,day_of_week,start_minute,end_minute)
    VALUES ('booking-slot','booking','old',1,1,510,540);`);
}
