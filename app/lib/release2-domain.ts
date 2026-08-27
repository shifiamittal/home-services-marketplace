/** Pure Release 2 contracts. No I/O, clocks, persistence or production imports.
 * Weekdays are ISO-style: Monday=1, Sunday=7. Minutes are local wall-clock
 * minutes; 1440 is an END only. All intervals are half-open [start, end).
 * Callers supply active commitments and explicit geographic eligibility limits.
 */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Interval = Readonly<{ start: number; end: number }>;
export type WeeklySpan = Interval & Readonly<{ days: readonly Weekday[] }>;
export type Schedule = Readonly<{
  days: readonly Weekday[];
  hours: Interval;
  outside: readonly WeeklySpan[];
  commitments: readonly WeeklySpan[];
}>;
export type HomeSize = "one_two_bhk" | "three_bhk" | "four_plus_bhk";
export type ServicePackage = Readonly<{
  houseSize: HomeSize | null;
  utensils: 0 | 1 | 2;
  /** For combined twice-daily service, which visit includes house cleaning. */
  cleaningVisit?: 1 | 2;
}>;
export type Capabilities = Readonly<{
  housePricesPaise: Readonly<Partial<Record<HomeSize, number>>>;
  utensilsOncePaise: number | null;
  maxUtensilsVisits: 0 | 1 | 2;
}>;
export type Location = Readonly<{
  pin: string;
  coordinates: Readonly<{ latitude: number; longitude: number; confirmed: boolean }> | null;
}>;
export type Geography =
  | Readonly<{ kind: "confirmed"; distanceMeters: number }>
  | Readonly<{ kind: "same_pin"; distanceMeters: null; label: "Distance unavailable" }>;
export type Request = Readonly<{
  days: readonly Weekday[];
  service: ServicePackage;
  preferredStarts: readonly number[];
  location: Location;
}>;
export type Helper = Readonly<{
  id: string;
  schedule: Schedule;
  capabilities: Capabilities;
  location: Location;
  /** Supplied by the caller: this module does not invent a travel radius. */
  maxDistanceMeters: number;
}>;
export type Price = Readonly<{
  sevenDayMonthlyPaise: number;
  monthlyPaise: number;
  trialDayPaise: number;
  twoDayTrialPaise: number;
}>;
export type TimeOption = Readonly<{
  starts: readonly number[];
  durations: readonly number[];
  /** Original requested visit indices, retained for explicit partial selection. */
  requestedVisits: readonly number[];
  tier: 0 | 1 | 2 | 3;
  worstDeviation: number;
  combinedDeviation: number;
  stableId: string;
}>;
export type Offer = Readonly<{
  available: ServicePackage;
  unavailable: Readonly<{ houseSize: HomeSize | null; utensilsVisits: number }>;
  price: Price;
  options: readonly TimeOption[];
  badge: "Partial service available" | null;
  action: Readonly<{
    label: "Book requested service" | "Book available service" | "Book once-daily service";
    requiresSubsetConfirmation: boolean;
    service: ServicePackage;
  }>;
}>;
export type HelperMatch = Readonly<{
  helperId: string;
  kind: "full" | "partial";
  geography: Geography;
  /** One helper result; explicit subset alternatives are nested, never booked. */
  offers: readonly Offer[];
}>;

const HOUSE_MINUTES: Record<HomeSize, number> = {
  one_two_bhk: 30, three_bhk: 45, four_plus_bhk: 60,
};
const GAP = 15;

/** Snapshot inert data descriptors, never caller property values via getters.
 * Public records accept ordinary and null prototypes, not class instances.
 * Callers must supply data, not live Proxies (reflection can trigger traps).
 */
function inertRecord<T>(value: T, allowed: readonly string[]): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected a plain record");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Expected a plain record");
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new TypeError("Unexpected record key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Expected enumerable data properties");
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return result as T;
}

