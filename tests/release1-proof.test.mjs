import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fixture } from "./helpers/local-routes.mjs";

const route = "app/api/helper/address-proof/route.ts";
function upload() {
  const form = new FormData();
  form.append("file", new File(["%PDF-1.4\nFixture\n%%EOF"], "fixture.pdf", { type: "application/pdf" }));
  form.append("documentType", "other_address_proof");
  return new Request("https://example.test/api", { method: "POST", headers: { origin: "https://example.test" }, body: form });
}

test("proof upload has no durable operation-ID, staging or cleanup protocol", () => {
  const backend = readFileSync(route, "utf8");
  const page = readFileSync("app/page.tsx", "utf8");
  const start = page.indexOf("  const uploadAddressProof =");
  const end = page.indexOf("  const saveHelperProfile =", start);
  assert.ok(start >= 0 && end > start);
  const client = page.slice(start, end);
  assert.deepEqual([...backend.matchAll(/form.get\("([^"]+)"\)/g)].map(match => match[1]), ["file", "documentType"]);
  assert.deepEqual([...client.matchAll(/form.append\("([^"]+)"/g)].map(match => match[1]), ["file", "documentType"]);
  assert.match(backend, /const documentId = crypto.randomUUID\(\)/);
  assert.match(client, /form.append\("file", retry.file\)/);
  assert.match(client, /proofRetryRef.current = \{ file, documentType: addressProofType \}/);
  assert.match(client, /proofRetryRef.current = null/);
  assert.doesNotMatch(client, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(backend + client, /upload[_-]?id|operation[_-]?id|idempotency|upload_staged|superseded_cleaned|staging|proof_cleanup/i);
});

test("base upload uses fresh server identities and preserves helper moderation", async () => {
  const f = fixture();
  try {
    f.sql.exec("UPDATE helper_profiles SET profile_status='blocked'");
    const post = f.load(route).POST;
    assert.equal((await post(upload())).status, 200);
    const first = f.sql.prepare("SELECT id FROM verification_documents WHERE status='pending'").get().id;
    assert.equal((await post(upload())).status, 200);
    const second = f.sql.prepare("SELECT id FROM verification_documents WHERE status='pending'").get().id;
    assert.notEqual(first, second);
    assert.equal(f.objects.size, 1);
    assert.equal(f.sql.prepare("SELECT profile_status FROM helper_profiles").get().profile_status, "blocked");
    assert.deepEqual(f.sql.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { f.sql.close(); }
});

test("base upload role protection and failed write preserve existing proof", async () => {
  const f = fixture();
  try {
    const post = f.load(route).POST;
    f.session.roles = ["resident"];
    assert.equal((await post(upload())).status, 403);
    f.session.roles = ["provider"];
    f.bucket.failPut = true;
    assert.equal((await post(upload())).status, 500);
    assert.equal(f.objects.size, 0);
    assert.equal(f.sql.prepare("SELECT status FROM verification_documents WHERE id='proof'").get().status, "pending");
  } finally { f.sql.close(); }
});

test("deferred base limitation: R2 write before failed D1 publication can leave an unreferenced object", async () => {
  const f = fixture();
  try {
    f.db.beforeBatch = () => { throw new Error("SENTINEL_PRIVATE"); };
    const response = await f.load(route).POST(upload());
    assert.equal(response.status, 500);
    assert.equal(f.objects.size, 1);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM verification_documents").get().n, 1);
    assert.doesNotMatch(JSON.stringify(await response.json()) + f.logs.join(""), /SENTINEL_PRIVATE/);
  } finally { f.sql.close(); }
});
