import { AppRole, assertSameOrigin, getD1, getSession, roleForStorage } from "../../../lib/auth";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in again to continue." }, { status: 401 });
    const body = await request.json() as {
      role?: unknown;
      name?: unknown;
      house?: unknown;
      locality?: unknown;
      formattedAddress?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      termsAccepted?: unknown;
    };
    if ((body.role !== "resident" && body.role !== "provider") || !session.roles.includes(body.role as AppRole)) {
      return Response.json({ error: "This account role is unavailable." }, { status: 403 });
    }
    const role = body.role as AppRole;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || body.termsAccepted !== true) {
      return Response.json({ error: "Complete the required details and accept the Terms and Privacy Policy." }, { status: 400 });
    }
    if (role === "resident") {
      const db = await getD1();
      const house = typeof body.house === "string" ? body.house.trim() : "";
      const locality = typeof body.locality === "string" ? body.locality.trim() : "";
      const formattedAddress = typeof body.formattedAddress === "string" ? body.formattedAddress.trim() : "";
      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);
      if (!house || !locality || !formattedAddress || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        return Response.json({ error: "Enter your house number and choose your address from Google suggestions." }, { status: 400 });
      }
      const addressId = crypto.randomUUID();
      await db.batch([
        db.prepare("UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(name, session.user_id),
        db.prepare("INSERT OR IGNORE INTO resident_profiles (user_id, onboarding_completed_at) VALUES (?, CURRENT_TIMESTAMP)").bind(session.user_id),
        db.prepare("UPDATE resident_profiles SET onboarding_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?").bind(session.user_id),
        db.prepare("UPDATE resident_addresses SET is_primary = 0, updated_at = CURRENT_TIMESTAMP WHERE resident_user_id = ?").bind(session.user_id),
        db.prepare("INSERT INTO resident_addresses (id, resident_user_id, house_or_flat, street_or_block, locality, latitude_e6, longitude_e6, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
          .bind(addressId, session.user_id, house, formattedAddress, locality, Math.round(latitude * 1_000_000), Math.round(longitude * 1_000_000)),
        db.prepare("INSERT INTO consents (id, user_id, document_type, document_version) VALUES (?, ?, 'terms_and_privacy', 'pilot-v1')").bind(crypto.randomUUID(), session.user_id),
      ]);
    } else {
      const db = await getD1();
      await db.batch([
        db.prepare("UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(name, session.user_id),
        db.prepare("INSERT INTO consents (id, user_id, document_type, document_version) VALUES (?, ?, 'terms_and_privacy', 'pilot-v1')").bind(crypto.randomUUID(), session.user_id),
      ]);
    }
    const db = await getD1();
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)")
        .bind(session.user_id, roleForStorage(role)),
      db.prepare(
        "INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'account_onboarding_completed', ?)",
      ).bind(crypto.randomUUID(), session.user_id, JSON.stringify({ role })),
    ]);
    return Response.json({ completed: true, user: { name, role } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not save your account. Please try again." }, { status: 500 });
  }
}