/** Dense arrays are also copied through data descriptors before iteration. */
function inertArray<T>(value: readonly T[]): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("Expected a plain array");
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  const result: T[] = [];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) throw new TypeError("Expected a dense array");
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) throw new TypeError("Unexpected array key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Expected enumerable array data");
    result[Number(key)] = descriptor.value;
  }
  return result;
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new RangeError("Integer outside permitted range");
}
function isHomeSize(value: unknown): value is HomeSize {
  return typeof value === "string" && (value === "one_two_bhk" || value === "three_bhk" || value === "four_plus_bhk");
}
function minute(value: unknown, end = false): asserts value is number {
  integer(value, 0, end ? 1440 : 1425);
  if (value % 15 !== 0) throw new RangeError("Time must align to 15 minutes");
}
function duration(value: unknown): asserts value is number {
  integer(value, 15, 1440);
  if (value % 15 !== 0) throw new RangeError("Duration must align to 15 minutes");
}
function compareId(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }

/** Returns a sorted, deduplicated, nonempty weekday set; never mutates input. */
export function normalizeDays(days: readonly Weekday[]): Weekday[] {
  days = inertArray(days);
  if (days.length === 0) throw new TypeError("Select at least one weekday");
  for (const day of days) integer(day, 1, 7);
  return [...new Set(days)].sort((a, b) => a - b);
}

export function validateInterval(value: Interval): Interval {
  value = inertRecord(value, ["start", "end"]);
  minute(value.start);
  minute(value.end, true);
  if (value.start >= value.end) throw new RangeError("Intervals must start before their same-day end");
  return { start: value.start, end: value.end };
}

