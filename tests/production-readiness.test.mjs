import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { productionConfigurationReady, productionReadinessResponse } from "../worker/production-readiness.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredSettings = [
  "NIVASA_SESSION_SECRET",
  "MSG91_AUTH_KEY",
  "NEXT_PUBLIC_MSG91_WIDGET_ID",
  "NEXT_PUBLIC_MSG91_WIDGET_TOKEN",
  "GOOGLE_MAPS_BROWSER_KEY",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_JWK",
  "VAPID_SUBJECT",
  "DB",
  "BUCKET",
  "ASSETS",
  "IMAGES",
];

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function generateVapidKeypair() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const [privateJwk, publicPoint] = await Promise.all([
    crypto.subtle.exportKey("jwk", keys.privateKey),
    crypto.subtle.exportKey("raw", keys.publicKey),
  ]);
  return { privateJwk, publicKey: base64url(new Uint8Array(publicPoint)) };
}

const matchingPair = await generateVapidKeypair();
const alternatePair = await generateVapidKeypair();

function validEnvironment(pair = matchingPair) {
  return {
    NIVASA_SESSION_SECRET: Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index)).toString("hex"),
    MSG91_AUTH_KEY: ["test", "opaque", "value"].join("-"),
    NEXT_PUBLIC_MSG91_WIDGET_ID: "widget-identifier",
    NEXT_PUBLIC_MSG91_WIDGET_TOKEN: "browser-widget-token",
    GOOGLE_MAPS_BROWSER_KEY: "browser-maps-key",
    VAPID_PUBLIC_KEY: pair.publicKey,
    VAPID_PRIVATE_JWK: JSON.stringify(pair.privateJwk),
    VAPID_SUBJECT: "mailto:operations@example.invalid",
    DB: { prepare() {} },
    BUCKET: { put() {}, delete() {} },
    ASSETS: { fetch() {} },
    IMAGES: { input() {} },
  };
}

test("complete production configuration with a matching VAPID keypair is ready", async () => {
  assert.equal(await productionConfigurationReady(validEnvironment()), true);
});

for (const name of requiredSettings) {
  test(`production configuration fails closed when ${name} is absent`, async () => {
    const environment = validEnvironment();
    delete environment[name];
    assert.equal(await productionConfigurationReady(environment), false);
  });
}

test("validly formatted but mismatched VAPID public and private keys fail", async () => {
  const environment = validEnvironment();
  environment.VAPID_PUBLIC_KEY = alternatePair.publicKey;
  assert.equal(await productionConfigurationReady(environment), false);
});

test("changing only the VAPID private scalar fails", async () => {
  const environment = validEnvironment();
  const privateJwk = JSON.parse(environment.VAPID_PRIVATE_JWK);
  privateJwk.d = alternatePair.privateJwk.d;
  environment.VAPID_PRIVATE_JWK = JSON.stringify(privateJwk);
  assert.equal(await productionConfigurationReady(environment), false);
});

for (const coordinate of ["x", "y"]) {
  test(`changing only the VAPID private ${coordinate} coordinate fails`, async () => {
    const environment = validEnvironment();
    const privateJwk = JSON.parse(environment.VAPID_PRIVATE_JWK);
    privateJwk[coordinate] = alternatePair.privateJwk[coordinate];
    environment.VAPID_PRIVATE_JWK = JSON.stringify(privateJwk);
    assert.equal(await productionConfigurationReady(environment), false);
  });
}

test("malformed security configuration fails closed", async () => {
  const invalidValues = {
    NIVASA_SESSION_SECRET: "aa".repeat(32),
    VAPID_PUBLIC_KEY: "not-a-public-key",
    VAPID_PRIVATE_JWK: JSON.stringify({ kty: "EC", crv: "P-256" }),
    VAPID_SUBJECT: "http://example.invalid",
  };
  for (const [name, value] of Object.entries(invalidValues)) {
    const environment = validEnvironment();
    environment[name] = value;
    assert.equal(await productionConfigurationReady(environment), false, name);
  }
});

test("production failure is generic and does not reveal configuration details", async () => {
  const environment = validEnvironment();
  delete environment.MSG91_AUTH_KEY;
  const response = await productionReadinessResponse(new Request("https://example.invalid/anything"), environment, true);
  assert.equal(response?.status, 503);
  assert.deepEqual(await response?.json(), { ready: false });
  const readinessResponse = await productionReadinessResponse(
    new Request("https://example.invalid/__nivasa/readiness"), environment, true,
  );
  const serialized = JSON.stringify(await readinessResponse?.json());
  for (const name of requiredSettings) assert.equal(serialized.includes(name), false);
  assert.equal(serialized.includes("test-opaque-value"), false);
  assert.equal(serialized.includes(environment.VAPID_PUBLIC_KEY), false);
  assert.equal(serialized.includes(environment.VAPID_PRIVATE_JWK), false);
});

test("readiness endpoint reports only boolean ready state", async () => {
  const response = await productionReadinessResponse(
    new Request("https://example.invalid/__nivasa/readiness"), validEnvironment(), true,
  );
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response?.json(), { ready: true });
});

test("development and Sites requests bypass the production gate", async () => {
  const response = await productionReadinessResponse(new Request("https://example.invalid/"), {}, false);
  assert.equal(response, null);
  const viteConfig = readFileSync(path.join(projectRoot, "vite.config.ts"), "utf8");
  assert.match(viteConfig, /NIVASA_DEPLOY_TARGET === "cloudflare-production"/);
  assert.match(viteConfig, /__NIVASA_CLOUDFLARE_PRODUCTION__:\s*JSON\.stringify\(isIndependentCloudflareProduction\)/);
});

test("production social metadata uses the reviewed Workers.dev origin", () => {
  const layout = readFileSync(path.join(projectRoot, "app", "layout.tsx"), "utf8");
  const expected = "https://nivasa-home-help.nivasa-app.workers.dev/og.png";
  assert.equal(layout.split(expected).length - 1, 2);
  assert.doesNotMatch(layout, /chatgpt\.site/);
});
