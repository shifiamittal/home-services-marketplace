import { effectiveLocationTextSql } from "./address-integrity";

type AddressSave = {
  locality: string; homeAddress: string; latitude: number | null; longitude: number | null;
  omittedCoordinates: boolean; preserveAddress?: boolean;
};

// The same expressions determine both the saved coordinates and invalidation.
// All comparisons read the current row inside the atomic save, never a pre-read.
export function helperAddressExpressions(profile: string, incoming: string, omitted: string, preserve = "0") {
  const validPoint = `typeof(${profile}.latitude_e6) = 'integer' AND typeof(${profile}.longitude_e6) = 'integer'
    AND ${profile}.latitude_e6 BETWEEN -90000000 AND 90000000
    AND ${profile}.longitude_e6 BETWEEN -180000000 AND 180000000
    AND (${profile}.latitude_e6 != 0 OR ${profile}.longitude_e6 != 0)`;
  const sameText = `${effectiveLocationTextSql(profile + '.home_address', profile + '.home_locality')} = ${incoming}.home_address
    AND ${effectiveLocationTextSql(profile + '.home_locality', 'NULL')} = ${incoming}.home_locality`;
  const next = (column: string) => `CASE WHEN ${preserve} THEN ${profile}.${column}
    WHEN ${omitted} AND ${sameText} AND ${validPoint} THEN ${profile}.${column} ELSE ${incoming}.${column} END`;
  return { latitude: next("latitude_e6"), longitude: next("longitude_e6"), validPoint };
}

export function saveAddressVerification(db: D1Database, helperId: string, value: AddressSave, auditProperties: string) {
  const next = helperAddressExpressions("hp", "incoming", "incoming.omitted", "incoming.preserve");
  const changed = `NOT incoming.preserve AND NOT (${effectiveLocationTextSql('hp.home_address', 'hp.home_locality')} = incoming.home_address
    AND ${effectiveLocationTextSql('hp.home_locality', 'NULL')} = incoming.home_locality
    AND (CASE WHEN ${next.validPoint} THEN hp.latitude_e6 END) IS (${next.latitude})
    AND (CASE WHEN ${next.validPoint} THEN hp.longitude_e6 END) IS (${next.longitude}))`;
  const context = `WITH incoming AS (
    SELECT ? AS user_id, ? AS home_address, ? AS home_locality, ? AS latitude_e6, ? AS longitude_e6, ? AS omitted, ? AS preserve
  ), current AS (
    SELECT hp.verification_status, (${changed}) AND (hp.verification_status = 'verified' OR EXISTS (
      SELECT 1 FROM verification_documents WHERE helper_user_id = hp.user_id AND status = 'verified'
    )) AS invalidate
    FROM incoming LEFT JOIN helper_profiles hp ON hp.user_id = incoming.user_id
  )`;
  const bindings = [helperId, value.homeAddress, value.locality, value.latitude, value.longitude,
    Number(value.omittedCoordinates), Number(value.preserveAddress)];
  return [
    // Extend the existing save audit with the historical verification fact;
    // never copy addresses, coordinates, proof identifiers or review notes.
    db.prepare(`${context} INSERT INTO analytics_events (id, user_id, event_name, properties_json)
      SELECT ?, ?, 'helper_profile_saved', json_patch(?, json_object(
        'previousVerificationStatus', verification_status,
        'addressVerificationInvalidated', json(CASE WHEN invalidate THEN 'true' ELSE 'false' END)
      )) FROM current`).bind(...bindings, crypto.randomUUID(), helperId, auditProperties),
    // Review attribution and bytes remain untouched. A pending proof is not a
    // current verification, even when its historical review fields are present.
    db.prepare(`${context} UPDATE verification_documents SET status = 'pending'
      WHERE helper_user_id = ? AND status = 'verified' AND (SELECT invalidate FROM current)`).bind(...bindings, helperId),
    db.prepare(`${context} UPDATE helper_profiles SET verification_status = 'pending'
      WHERE user_id = ? AND verification_status = 'verified' AND (SELECT invalidate FROM current)`).bind(...bindings, helperId),
  ];
}