/** Union of overlapping, nested or adjacent spans, in deterministic order. */
export function normalizeIntervals(spans: readonly Interval[]): Interval[] {
  spans = inertArray(spans);
  const sorted = spans.map(validateInterval).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function validateSchedule(schedule: Schedule) {
  schedule = inertRecord(schedule, ["days", "hours", "outside", "commitments"]);
  const days = normalizeDays(schedule.days);
  const hours = validateInterval(schedule.hours);
  const spans = [...inertArray(schedule.outside), ...inertArray(schedule.commitments)].map((span: WeeklySpan) => {
    span = inertRecord(span, ["start", "end", "days"]);
    return { ...validateInterval({ start: span.start, end: span.end }), days: normalizeDays(span.days) };
  });
  // Existing commitments may fall on days no longer offered for NEW work.
  // Profile-edit authorization belongs to the future transactional adapter.
  return { days, hours, spans };
}

function freeOnDay(schedule: ReturnType<typeof validateSchedule>, day: Weekday): Interval[] {
  if (!schedule.days.includes(day)) return [];
  const { start, end } = schedule.hours;
  // Same-day services can still have a neighbor across midnight/week wrap.
  // Shift adjacent days before clipping their travel gaps to today's hours.
  const blocked = normalizeIntervals([-1, 0, 1].flatMap(offset => {
    const neighbor = ((day - 1 + offset + 7) % 7 + 1) as Weekday;
    return schedule.spans.filter(span => span.days.includes(neighbor)).map(span => ({
      start: Math.max(start, span.start + offset * 1440 - GAP),
      end: Math.min(end, span.end + offset * 1440 + GAP),
    }));
  }).filter(span => span.start < span.end));
  const free: Interval[] = [];
  let cursor = start;
  for (const span of blocked) {
    if (cursor < span.start) free.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < end) free.push({ start: cursor, end });
  return free;
}

/** Weekly preview intervals, not an appointment count. Buffers are clipped
 * to working hours; the working boundary itself is not a commitment. */
export function weeklyAvailability(schedule: Schedule): { day: Weekday; free: Interval[] }[] {
  const valid = validateSchedule(schedule);
  return Array.from({ length: 7 }, (_, i) => ({ day: (i + 1) as Weekday, free: freeOnDay(valid, (i + 1) as Weekday) }));
}

export function commonStarts(schedule: Schedule, selectedDays: readonly Weekday[], serviceMinutes: number): number[] {
  const days = normalizeDays(selectedDays);
  duration(serviceMinutes);
  const valid = validateSchedule(schedule);
  if (serviceMinutes + GAP > 1440 && days.some(day => days.includes((day % 7 + 1) as Weekday))) return [];
  const windows = days.map(day => freeOnDay(valid, day));
  const result: number[] = [];
  for (let start = valid.hours.start; start + serviceMinutes <= valid.hours.end; start += 15) {
    if (windows.every(day => day.some(span => span.start <= start && start + serviceMinutes <= span.end))) result.push(start);
  }
  return result;
}

function validatePackage(service: ServicePackage): ServicePackage {
  service = inertRecord(service, ["houseSize", "utensils", "cleaningVisit"]);
  const { houseSize, utensils, cleaningVisit } = service;
  if (houseSize !== null && !isHomeSize(houseSize)) throw new TypeError("Unsupported home size");
  integer(utensils, 0, 2);
  if (houseSize === null && utensils === 0) throw new RangeError("Empty service package");
  if (cleaningVisit !== undefined && (houseSize === null || typeof cleaningVisit !== "number" || ![1, 2].includes(cleaningVisit)
    || (cleaningVisit === 2 && utensils !== 2))) throw new RangeError("Inconsistent cleaning visit");
  return { houseSize, utensils,
    ...(houseSize === null ? {} : { cleaningVisit: cleaningVisit ?? 1 }) };
}

/** One duration per daily visit; travel is deliberately not included. */
export function serviceDurations(service: ServicePackage): number[] {
  const valid = validatePackage(service);
  const result = valid.utensils === 2 ? [30, 30] : [valid.utensils === 1 ? 30 : 0];
  if (valid.houseSize !== null) result[(valid.cleaningVisit ?? 1) - 1] += HOUSE_MINUTES[valid.houseSize];
  return result;
}

function validateCapabilities(capabilities: Capabilities) {
  capabilities = inertRecord(capabilities, ["housePricesPaise", "utensilsOncePaise", "maxUtensilsVisits"]);
  const housePricesPaise = inertRecord(capabilities.housePricesPaise, ["one_two_bhk", "three_bhk", "four_plus_bhk"]);
  integer(capabilities.maxUtensilsVisits, 0, 2);
  for (const [size, amount] of Object.entries(housePricesPaise)) {
    if (!isHomeSize(size)) throw new TypeError("Unsupported offering size");
    integer(amount, 0, Number.MAX_SAFE_INTEGER);
  }
  if (capabilities.maxUtensilsVisits === 0) {
    if (capabilities.utensilsOncePaise !== null) throw new RangeError("Price without utensil capability");
  } else integer(capabilities.utensilsOncePaise, 0, Number.MAX_SAFE_INTEGER);
  return { ...capabilities, housePricesPaise };
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Price exceeds safe integer range");
  return Number(value);
}

/** Exact rational paise -> whole rupees, half upward. BigInt intermediates
 * avoid lost precision even when multiplication exceeds Number's safe range. */
function roundedPaise(numerator: bigint, denominator: bigint): number {
  const unit = denominator * BigInt(100);
  return safeNumber(((numerator * BigInt(2) + unit) / (unit * BigInt(2))) * BigInt(100));
}

export function packagePrice(capabilities: Capabilities, service: ServicePackage, selectedDays: readonly Weekday[]): Price {
  capabilities = validateCapabilities(capabilities);
  const valid = validatePackage(service);
  const count = normalizeDays(selectedDays).length;
  const house = valid.houseSize === null ? 0 : Object.hasOwn(capabilities.housePricesPaise, valid.houseSize)
    ? capabilities.housePricesPaise[valid.houseSize] : undefined;
  if (house === undefined || valid.utensils > capabilities.maxUtensilsVisits) throw new RangeError("Unsupported requested service");
  const utensils = capabilities.utensilsOncePaise ?? 0;
  // Revalidate the exact local primitives used below, not another map read.
  integer(house, 0, Number.MAX_SAFE_INTEGER);
  integer(utensils, 0, Number.MAX_SAFE_INTEGER);
  const baseline = BigInt(house) + BigInt(utensils) * BigInt(valid.utensils);
  const trialDayPaise = roundedPaise(baseline, BigInt(30));
  return {
    sevenDayMonthlyPaise: safeNumber(baseline),
    monthlyPaise: roundedPaise(baseline * BigInt(count), BigInt(7)),
    trialDayPaise,
    twoDayTrialPaise: safeNumber(BigInt(trialDayPaise) * BigInt(2)),
  };
}

export function normalizePin(pin: string): string {
  if (typeof pin !== "string" || !/^[0-9]{6}$/.test(pin.trim())) throw new TypeError("Expected a six-digit PIN");
  return pin.trim();
}

function validateLocation(location: Location) {
  location = inertRecord(location, ["pin", "coordinates"]);
  const pin = normalizePin(location.pin);
  let coordinates = location.coordinates;
  if (coordinates !== null) {
    coordinates = inertRecord(coordinates, ["latitude", "longitude", "confirmed"]);
    if (typeof coordinates.latitude !== "number" || !Number.isFinite(coordinates.latitude) || Math.abs(coordinates.latitude) > 90
      || typeof coordinates.longitude !== "number" || !Number.isFinite(coordinates.longitude) || Math.abs(coordinates.longitude) > 180
      || typeof coordinates.confirmed !== "boolean" || (coordinates.latitude === 0 && coordinates.longitude === 0)) throw new RangeError("Invalid coordinates");
  }
  return { pin, coordinates: coordinates?.confirmed ? coordinates : null };
}

/** Pure geographic gate; valid but unconfirmed coordinates are not used.
 * Known out-of-radius coordinates cannot bypass eligibility through a PIN. */
export function geographicEligibility(resident: Location, helper: Location, maxDistanceMeters: number): Geography | null {
  if (!Number.isFinite(maxDistanceMeters) || maxDistanceMeters < 0) throw new RangeError("Invalid travel limit");
  const a = validateLocation(resident), b = validateLocation(helper);
  if (!a.coordinates || !b.coordinates) return a.pin === b.pin ? { kind: "same_pin", distanceMeters: null, label: "Distance unavailable" } : null;
  const radians = Math.PI / 180;
  const lat = (b.coordinates.latitude - a.coordinates.latitude) * radians;
  const lon = (b.coordinates.longitude - a.coordinates.longitude) * radians;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.coordinates.latitude * radians) * Math.cos(b.coordinates.latitude * radians) * Math.sin(lon / 2) ** 2;
  const distance = 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  return distance <= maxDistanceMeters ? { kind: "confirmed", distanceMeters: distance } : null;
}

