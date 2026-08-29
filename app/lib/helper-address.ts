export type HelperAddress = {
  houseOrFlat: string;
  floor: string;
  buildingOrSociety: string;
  city: string;
  state: string;
  pinCode: string;
};


const limits: Record<keyof HelperAddress, number> = {
  houseOrFlat: 120,
  floor: 80,
  buildingOrSociety: 160,
  city: 100,
  state: 100,
  pinCode: 6,
};

export function canonicalAddressPart(value: unknown, limit: number) {
  if (typeof value !== "string") throw new TypeError("Address fields must be text");
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (normalized.length > limit) throw new RangeError("Address field is too long");
  return normalized;
}

export function parseHelperAddress(value: unknown): HelperAddress {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Provide a valid address");
  const record = value as Record<string, unknown>;
  const expected = Object.keys(limits);
  if (Object.keys(record).some(key => !expected.includes(key))) throw new TypeError("Unexpected address field");
  const address = Object.fromEntries(expected.map(key => [key, canonicalAddressPart(record[key], limits[key as keyof HelperAddress])])) as HelperAddress;
  if (!address.houseOrFlat) throw new RangeError("Enter your house or flat number");
  if (!address.city) throw new RangeError("Enter your city");
  if (!address.state) throw new RangeError("Enter your state");
  if (!/^\d{6}$/.test(address.pinCode)) throw new RangeError("Enter a valid 6-digit PIN code");
  return address;
}

export function formattedHelperAddress(address: HelperAddress) {
  return [address.houseOrFlat, address.floor, address.buildingOrSociety, address.city, address.state, address.pinCode]
    .filter(Boolean).join(", ");
}
