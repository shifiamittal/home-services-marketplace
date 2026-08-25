import { assertSameOrigin, getD1, getSession } from "../../lib/auth";

const EVENT_NAMES = new Set([
  "screen_viewed",
  "account_role_selected",
  "otp_window_requested",
  "helper_profile_viewed",
  "request_review_viewed",
]);

const SCREEN_NAMES = new Set([
  "welcome", "mobile", "residentAccount", "helperAccount", "requirement",
  "matches", "profile", "review", "pending", "confirmed", "dashboard",
  "membership", "issue", "settings", "providerSettings", "address",
  "privacy", "signedOut", "setup", "incoming", "providerDashboard",
  "providerIssue", "terms", "privacyPolicy",
]);

function safeProperties(eventName: string, value: unknown) {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const properties: Record<string, string> = {};
  if (typeof record.role === "string" && ["resident", "provider"].includes(record.role)) {
    properties.role = record.role;
  }
  if (eventName === "screen_viewed" && typeof record.screen === "string" && SCREEN_NAMES.has(record.screen)) {
    properties.screen = record.screen;
  }
  return properties;
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json() as { eventName?: unknown; properties?: unknown; sessionId?: unknown };
    if (typeof body.eventName !== "string" || !EVENT_NAMES.has(body.eventName)) {
      return Response.json({ error: "Unsupported analytics event." }, { status: 400 });
    }
    const sessionId = typeof body.sessionId === "string" && /^[a-f0-9-]{20,64}$/i.test(body.sessionId)
      ? body.sessionId
      : null;
    const session = await getSession(request).catch(() => null);
    const db = await getD1();
    await db.prepare(
      "INSERT INTO analytics_events (id, user_id, session_id, event_name, properties_json) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      session?.user_id ?? null,
      sessionId,
      body.eventName,
      JSON.stringify(safeProperties(body.eventName, body.properties)),
    ).run();
    return Response.json({ recorded: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "Analytics event was not recorded." }, { status: 500 });
  }
}