function tier(deviation: number): TimeOption["tier"] { return deviation === 0 ? 0 : deviation <= 30 ? 1 : deviation <= 60 ? 2 : 3; }
function timeOrder(a: TimeOption, b: TimeOption) {
  return a.tier - b.tier || a.worstDeviation - b.worstDeviation || a.combinedDeviation - b.combinedDeviation;
}
function optionOrder(a: TimeOption, b: TimeOption) { return timeOrder(a, b) || compareId(a.stableId, b.stableId); }

/** Enumerates pairs jointly. Identical-service visit permutations are deduped,
 * retaining the assignment nearest the original preference; no greedy pick. */
export function timeOptions(schedule: Schedule, days: readonly Weekday[], service: ServicePackage, preferredStarts: readonly number[], requestedVisits?: readonly number[]): TimeOption[] {
  service = validatePackage(service);
  const durations = serviceDurations(service);
  preferredStarts = inertArray(preferredStarts);
  if (!Array.isArray(preferredStarts) || preferredStarts.length !== durations.length) throw new RangeError("One preferred start per visit is required");
  for (const value of preferredStarts) minute(value);
  if (new Set(preferredStarts).size !== preferredStarts.length) throw new RangeError("Preferred times must be distinct");
  const visits = requestedVisits === undefined ? durations.map((_, i) => i + 1) : inertArray(requestedVisits);
  if (!Array.isArray(visits) || visits.length !== durations.length || new Set(visits).size !== visits.length) throw new RangeError("Invalid requested visit mapping");
  for (const value of visits) integer(value, 1, 2);
  const candidates = durations.map(value => commonStarts(schedule, days, value));
  const selected = normalizeDays(days);
  const consecutiveDays = selected.some(day => selected.includes((day % 7 + 1) as Weekday));
  const combinations = durations.length === 1 ? candidates[0].map(start => [start]) : candidates[0].flatMap(first => candidates[1]
    .filter(second => (first + durations[0] + GAP <= second || second + durations[1] + GAP <= first)
      && (!consecutiveDays || Math.max(first + durations[0], second + durations[1]) + GAP <= 1440 + Math.min(first, second)))
    .map(second => [first, second]));
  const unique = new Map<string, TimeOption>();
  for (const starts of combinations) {
    const deviations = starts.map((start, i) => Math.abs(start - preferredStarts[i]));
    const worstDeviation = Math.max(...deviations);
    const interchangeable = durations.length === 2 && service.houseSize === null;
    const key = (interchangeable ? [...starts].sort((a, b) => a - b) : starts).join(":");
    const stableId = starts.map(start => String(start).padStart(4, "0")).join(":") + ":" + visits.join(":");
    const option = { starts, durations: [...durations], requestedVisits: [...visits], tier: tier(worstDeviation), worstDeviation,
      combinedDeviation: deviations.reduce((sum, value) => sum + value, 0), stableId };
    const previous = unique.get(key);
    if (!previous || optionOrder(option, previous) < 0) unique.set(key, option);
  }
  return [...unique.values()].sort(optionOrder);
}

