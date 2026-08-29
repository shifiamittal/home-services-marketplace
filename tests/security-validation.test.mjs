import assert from "node:assert/strict";
import test from "node:test";
import { png } from "./helpers/proof-images.mjs";

import { validateAndroidPushSubscription } from "../app/lib/push-subscription.ts";
import { sanitizeUploadFilename, validateAddressProof } from "../app/lib/upload-security.ts";

const base64url = bytes => Buffer.from(bytes).toString("base64url");
const p256dh = base64url(Uint8Array.from([0x04, ...new Array(64).fill(7)]));
const auth = base64url(Uint8Array.from(new Array(16).fill(9)));

test("push subscription route contract accepts Android Chrome FCM endpoints", () => {
  const subscription = validateAndroidPushSubscription("https://fcm.googleapis.com/fcm/send/example-token_123", p256dh, auth);
  assert.equal(subscription.endpoint, "https://fcm.googleapis.com/fcm/send/example-token_123");
});

test("push subscription route contract rejects unsafe and unsupported endpoints", () => {
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/token",
    "https://user:pass@fcm.googleapis.com/fcm/send/token",
    "https://127.0.0.1/fcm/send/token",
    "https://localhost/fcm/send/token",
    "https://fcm.googleapis.com:444/fcm/send/token",
    "https://example.com/fcm/send/token",
    "https://fcm.googleapis.com/unexpected/token",
  ]) assert.throws(() => validateAndroidPushSubscription(endpoint, p256dh, auth));
  assert.throws(() => validateAndroidPushSubscription("https://fcm.googleapis.com/fcm/send/token", "short", auth));
  assert.throws(() => validateAndroidPushSubscription("https://fcm.googleapis.com/fcm/send/token", p256dh, "short"));
});

test("address-proof validation accepts structured PNG and rejects MIME spoofing and active content", () => {
  assert.equal(validateAddressProof("../proof?.png", "image/png", png).filename, "proof-.png");
  assert.throws(() => validateAddressProof("proof.jpg", "image/jpeg", png), /mime_mismatch/);
  assert.throws(() => validateAddressProof("proof.jpg", "image/jpeg", new TextEncoder().encode("<script>alert(1)</script>")));
});

test("address-proof filenames are reduced to a safe leaf name and actual extension", () => {
  assert.equal(sanitizeUploadFilename("../../My Aadhaar<script>.exe", "png"), "My Aadhaar-script-.png");
});
