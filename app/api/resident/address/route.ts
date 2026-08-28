import { addressRevision, coordinates, effectiveLocationText, storedCoordinates } from "../../../lib/address-integrity";
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
    const point = address ? storedCoordinates(address.latitude_e6, address.longitude_e6) : null;
    return Response.json({
      address: address ? {
        house: address.house_or_flat,
        formattedAddress: effectiveLocationText(address.street_or_block, address.locality),
        locality: address.locality,
        latitude: point?.latitude == null ? null : point.latitude / 1_000_000,
        longitude: point?.longitude == null ? null : point.longitude / 1_000_000,
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
    let point;
    try { point = coordinates(body.latitude, body.longitude); }
    catch { return Response.json({ error: "Choose a valid address location." }, { status: 400 }); }
    if (!house || !formattedAddress || !locality) {
      return Response.json({ error: "Enter your house number and choose your address from Google suggestions." }, { status: 400 });
    }
    const db = await getD1();
    await db.batch(addressRevision(db, session.user_id, {
      house, formattedAddress, locality, ...point,
      omittedCoordinates: body.latitude === undefined && body.longitude === undefined,
    }));
    return Response.json({ saved: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not save your address." }, { status: 500 });
  }
}