function packageKey(service: ServicePackage) { return `${service.houseSize ?? "none"}:${service.utensils}:${service.cleaningVisit ?? 0}`; }

function subsetOptions(helper: Helper, request: Request, subset: ServicePackage): TimeOption[] {
  const original = validatePackage(request.service);
  if (subset.utensils === 2 || original.utensils !== 2) return timeOptions(helper.schedule, request.days, subset, request.preferredStarts);
  // Dropping one visit is explicit. House cleaning stays associated with its
  // original preferred visit; utensil-only partials may select either visit.
  const visits = subset.houseSize !== null ? [(original.cleaningVisit ?? 1) - 1] : [0, 1];
  const unique = new Map<number, TimeOption>();
  for (const visit of visits) {
    for (const option of timeOptions(helper.schedule, request.days, subset, [request.preferredStarts[visit]], [visit + 1])) {
      const previous = unique.get(option.starts[0]);
      if (!previous || optionOrder(option, previous) < 0) unique.set(option.starts[0], option);
    }
  }
  return [...unique.values()].sort(optionOrder);
}

function helperOffers(helper: Helper, request: Request): Offer[] {
  const wanted = validatePackage(request.service);
  const houseAvailable = wanted.houseSize !== null && Object.hasOwn(helper.capabilities.housePricesPaise, wanted.houseSize);
  const candidates: ServicePackage[] = [];
  for (const withHouse of houseAvailable ? [true, false] : [false]) {
    for (let utensils = Math.min(wanted.utensils, helper.capabilities.maxUtensilsVisits); utensils >= 0; utensils--) {
      if (!withHouse && utensils === 0) continue;
      candidates.push({ houseSize: withHouse ? wanted.houseSize : null, utensils: utensils as 0 | 1 | 2,
        ...(withHouse ? { cleaningVisit: utensils === 2 ? wanted.cleaningVisit ?? 1 : 1 } : {}) });
    }
  }
  const feasible = candidates.flatMap(available => {
    const options = subsetOptions(helper, request, available);
    if (!options.length) return [];
    const full = available.houseSize === wanted.houseSize && available.utensils === wanted.utensils;
    const offer: Offer = {
      available,
      unavailable: { houseSize: available.houseSize === wanted.houseSize ? null : wanted.houseSize, utensilsVisits: wanted.utensils - available.utensils },
      price: packagePrice(helper.capabilities, available, request.days), options,
      badge: full ? null : "Partial service available",
      action: { label: full ? "Book requested service" : wanted.utensils === 2 && available.utensils === 1 ? "Book once-daily service" : "Book available service",
        requiresSubsetConfirmation: !full, service: { ...available } },
    };
    return [offer];
  });
  const full = feasible.filter(offer => offer.badge === null);
  // Never advertise smaller subsets when the entire request is feasible.
  // Otherwise retain maximal feasible subsets: house-only and utensils-only
  // may coexist, but neither is an automatic residual booking.
  const offers = full.length ? full : feasible.filter(offer => !feasible.some(other => other !== offer
    && (offer.available.houseSize === null || other.available.houseSize === offer.available.houseSize)
    && other.available.utensils >= offer.available.utensils
    && (other.available.houseSize !== offer.available.houseSize || other.available.utensils > offer.available.utensils)));
  return offers.sort((a, b) => optionOrder(a.options[0], b.options[0]) || compareId(packageKey(a.available), packageKey(b.available)));
}

