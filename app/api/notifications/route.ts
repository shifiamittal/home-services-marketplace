import { assertSameOrigin, getD1, getSession } from "../../lib/auth";

async function requireUser(request: Request) {
  const session = await getSession(request);
  if (!session) throw Response.json({ error: "Sign in again to continue." }, { status: 401 });
  return session;
}

export async function GET(request: Request) {
  try {
    const session = await requireUser(request);
    const db = await getD1();
    const rows = await db.prepare(
      `SELECT id, template_key, title, body, action_view, related_entity_type, related_entity_id,
              read_at, created_at
       FROM notification_log
       WHERE user_id = ? AND channel = 'in_app'
       ORDER BY created_at DESC LIMIT 30`,
    ).bind(session.user_id).all<Record<string, string | null>>();
    const unread = await db.prepare(
      "SELECT COUNT(*) AS count FROM notification_log WHERE user_id = ? AND channel = 'in_app' AND read_at IS NULL",
    ).bind(session.user_id).first<{ count: number }>();
    return Response.json({
      unreadCount: Number(unread?.count ?? 0),
      notifications: rows.results.map(row => ({
        id: row.id,
        templateKey: row.template_key,
        title: row.title || "Nivasa update",
        body: row.body || "There is an update to your booking.",
        actionView: row.action_view,
        relatedEntityType: row.related_entity_type,
        relatedEntityId: row.related_entity_id,
        readAt: row.read_at,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not load your notifications." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireUser(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const db = await getD1();
    if (body.all === true) {
      await db.prepare(
        "UPDATE notification_log SET read_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND channel = 'in_app' AND read_at IS NULL",
      ).bind(session.user_id).run();
    } else if (id) {
      await db.prepare(
        "UPDATE notification_log SET read_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND channel = 'in_app'",
      ).bind(id, session.user_id).run();
    } else {
      return Response.json({ error: "Choose a notification to mark as read." }, { status: 400 });
    }
    return Response.json({ updated: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not update your notifications." }, { status: 500 });
  }
}
