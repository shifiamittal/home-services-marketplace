import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fixture } from "./helpers/local-routes.mjs";
import { png, jpeg } from "./helpers/proof-images.mjs";
import { validateAddressProof } from "../app/lib/upload-security.ts";

const encode = text => new TextEncoder().encode(text);
function pdf(escaped) {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /${escaped ? "Open#41ction" : "OpenAction"} 4 0 R >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>",
    `<< /S /${escaped ? "Java#53cript" : "JavaScript"} /${escaped ? "J#53" : "JS"} (app.alert("Synthetic proof test");) >>`,
  ];
  let text = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += "xref\n0 5\n0000000000 65535 f \n" + offsets.map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("");
  return encode(text + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
function request(bytes, name, type, extra = {}) {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return new Request("https://example.test/api", { method: "POST", headers: { origin: "https://example.test" }, body: form });
}

for (const [name, type, bytes] of [["proof.jpeg", "image/jpeg", jpeg], ["proof.png", "image/png", png]]) {
  test(`valid ${type} upload replaces only the helper's own proof without classification`, async t => {
    const f = fixture(); t.after(() => f.sql.close());
    f.objects.set("fixture/old.pdf", encode("old"));
    f.sql.exec("INSERT INTO verification_documents(id,helper_user_id,document_type,r2_object_key,original_filename,content_type,size_bytes,status) VALUES ('other-proof','resident','other_address_proof','private/other','other.png','image/png',10,'verified')");
    f.objects.set("private/other", png);
    const response = await f.load("app/api/helper/address-proof/route.ts").POST(request(bytes, name, type, { helperUserId: "resident" }));
    assert.equal(response.status, 200);
    assert.equal(f.sql.prepare("SELECT status FROM verification_documents WHERE id='proof'").get().status, "deleted");
    assert.equal(f.sql.prepare("SELECT status FROM verification_documents WHERE id='other-proof'").get().status, "verified");
    assert.ok(f.objects.has("private/other"));
    assert.equal(f.objects.has("fixture/old.pdf"), false);
    const saved = f.sql.prepare("SELECT * FROM verification_documents WHERE helper_user_id='helper' AND status='pending'").get();
    assert.equal(saved.document_type, "other_address_proof");
    assert.equal(saved.content_type, type);
    assert.match(saved.r2_object_key, /^private\/address-proofs\/helper\/[0-9a-f-]{36}\.(jpg|png)$/);
    assert.equal(f.objects.size, 2);
  });
}

const invalid = [
  ["plain active PDF", "proof.pdf", "application/pdf", pdf(false)],
  ["escaped active PDF", "proof.pdf", "application/pdf", pdf(true)],
  ["ordinary PDF", "proof.pdf", "application/pdf", encode("%PDF-1.4\nSynthetic\n%%EOF")],
  ["SVG", "proof.svg", "image/svg+xml", encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ["HTML", "proof.html", "text/html", encode("<!doctype html><html></html>")],
  ["renamed PDF", "proof.png", "image/png", pdf(true)],
  ["image renamed PDF", "proof.pdf", "image/png", png],
  ["wrong MIME", "proof.png", "image/jpeg", png],
  ["wrong extension", "proof.jpg", "image/png", png],
  ["wrong magic", "proof.png", "image/png", jpeg],
  ["no extension", "proof", "image/png", png],
  ["WebP unsupported", "proof.webp", "image/webp", encode("RIFFxxxxWEBPVP8 ")],
  ["truncated PNG", "proof.png", "image/png", png.slice(0, -4)],
  ["truncated JPEG", "proof.jpg", "image/jpeg", jpeg.slice(0, -2)],
  ["bad CRC", "proof.png", "image/png", Uint8Array.from(png, (byte, index) => index === 25 ? byte ^ 1 : byte)],
  ["oversized image", "proof.png", "image/png", new Uint8Array(5 * 1024 * 1024 + 1)],
];
for (const [label, name, type, bytes] of invalid) {
  test(`${label} is rejected before any object or metadata mutation`, async t => {
    assert.throws(() => validateAddressProof(name, type, bytes));
    const f = fixture(); t.after(() => f.sql.close());
    const before = f.sql.prepare("SELECT * FROM verification_documents").all();
    const profile = f.sql.prepare("SELECT * FROM helper_profiles").all();
    let puts = 0;
    f.bucket.put = async () => { puts += 1; };
    const response = await f.load("app/api/helper/address-proof/route.ts").POST(request(bytes, name, type));
    assert.equal(response.status, 400);
    assert.equal(puts, 0);
    assert.deepEqual(f.sql.prepare("SELECT * FROM verification_documents").all(), before);
    assert.deepEqual(f.sql.prepare("SELECT * FROM helper_profiles").all(), profile);
    assert.equal(f.sql.prepare("SELECT count(*) AS n FROM analytics_events").get().n, 0);
  });
}

test("proof upload rejects unauthorized roles and cross-origin writes", async t => {
  const f = fixture(); t.after(() => f.sql.close());
  f.session.roles = ["resident"];
  const post = f.load("app/api/helper/address-proof/route.ts").POST;
  assert.equal((await post(request(png, "proof.png", "image/png"))).status, 403);
  f.session.roles = ["provider"];
  const crossOrigin = request(png, "proof.png", "image/png");
  crossOrigin.headers.set("origin", "https://other.test");
  assert.equal((await post(crossOrigin)).status, 403);
  assert.equal(f.objects.size, 0);
});

test("proof setup copy and picker are image-only and have no classification selector", () => {
  const source = readFileSync("app/page.tsx", "utf8");
  const section = source.split("\n").find(line => line.includes("2. Address proof"));
  assert.ok(section.includes('accept=".jpg,.jpeg,.png,image/jpeg,image/png"'));
  assert.match(section, /photograph or image scan/);
  assert.match(section, /JPEG or PNG/);
  assert.doesNotMatch(section, /PDF|WebP|<select|Document type|Aadhaar|voter/);
  assert.doesNotMatch(source, /addressProofType|form.append\("documentType"/);
});
