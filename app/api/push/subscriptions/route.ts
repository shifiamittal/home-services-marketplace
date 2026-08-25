import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in again to continue." }, { status: 401 });
    const body = await request.json() as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
    const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
    if (!endpoint.startsWith("https://") || !p256dh || !auth) return Response.json({ error: "This device subscription is invalid." }, { status: 400 });
    const db = await getD1();
    await db.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
       auth = excluded.auth, user_agent = excluded.user_agent, status = 'active', updated_at = CURRENT_TIMESTAMP`,
    ).bind(crypto.randomUUID(), session.user_id, endpoint, p256dh, auth, request.headers.get("user-agent")?.slice(0, 500) ?? null).run();
    return Response.json({ subscribed: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not turn on device alerts." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in again to continue." }, { status: 401 });
    const body = await request.json().catch(() => ({})) as { endpoint?: unknown };
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const db = await getD1();
    await db.prepare("UPDATE push_subscriptions SET status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND endpoint = ?")
      .bind(session.user_id, endpoint).run();
    return Response.json({ unsubscribed: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not update device alerts." }, { status: 500 });
  }
}
