import { effectiveLocationText, effectiveLocationTextSql } from "./address-integrity";
import { parseHelperAddress, type HelperAddress } from "./helper-address";

export type HelperAddressState = "none" | "legacy" | "structured";

type StoredHelperAddress = Record<string, unknown>;

export function storedStructuredHelperAddress(value: StoredHelperAddress): HelperAddress | null {
  try {
    return parseHelperAddress({
      houseOrFlat: value.house_or_flat,
      floor: typeof value.floor === "string" ? value.floor : "",
      buildingOrSociety: typeof value.building_or_society === "string" ? value.building_or_society : "",
      city: value.city,
      state: value.state,
      pinCode: value.pin_code,
    });
  } catch {
    return null;
  }
}

export function helperAddressState(value: StoredHelperAddress): HelperAddressState {
  if (storedStructuredHelperAddress(value)) return "structured";
  return effectiveLocationText(value.home_address, value.home_locality) ? "legacy" : "none";
}

const meaningfulTextSql = (column: string) => `${effectiveLocationTextSql(column, "NULL")} != ''`;

export function completeStructuredHelperAddressSql(profile: string) {
  const pinCode = effectiveLocationTextSql(`${profile}.pin_code`, "NULL");
  return `${meaningfulTextSql(`${profile}.house_or_flat`)}
    AND ${meaningfulTextSql(`${profile}.city`)}
    AND ${meaningfulTextSql(`${profile}.state`)}
    AND length(${pinCode}) = 6
    AND ${pinCode} NOT GLOB '*[^0-9]*'`;
}

export function meaningfulLegacyHelperAddressSql(profile: string) {
  return `NOT (${completeStructuredHelperAddressSql(profile)})
    AND ${effectiveLocationTextSql(`${profile}.home_address`, `${profile}.home_locality`)} != ''`;
}
