export const HOUSE_SERVICE_DETAILS = {
  one_two_bhk: { label: "1–2 BHK", durationMinutes: 30 },
  three_bhk: { label: "3 BHK", durationMinutes: 45 },
  four_plus_bhk: { label: "4+ BHK", durationMinutes: 60 },
} as const;

export type HouseSize = keyof typeof HOUSE_SERVICE_DETAILS;
export type OfferingService = "house_cleaning" | "utensils_once" | "utensils_twice";
export type OfferingRow = {
  serviceType: OfferingService;
  homeSize: HouseSize | "not_applicable";
  monthlyPricePaise: number;
};
export type OfferingState = "none" | "conforming" | "legacy_inconsistent";

const MIN_MONTHLY_PRICE_PAISE = 1;
const MAX_MONTHLY_PRICE_PAISE = Number.MAX_SAFE_INTEGER;

function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function price(value: unknown, twice = false) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_MONTHLY_PRICE_PAISE
    || value > (twice ? MAX_MONTHLY_PRICE_PAISE / 2 : MAX_MONTHLY_PRICE_PAISE)) {
    throw new Error("Enter a valid monthly price for every selected service.");
  }
  return value;
}

export function parseServices(value: unknown): OfferingRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose valid services and prices.");
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["houseCleaning", "utensils"])) throw new Error("Choose valid services and prices.");
  if (!Array.isArray(input.houseCleaning)) throw new Error("Choose valid house-cleaning options.");
  const rows: OfferingRow[] = [];
  const sizes = new Set<HouseSize>();
  for (const item of input.houseCleaning) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Choose valid house-cleaning options.");
    const option = item as Record<string, unknown>;
    if (!exactKeys(option, ["homeSize", "monthlyPricePaise"])) throw new Error("Choose valid house-cleaning options.");
    const homeSize = option.homeSize as HouseSize;
    if (!Object.hasOwn(HOUSE_SERVICE_DETAILS, homeSize) || sizes.has(homeSize)) throw new Error("Choose each house size only once.");
    sizes.add(homeSize);
    rows.push({ serviceType: "house_cleaning", homeSize, monthlyPricePaise: price(option.monthlyPricePaise) });
  }

  if (input.utensils !== null) {
    if (!input.utensils || typeof input.utensils !== "object" || Array.isArray(input.utensils)) throw new Error("Choose a valid utensil-cleaning frequency.");
    const utensils = input.utensils as Record<string, unknown>;
    if (!exactKeys(utensils, ["frequency", "onceDailyMonthlyPricePaise"])) throw new Error("Twice-daily pricing is calculated from the once-daily price.");
    if (utensils.frequency !== "once" && utensils.frequency !== "twice") throw new Error("Choose once daily or twice daily for utensils.");
    if (Object.hasOwn(utensils, "twiceDailyMonthlyPricePaise")) throw new Error("Twice-daily pricing is calculated from the once-daily price.");
    const once = price(utensils.onceDailyMonthlyPricePaise, utensils.frequency === "twice");
    rows.push({ serviceType: "utensils_once", homeSize: "not_applicable", monthlyPricePaise: once });
    if (utensils.frequency === "twice") {
      const twice = once * 2;
      if (!Number.isSafeInteger(twice) || twice > MAX_MONTHLY_PRICE_PAISE) throw new Error("The twice-daily price is too large.");
      rows.push({ serviceType: "utensils_twice", homeSize: "not_applicable", monthlyPricePaise: twice });
    }
  }
  if (!rows.length) throw new Error("Select at least one service.");
  return rows;
}

export function parseLegacyOfferings(value: unknown): OfferingRow[] {
  if (!Array.isArray(value)) throw new Error("Choose valid service prices.");
  const houses: Array<{ homeSize: HouseSize; monthlyPricePaise: number }> = [];
  let once: number | null = null;
  let twice: number | null = null;
  const keys = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Choose valid service prices.");
    const row = item as Record<string, unknown>;
    const service = row.serviceType;
    const size = row.homeSize;
    const rupees = row.monthlyPriceRupees;
    if (typeof rupees !== "number" || !Number.isSafeInteger(rupees)) throw new Error("Enter prices in whole rupees in this version of the form.");
    const paise = rupees * 100;
    if (!Number.isSafeInteger(paise)) throw new Error("Enter a valid monthly price for every selected service.");
    const key = `${service}:${size}`;
    if (keys.has(key)) throw new Error("A service price was entered more than once.");
    keys.add(key);
    if (service === "house_cleaning" && Object.hasOwn(HOUSE_SERVICE_DETAILS, String(size))) houses.push({ homeSize: size as HouseSize, monthlyPricePaise: paise });
    else if (service === "utensils_once" && size === "not_applicable") once = paise;
    else if (service === "utensils_twice" && size === "not_applicable") twice = paise;
    else throw new Error("Choose valid service prices.");
  }
  if (twice !== null && (once === null || twice !== once * 2)) throw new Error("Twice-daily utensils must include once-daily capability at exactly double its price.");
  return parseServices({
    houseCleaning: houses,
    utensils: once === null ? null : { frequency: twice === null ? "once" : "twice", onceDailyMonthlyPricePaise: once },
  });
}

export function offeringState(rows: Array<{ service_type: unknown; home_size: unknown; monthly_price_paise: unknown; is_active?: unknown }>): OfferingState {
  const active = rows.filter(row => row.is_active === undefined || Boolean(row.is_active));
  if (!active.length) return "none";
  const keys = new Set<string>();
  for (const row of active) {
    if (typeof row.monthly_price_paise !== "number" || !Number.isSafeInteger(row.monthly_price_paise)
      || row.monthly_price_paise < MIN_MONTHLY_PRICE_PAISE || row.monthly_price_paise > MAX_MONTHLY_PRICE_PAISE) return "legacy_inconsistent";
    const service = row.service_type;
    const size = row.home_size;
    const valid = service === "house_cleaning" ? Object.hasOwn(HOUSE_SERVICE_DETAILS, String(size))
      : (service === "utensils_once" || service === "utensils_twice") && size === "not_applicable";
    const key = `${service}:${size}`;
    if (!valid || keys.has(key)) return "legacy_inconsistent";
    keys.add(key);
  }
  const once = active.find(row => row.service_type === "utensils_once");
  const twice = active.find(row => row.service_type === "utensils_twice");
  if (twice && (!once || Number(twice.monthly_price_paise) !== Number(once.monthly_price_paise) * 2)) return "legacy_inconsistent";
  return "conforming";
}

export function servicesResponse(rows: Array<{ service_type: unknown; home_size: unknown; monthly_price_paise: unknown; is_active?: unknown }>) {
  const state = offeringState(rows);
  const active = rows.filter(row => row.is_active === undefined || Boolean(row.is_active));
  const houses = active.filter(row => row.service_type === "house_cleaning" && Object.hasOwn(HOUSE_SERVICE_DETAILS, String(row.home_size)))
    .map(row => ({ homeSize: row.home_size, monthlyPricePaise: row.monthly_price_paise }));
  const once = active.find(row => row.service_type === "utensils_once");
  const twice = active.find(row => row.service_type === "utensils_twice");
  return {
    offeringState: state,
    services: state === "conforming" ? {
      houseCleaning: houses,
      utensils: once ? {
        frequency: twice ? "twice" : "once",
        onceDailyMonthlyPricePaise: once.monthly_price_paise,
        ...(twice ? { twiceDailyMonthlyPricePaise: twice.monthly_price_paise } : {}),
      } : null,
    } : null,
  };
}
