import { getD1, getSession } from "../../../lib/auth";

export async function GET(request: Request) {
  try {
    const session = await getSession(request);
    if (!session) return Response.json({ authenticated: false }, { status: 401 });
    let profileComplete = Boolean(session.name.trim());
    if (session.role === "provider" && profileComplete) {
      const db = await getD1();
      const profile = await db.prepare(
        "SELECT profile_status FROM helper_profiles WHERE user_id = ? LIMIT 1",
      ).bind(session.user_id).first<{ profile_status: string }>();
      profileComplete = profile?.profile_status === "active" || profile?.profile_status === "paused";
    }
    return Response.json({
      authenticated: true,
      user: {
        name: session.name,
        mobile: session.mobile_e164,
        role: session.role,
        roles: session.roles,
      },
      profileComplete,
    });
  } catch {
    return Response.json({ authenticated: false }, { status: 401 });
  }
}
