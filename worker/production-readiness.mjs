const PRIVATE_SECRET_KEYS = ["MSG91_AUTH_KEY"];
const PUBLIC_CONFIGURATION_KEYS = [
  "NEXT_PUBLIC_MSG91_WIDGET_ID",
  "NEXT_PUBLIC_MSG91_WIDGET_TOKEN",
  "GOOGLE_MAPS_BROWSER_KEY",
];
const READINESS_CHALLENGE = new TextEncoder().encode("nivasa-production-readiness-v1");
const readinessByEnvironment = new WeakMap();

function runtimeString(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value : "";
}

function isSafeOpaqueValue(value) {
  return value.length > 0 && value.length <= 2_048 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const decoded = atob(padded);
    return Uint8Array.from(decoded, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function validSessionSecret(value) {
  let decoded = null;
  if (/^[a-fA-F0-9]{64,512}$/.test(value) && value.length % 2 === 0) {
    decoded = Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));
  } else if (value.length <= 684) {
    decoded = decodeBase64Url(value);
  }
  return decoded !== null
    && decoded.length >= 32
    && decoded.length <= 512
    && new Set(decoded).size >= 16;
}

function parseVapidPublicKey(value) {
  const decoded = decodeBase64Url(value);
  return decoded !== null && decoded.length === 65 && decoded[0] === 0x04 ? decoded : null;
}

function parseVapidPrivateJwk(value) {
  if (value.length === 0 || value.length > 4_096) return null;
  try {
    const jwk = JSON.parse(value);
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) return null;
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") return null;
    const coordinates = [jwk.x, jwk.y, jwk.d].map(field =>
      typeof field === "string" ? decodeBase64Url(field) : null,
    );
    if (!coordinates.every(field => field?.length === 32)) return null;
    return { jwk, x: coordinates[0], y: coordinates[1] };
  } catch {
    return null;
  }
}

function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function validVapidKeypair(publicValue, privateValue) {
  const publicPoint = parseVapidPublicKey(publicValue);
  const privateKey = parseVapidPrivateJwk(privateValue);
  if (!publicPoint || !privateKey) return false;
  if (!equalBytes(publicPoint.slice(1, 33), privateKey.x)
      || !equalBytes(publicPoint.slice(33), privateKey.y)) return false;
  try {
    const [signingKey, verificationKey] = await Promise.all([
      crypto.subtle.importKey(
        "jwk",
        privateKey.jwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      ),
      crypto.subtle.importKey(
        "raw",
        publicPoint,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      ),
    ]);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      READINESS_CHALLENGE,
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verificationKey,
      signature,
      READINESS_CHALLENGE,
    );
  } catch {
    return false;
  }
}

function validVapidSubject(value) {
  try {
    const subject = new URL(value);
    if (subject.protocol === "mailto:") {
      return !subject.search && !subject.hash && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(subject.pathname);
    }
    return subject.protocol === "https:" && Boolean(subject.hostname) && !subject.username && !subject.password;
  } catch {
    return false;
  }
}

function validBindings(env) {
  return typeof env?.DB?.prepare === "function"
    && typeof env?.BUCKET?.put === "function"
    && typeof env?.BUCKET?.delete === "function"
    && typeof env?.ASSETS?.fetch === "function"
    && typeof env?.IMAGES?.input === "function";
}

export async function productionConfigurationReady(env) {
  if (!validSessionSecret(runtimeString(env, "NIVASA_SESSION_SECRET"))) return false;
  if (!PRIVATE_SECRET_KEYS.every(name => isSafeOpaqueValue(runtimeString(env, name)))) return false;
  if (!PUBLIC_CONFIGURATION_KEYS.every(name => isSafeOpaqueValue(runtimeString(env, name)))) return false;
  if (!await validVapidKeypair(
    runtimeString(env, "VAPID_PUBLIC_KEY"),
    runtimeString(env, "VAPID_PRIVATE_JWK"),
  )) return false;
  if (!validVapidSubject(runtimeString(env, "VAPID_SUBJECT"))) return false;
  return validBindings(env);
}

function cachedProductionConfigurationReady(env) {
  if (!env || (typeof env !== "object" && typeof env !== "function")) return Promise.resolve(false);
  let readiness = readinessByEnvironment.get(env);
  if (!readiness) {
    readiness = productionConfigurationReady(env).catch(() => false);
    readinessByEnvironment.set(env, readiness);
  }
  return readiness;
}

function readinessResponse(ready) {
  return Response.json({ ready }, {
    status: ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function productionReadinessResponse(request, env, productionSelected) {
  if (!productionSelected) return null;
  const ready = await cachedProductionConfigurationReady(env);
  if (new URL(request.url).pathname === "/__nivasa/readiness") return readinessResponse(ready);
  return ready ? null : readinessResponse(false);
}
