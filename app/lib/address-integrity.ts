/** Only outer whitespace is equivalent; never fold case, punctuation or unit text. */
export function effectiveLocationText(street: unknown, locality: unknown): string {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  return text(street) || text(locality);
}

// SQLite counterpart of effectiveLocationText for checks INSIDE atomic writes.
// Match ECMAScript trim (SQLite's default trim only removes ASCII spaces).
export function effectiveLocationTextSql(street: string, locality: string): string {
  const whitespace = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";
  const text = (column: string) => `CASE WHEN typeof(${column}) = 'text' THEN trim(${column}, ${whitespace}) ELSE '' END`;
  return `coalesce(nullif(${text(street)}, ''), ${text(locality)})`;
}

/** Legacy address integrity only; no Release 2 matching or PIN fallback. */
export function coordinates(latitude: unknown, longitude: unknown) {
  const absent = (value: unknown) => value == null || typeof value === "string" && !value.trim();
  if (absent(latitude) && absent(longitude)) return { latitude: null, longitude: null };
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180
    || latitude === 0 && longitude === 0) throw new RangeError("Invalid coordinate pair");
  // Sub-microdegree positions must not round into the unavailable sentinel.
  const lat = Math.round(latitude * 1_000_000), lon = Math.round(longitude * 1_000_000);
  if (lat === 0 && lon === 0) throw new RangeError("Invalid coordinate pair");
  return { latitude: lat, longitude: lon };
}

export function storedCoordinates(latitude: unknown, longitude: unknown) {
  if (typeof latitude !== "number" || !Number.isInteger(latitude)
    || typeof longitude !== "number" || !Number.isInteger(longitude)) return null;
  try {
    const point = coordinates(latitude / 1_000_000, longitude / 1_000_000);
    return point.latitude === null ? null : point;
  }
  catch { return null; }
}

type AddressRevision = {
  house: string; formattedAddress: string; locality: string;
  latitude: number | null; longitude: number | null; omittedCoordinates: boolean;
};

/** Always append a revision. Only current-address flags change on old rows.
 * Read the current coordinates INSIDE the batch so a stale pre-read cannot
 * restore an earlier revision during concurrent profile edits.
 */
export function addressRevision(db: D1Database, residentId: string, value: AddressRevision) {
  const id = crypto.randomUUID();
  return [
    db.prepare(`INSERT INTO resident_addresses
      (id, resident_user_id, house_or_flat, street_or_block, locality, latitude_e6, longitude_e6, is_primary)
      SELECT ?, ?, ?, ?, ?,
        CASE WHEN ? AND ${effectiveLocationTextSql('ra.street_or_block', 'ra.locality')} = ?
          AND ${effectiveLocationTextSql('ra.locality', 'NULL')} = ?
          AND typeof(ra.latitude_e6) = 'integer' AND typeof(ra.longitude_e6) = 'integer'
          AND ra.latitude_e6 BETWEEN -90000000 AND 90000000 AND ra.longitude_e6 BETWEEN -180000000 AND 180000000
          AND (ra.latitude_e6 != 0 OR ra.longitude_e6 != 0) THEN ra.latitude_e6 ELSE ? END,
        CASE WHEN ? AND ${effectiveLocationTextSql('ra.street_or_block', 'ra.locality')} = ?
          AND ${effectiveLocationTextSql('ra.locality', 'NULL')} = ?
          AND typeof(ra.latitude_e6) = 'integer' AND typeof(ra.longitude_e6) = 'integer'
          AND ra.latitude_e6 BETWEEN -90000000 AND 90000000 AND ra.longitude_e6 BETWEEN -180000000 AND 180000000
          AND (ra.latitude_e6 != 0 OR ra.longitude_e6 != 0) THEN ra.longitude_e6 ELSE ? END, 1
      FROM (SELECT 1) LEFT JOIN resident_addresses ra ON ra.id = (
        SELECT id FROM resident_addresses WHERE resident_user_id = ? AND is_primary = 1
        ORDER BY updated_at DESC, id LIMIT 1)`)
      .bind(id, residentId, value.house, value.formattedAddress, value.locality,
        Number(value.omittedCoordinates), effectiveLocationText(value.formattedAddress, value.locality), effectiveLocationText(value.locality, null), value.latitude,
        Number(value.omittedCoordinates), effectiveLocationText(value.formattedAddress, value.locality), effectiveLocationText(value.locality, null), value.longitude, residentId),
    db.prepare("UPDATE resident_addresses SET is_primary = 0 WHERE resident_user_id = ? AND id != ? AND is_primary = 1")
      .bind(residentId, id),
  ];
}
