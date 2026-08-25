import { AppRole, assertSameOrigin, createSession, getD1, roleForStorage, verifyMsg91AccessToken } from "../../../../lib/auth";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json() as { accessToken?: unknown; role?: unknown };
    if (typeof body.accessToken !== "string" || body.accessToken.length < 20) {
      return Response.json({ error: "The verification token is missing." }, { status: 400 });
    }
    if (body.role !== "resident" && body.role !== "provider") {
      return Response.json({ error: "Choose resident or home helper." }, { status: 400 });
    }

    const role = body.role as AppRole;
    const mobileE164 = await verifyMsg91AccessToken(body.accessToken);
    const db = await getD1();
    let user = await db.prepare("SELECT id, name, status FROM users WHERE mobile_e164 = ? LIMIT 1")
      .bind(mobileE164).first<{ id: string; name: string; status: string }>();
    if (user?.status === "blocked" || user?.status === "deleted") {
      return Response.json({ error: "This account is unavailable. Please contact Nivasa support." }, { status: 403 });
    }

    if (!user) {
      user = { id: crypto.randomUUID(), name: "", status: "active" };
      await db.prepare(
        "INSERT INTO users (id, mobile_e164, name, last_signed_in_at) VALUES (?, ?, '', CURRENT_TIMESTAMP)",
      ).bind(user.id, mobileE164).run();
    } else {
      const existingRole = await db.prepare(
        "SELECT role FROM user_roles WHERE user_id = ? ORDER BY created_at ASC, id ASC LIMIT 1",
      ).bind(user.id).first<{ role: "resident" | "helper" }>();
      const requestedStoredRole = roleForStorage(role);
      if (existingRole && existingRole.role !== requestedStoredRole) {
        const existingLabel = existingRole.role === "resident" ? "a resident" : "a home helper";
        const requestedLabel = role === "resident" ? "resident" : "home helper";
        return Response.json({
          error: `This mobile number is already registered as ${existingLabel}. Sign in using that account type or use a different number for the ${requestedLabel} account.`,
          code: "ROLE_MISMATCH",
        }, { status: 409 });
      }
      await db.prepare("UPDATE users SET last_signed_in_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(user.id).run();
    }

    await db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)")
      .bind(user.id, roleForStorage(role)).run();
    await db.prepare(
      "INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'mobile_sign_in_completed', ?)",
    ).bind(crypto.randomUUID(), user.id, JSON.stringify({ role })).run();
    const cookies = await createSession(user.id, role);
    let profileComplete = Boolean(user.name.trim());
    if (role === "provider" && profileComplete) {
      const profile = await db.prepare(
        "SELECT profile_status FROM helper_profiles WHERE user_id = ? LIMIT 1",
      ).bind(user.id).first<{ profile_status: string }>();
      profileComplete = profile?.profile_status === "active" || profile?.profile_status === "paused";
    }
    const response = Response.json({
      user: { name: user.name, mobile: mobileE164, role },
      profileComplete,
    });
    for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
    return response;
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json(
      { error: error instanceof Error ? error.message : "We could not complete sign-in." },
      { status: 502 },
    );
  }
}
