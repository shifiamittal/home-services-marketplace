import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";

async function requireResident(request: Request) {
  const session = await getSession(request);
  if (!session) throw Response.json({ error: "Sign in again to continue." }, { status: 401 });
  if (!session.roles.includes("resident")) throw Response.json({ error: "A resident account is required." }, { status: 403 });
  return session;
}

export async function GET(request: Request) {
  try {
    const session = await requireResident(request);
    const db = await getD1();
    const address = await db.prepare(
      `SELECT house_or_flat, street_or_block, locality, latitude_e6, longitude_e6
       FROM resident_addresses WHERE resident_user_id = ? AND is_primary = 1 LIMIT 1`,
    ).bind(session.user_id).first<Record<string, string | number | null>>();
    return Response.json({
      address: address ? {
        house: address.house_or_flat,
        formattedAddress: address.street_or_block || address.locality,
        locality: address.locality,
        latitude: typeof address.latitude_e6 === "number" ? address.latitude_e6 / 1_000_000 : null,
        longitude: typeof address.longitude_e6 === "number" ? address.longitude_e6 / 1_000_000 : null,
      } : null,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not load your address." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireResident(request);
    const body = await request.json() as Record<string, unknown>;
    const house = typeof body.house === "string" ? body.house.trim() : "";
    const formattedAddress = typeof body.formattedAddress === "string" ? body.formattedAddress.trim() : "";
    const locality = typeof body.locality === "string" ? body.locality.trim() : "";
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (!house || !formattedAddress || !locality || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return Response.json({ error: "Enter your house number and choose your address from Google suggestions." }, { status: 400 });
    }
    const db = await getD1();
    const existing = await db.prepare(
      "SELECT id FROM resident_addresses WHERE resident_user_id = ? AND is_primary = 1 LIMIT 1",
    ).bind(session.user_id).first<{ id: string }>();
    if (existing) {
      await db.prepare(
        `UPDATE resident_addresses SET house_or_flat = ?, street_or_block = ?, locality = ?, latitude_e6 = ?, longitude_e6 = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND resident_user_id = ?`,
      ).bind(house, formattedAddress, locality, Math.round(latitude * 1_000_000), Math.round(longitude * 1_000_000), existing.id, session.user_id).run();
    } else {
      await db.prepare(
        `INSERT INTO resident_addresses (id, resident_user_id, house_or_flat, street_or_block, locality, latitude_e6, longitude_e6, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      ).bind(crypto.randomUUID(), session.user_id, house, formattedAddress, locality, Math.round(latitude * 1_000_000), Math.round(longitude * 1_000_000)).run();
    }
    return Response.json({ saved: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not save your address." }, { status: 500 });
  }
}
