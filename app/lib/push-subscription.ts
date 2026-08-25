const ANDROID_PUSH_HOSTS = new Set(["fcm.googleapis.com"]);

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

function validBase64Url(value: string, min: number, max: number) {
  return value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}

export function validateAndroidPushSubscription(endpointValue: string, p256dh: string, auth: string) {
  if (!endpointValue || endpointValue.length > 2_048) throw new Error("The push endpoint is too long.");
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error("The push endpoint is not a valid URL.");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new Error("The push endpoint must be a credential-free HTTPS URL.");
  }
  if (endpoint.port && endpoint.port !== "443") throw new Error("The push endpoint uses an unsupported port.");
  const hostname = endpoint.hostname.toLowerCase().replace(/\.$/, "");
  if (!ANDROID_PUSH_HOSTS.has(hostname) || !/^\/(?:fcm\/send|wp)\/[A-Za-z0-9:_-]+$/.test(endpoint.pathname)) {
    throw new Error("Only Android Chrome push endpoints are supported during the pilot.");
  }
  if (!validBase64Url(p256dh, 80, 120)) throw new Error("The push encryption key is invalid.");
  if (!validBase64Url(auth, 16, 64)) throw new Error("The push authentication secret is invalid.");
  try {
    const publicKey = decodeBase64Url(p256dh);
    const authSecret = decodeBase64Url(auth);
    if (publicKey.length !== 65 || publicKey[0] !== 0x04 || authSecret.length < 16 || authSecret.length > 32) {
      throw new Error("invalid key material");
    }
  } catch {
    throw new Error("The push encryption keys are malformed.");
  }
  endpoint.hash = "";
  return { endpoint: endpoint.toString(), p256dh, auth };
}