/** Global ordering: full before partial; within each group, confirmed location
 * before same-PIN fallback; then time tier/deviation, distance, helper ID.
 * Each helper appears once. No booking, residual request or mutation occurs.
 */
export function matchHelpers(request: Request, helpers: readonly Helper[]): HelperMatch[] {
  request = inertRecord(request, ["days", "service", "preferredStarts", "location"]);
  request = { ...request, days: normalizeDays(request.days), service: validatePackage(request.service), preferredStarts: inertArray(request.preferredStarts) };
  const durations = serviceDurations(request.service);
  if (!Array.isArray(request.preferredStarts) || request.preferredStarts.length !== durations.length) throw new RangeError("Invalid preferred visits");
  for (const value of request.preferredStarts) minute(value);
  if (new Set(request.preferredStarts).size !== durations.length) throw new RangeError("Preferred times must be distinct");
  validateLocation(request.location);
  helpers = inertArray(helpers);
  const seen = new Set<string>();
  const matches: HelperMatch[] = [];
  for (let helper of helpers) {
    helper = inertRecord(helper, ["id", "schedule", "capabilities", "location", "maxDistanceMeters"]);
    if (typeof helper.id !== "string" || !helper.id.trim() || seen.has(helper.id)) throw new RangeError("Helper identifiers must be unique and nonempty");
    seen.add(helper.id);
    validateSchedule(helper.schedule);
    helper = { ...helper, capabilities: validateCapabilities(helper.capabilities) };
    const geography = geographicEligibility(request.location, helper.location, helper.maxDistanceMeters);
    if (!geography) continue;
    const offers = helperOffers(helper, request);
    if (offers.length) matches.push({ helperId: helper.id, kind: offers[0].badge === null ? "full" : "partial", geography, offers });
  }
  return matches.sort((a, b) => Number(a.kind === "partial") - Number(b.kind === "partial")
    || Number(a.geography.kind === "same_pin") - Number(b.geography.kind === "same_pin")
    || timeOrder(a.offers[0].options[0], b.offers[0].options[0])
    || (a.geography.distanceMeters ?? 0) - (b.geography.distanceMeters ?? 0)
    || compareId(a.helperId, b.helperId));
}
