export type AppRole = "resident" | "provider";
type StoredRole = "resident" | "helper";

const SESSION_COOKIE = "__Host-nivasa_session";
const ROLE_COOKIE = "__Host-nivasa_role";
const SESSION_DAYS = 30;

async function runtimeValue(name: string) {
  const { env } = await import("cloudflare:workers");
  const workerEnv = env as unknown as Record<string, string | undefined>;
  return workerEnv[name] ?? process.env[name];
}

async function requiredRuntimeValue(name: string) {
  const value = await runtimeValue(name);
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function normalizeIndianMobile(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return value.trim();
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function tokenHash(token: string) {
  const secret = await requiredRuntimeValue("NIVASA_SESSION_SECRET");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(signature));
}

function storedRole(role: AppRole): StoredRole {
  return role === "provider" ? "helper" : "resident";
}

function appRole(role: StoredRole): AppRole {
  return role === "helper" ? "provider" : "resident";
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new Response("Invalid request origin.", { status: 403 });
  }
}

export function readCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export async function verifyMsg91AccessToken(accessToken: string) {
  const response = await fetch("https://api.msg91.com/api/v5/widget/verifyAccessToken", {
    method: "POST",
    headers: {
      accept: "application/json",
      authkey: await requiredRuntimeValue("MSG91_AUTH_KEY"),
      "content-type": "application/json",
    },
    body: JSON.stringify({ "access-token": accessToken }),
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new Error("MSG91 could not verify this sign-in.");
  }

  const record = payload as Record<string, unknown>;
  if (record.type && record.type !== "success") {
    throw new Error("MSG91 rejected this verification.");
  }

  const candidates: unknown[] = [
    record.identifier,
    record.mobile,
    record.phone,
    record.message,
    typeof record.data === "object" && record.data ? (record.data as Record<string, unknown>).identifier : null,
    typeof record.data === "object" && record.data ? (record.data as Record<string, unknown>).mobile : null,
  ];
  const identifier = candidates.find(value => typeof value === "string" && /^\+?91\d{10}$/.test(value));
  if (typeof identifier !== "string") {
    throw new Error("MSG91 did not return a verified Indian mobile number.");
  }
  return `+${identifier.replace(/^\+/, "")}`;
}

export async function createSession(userId: string, role: AppRole) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64Url(tokenBytes);
  const hash = await tokenHash(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  const db = await getD1();
  await db.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), userId, hash, expiresAt).run();

  const maxAge = SESSION_DAYS * 86_400;
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
    `${ROLE_COOKIE}=${role}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
  ];
}

export async function getSession(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const hash = await tokenHash(token);
  const db = await getD1();
  const session = await db.prepare(
    `SELECT sessions.id AS session_id, users.id AS user_id, users.mobile_e164, users.name, users.status
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > CURRENT_TIMESTAMP
     LIMIT 1`,
  ).bind(hash).first<{ session_id: string; user_id: string; mobile_e164: string; name: string; status: string }>();
  if (!session || session.status !== "active") return null;

  const rolesResult = await db.prepare("SELECT role FROM user_roles WHERE user_id = ? ORDER BY created_at ASC, id ASC LIMIT 1")
    .bind(session.user_id).all<{ role: StoredRole }>();
  const roles = rolesResult.results.map(row => appRole(row.role));
  const role = roles[0] ?? "resident";
  return { ...session, role, roles };
}

export async function revokeSession(request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return;
  const hash = await tokenHash(token);
  const db = await getD1();
  await db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?")
    .bind(hash).run();
}

export function clearSessionCookies() {
  return [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    `${ROLE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ];
}

export function roleForStorage(role: AppRole) {
  return storedRole(role);
}

export async function getD1() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("The pilot database is unavailable.");
  return env.DB;
}

export async function getMsg91PublicConfig() {
  return {
    widgetId: await requiredRuntimeValue("NEXT_PUBLIC_MSG91_WIDGET_ID"),
    tokenAuth: await requiredRuntimeValue("NEXT_PUBLIC_MSG91_WIDGET_TOKEN"),
  };
}

export async function getGoogleMapsPublicConfig() {
  return { apiKey: await requiredRuntimeValue("GOOGLE_MAPS_BROWSER_KEY") };
}
