import { effectiveLocationText, storedCoordinates } from "./address-integrity";

export function validDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.trim().length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function residentComplete(row: Record<string, unknown> | null): boolean {
  return Boolean(row && validDisplayName(row.name) && row.profile_user_id
    && typeof row.house_or_flat === "string" && row.house_or_flat.trim()
    && typeof row.locality === "string" && row.locality.trim()
    && effectiveLocationText(row.street_or_block, row.locality)
    && storedCoordinates(row.latitude_e6, row.longitude_e6));
}

export async function residentProfileComplete(db: D1Database, userId: string) {
  const row = await db.prepare(
    `SELECT u.name, rp.user_id AS profile_user_id, ra.house_or_flat, ra.street_or_block, ra.locality,
            ra.latitude_e6, ra.longitude_e6
     FROM users u LEFT JOIN resident_profiles rp ON rp.user_id = u.id
     LEFT JOIN resident_addresses ra ON ra.resident_user_id = u.id AND ra.is_primary = 1
     WHERE u.id = ? ORDER BY ra.updated_at DESC, ra.id LIMIT 1`,
  ).bind(userId).first<Record<string, unknown>>();
  return residentComplete(row);
}

export async function requireCompleteResident(db: D1Database, userId: string) {
  if (!await residentProfileComplete(db, userId)) {
    throw Response.json({
      error: "Complete your resident profile and home address before searching or requesting help.",
      code: "PROFILE_INCOMPLETE",
    }, { status: 409 });
  }
}
