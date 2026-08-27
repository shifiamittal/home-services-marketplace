import { requireCompleteResident } from "../../../lib/profile-completeness";
import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";

type Service = "house_cleaning" | "utensils_once" | "utensils_twice" | "house_plus_utensils_once" | "house_plus_utensils_twice";
type HomeSize = "one_two_bhk" | "three_bhk" | "four_plus_bhk";

type HelperRow = {
  user_id: string;
  name: string;
  latitude_e6: number;
  longitude_e6: number;
  max_travel_distance_meters: number | null;
  years_experience: number;
  verification_status: string;
};

type OfferingRow = {
  helper_user_id: string;
  service_type: string;
  home_size: string;
  monthly_price_paise: number;
};

type SlotRow = {
  helper_user_id: string;
  day_of_week: number;
  start_minute: number;
  end_minute: number;
};
type BusyRow = { helper_user_id: string; day_of_week: number; start_minute: number; end_minute: number };

const weekdays = [1, 2, 3, 4, 5, 6];

function minuteOfDay(value: unknown) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return -1;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatMinute(value: number) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const deltaLat = radians(lat2 - lat1);
  const deltaLon = radians(lon2 - lon1);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function cleaningDuration(homeSize: HomeSize) {
  if (homeSize === "one_two_bhk") return 30;
  if (homeSize === "three_bhk") return 45;
  return 60;
}

function combinedDuration(homeSize: HomeSize) {
  if (homeSize === "one_two_bhk") return 60;
  if (homeSize === "three_bhk") return 75;
  return 90;
}

function candidateStarts(requested: number, flexibility: number) {
  const candidates: number[] = [];
  for (let offset = 0; offset <= flexibility; offset += 1) {
    if (requested - offset >= 0) candidates.push(requested - offset);
    if (offset && requested + offset < 1_440) candidates.push(requested + offset);
  }
  return candidates;
}

function recurringStart(slots: SlotRow[], busy: BusyRow[], requested: number, duration: number, flexibility: number) {
  for (const candidate of candidateStarts(requested, flexibility)) {
    const availableEveryDay = weekdays.every(day => {
      const insideAvailability = slots.some(slot => slot.day_of_week === day
        && slot.start_minute <= candidate && slot.end_minute >= candidate + duration);
      const overlapsBusyTime = busy.some(item => item.day_of_week === day
        && candidate < item.end_minute + 15 && item.start_minute < candidate + duration + 15);
      return insideAvailability && !overlapsBusyTime;
    });
    if (availableEveryDay) return candidate;
  }
  return null;
}

function packagePrice(offerings: OfferingRow[], service: Service, homeSize: HomeSize) {
  const price = (serviceType: string, size: string) => offerings.find(item =>
    item.service_type === serviceType && item.home_size === size,
  )?.monthly_price_paise;
  const house = price("house_cleaning", homeSize);
  const once = price("utensils_once", "not_applicable");
  const twice = price("utensils_twice", "not_applicable");
  if (service === "house_cleaning") return house ?? null;
  if (service === "utensils_once") return once ?? null;
  if (service === "utensils_twice") return twice ?? null;
  if (service === "house_plus_utensils_once") return house != null && once != null ? house + once : null;
  return house != null && twice != null ? house + twice : null;
}

async function requireResident(request: Request) {
  const session = await getSession(request);
  if (!session) throw Response.json({ error: "Sign in again to continue." }, { status: 401 });
  if (!session.roles.includes("resident")) throw Response.json({ error: "A resident account is required." }, { status: 403 });
  return session;
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireResident(request);
    const db = await getD1();
    await requireCompleteResident(db, session.user_id);
    const body = await request.json() as Record<string, unknown>;
    const service = body.service as Service;
    const homeSize = body.homeSize as HomeSize;
    const firstRequested = minuteOfDay(body.firstTime);
    const secondRequested = minuteOfDay(body.secondTime);
    const flexibility = Number(body.flexibilityMinutes);
    const cleaningVisit = body.cleaningVisit === "second" ? "second" : "first";
    if (![
      "house_cleaning", "utensils_once", "utensils_twice", "house_plus_utensils_once", "house_plus_utensils_twice",
    ].includes(service) || !["one_two_bhk", "three_bhk", "four_plus_bhk"].includes(homeSize)
      || firstRequested < 0 || ![0, 30, 60].includes(flexibility)
      || (service.endsWith("twice") && secondRequested < 0)) {
      return Response.json({ error: "Choose a valid service, home size and preferred time." }, { status: 400 });
    }

    const unpaidTrial = await db.prepare(
      `SELECT id FROM trial_payments WHERE resident_user_id = ?
       AND status IN ('pending', 'resident_marked_paid') LIMIT 1`,
    ).bind(session.user_id).first<{ id: string }>();
    if (unpaidTrial) {
      return Response.json({ error: "Complete the payment for finished trial work before searching for another home helper." }, { status: 409 });
    }
    const existingBooking = await db.prepare(
      `SELECT br.id FROM booking_requests br LEFT JOIN bookings b ON b.request_id = br.id
       WHERE br.resident_user_id = ?
         AND (br.status = 'pending' OR b.status IN ('trial', 'active', 'ending'))
       LIMIT 1`,
    ).bind(session.user_id).first<{ id: string }>();
    if (existingBooking) {
      return Response.json({ error: "Manage your current request or booking before searching for another home helper." }, { status: 409 });
    }
    const address = await db.prepare(
      `SELECT latitude_e6, longitude_e6 FROM resident_addresses
       WHERE resident_user_id = ? AND is_primary = 1 LIMIT 1`,
    ).bind(session.user_id).first<{ latitude_e6: number | null; longitude_e6: number | null }>();
    if (!address || typeof address.latitude_e6 !== "number" || typeof address.longitude_e6 !== "number") {
      return Response.json({ error: "Add your home address before searching for helpers." }, { status: 400 });
    }

    const [helpersResult, offeringsResult, slotsResult, reviewsResult, busyResult] = await Promise.all([
      db.prepare(
        `SELECT hp.user_id, u.name, hp.latitude_e6, hp.longitude_e6, hp.max_travel_distance_meters,
                hp.years_experience,
                CASE WHEN EXISTS (
                  SELECT 1 FROM verification_documents vd
                  WHERE vd.helper_user_id = hp.user_id AND vd.status IN ('pending', 'verified')
                ) THEN 'verified' ELSE hp.verification_status END AS verification_status
         FROM helper_profiles hp JOIN users u ON u.id = hp.user_id
         WHERE hp.profile_status = 'active' AND u.status = 'active'
           AND hp.latitude_e6 IS NOT NULL AND hp.longitude_e6 IS NOT NULL`,
      ).all<HelperRow>(),
      db.prepare(
        `SELECT helper_user_id, service_type, home_size, monthly_price_paise
         FROM helper_offerings WHERE is_active = 1`,
      ).all<OfferingRow>(),
      db.prepare(
        `SELECT helper_user_id, day_of_week, start_minute, end_minute
         FROM availability_slots WHERE status = 'open'`,
      ).all<SlotRow>(),
      db.prepare(
        `SELECT subject_user_id, AVG(rating) AS average_rating, COUNT(*) AS review_count
         FROM reviews WHERE status = 'published' GROUP BY subject_user_id`,
      ).all<{ subject_user_id: string; average_rating: number; review_count: number }>(),
      db.prepare(
        `SELECT br.helper_user_id, rs.day_of_week, rs.start_minute, rs.end_minute
         FROM request_slots rs JOIN booking_requests br ON br.id = rs.request_id
         WHERE br.status = 'pending' AND br.response_due_at > CURRENT_TIMESTAMP
         UNION ALL
         SELECT b.helper_user_id, bs.day_of_week, bs.start_minute, bs.end_minute
         FROM booking_slots bs JOIN bookings b ON b.id = bs.booking_id
         WHERE b.status IN ('trial', 'active', 'ending')`,
      ).all<BusyRow>(),
    ]);

    const offeringsByHelper = new Map<string, OfferingRow[]>();
    for (const item of offeringsResult.results) {
      const list = offeringsByHelper.get(item.helper_user_id) ?? [];
      list.push(item);
      offeringsByHelper.set(item.helper_user_id, list);
    }
    const slotsByHelper = new Map<string, SlotRow[]>();
    for (const item of slotsResult.results) {
      const list = slotsByHelper.get(item.helper_user_id) ?? [];
      list.push(item);
      slotsByHelper.set(item.helper_user_id, list);
    }
    const reviewsByHelper = new Map(reviewsResult.results.map(item => [item.subject_user_id, item]));
    const busyByHelper = new Map<string, BusyRow[]>();
    for (const item of busyResult.results) {
      const list = busyByHelper.get(item.helper_user_id) ?? [];
      list.push(item);
      busyByHelper.set(item.helper_user_id, list);
    }

    const firstDuration = service === "house_cleaning"
      ? cleaningDuration(homeSize)
      : service === "utensils_once" || service === "utensils_twice"
        ? 30
        : service === "house_plus_utensils_once"
          ? combinedDuration(homeSize)
          : cleaningVisit === "first" ? combinedDuration(homeSize) : 30;
    const secondDuration = service === "house_plus_utensils_twice" && cleaningVisit === "second"
      ? combinedDuration(homeSize)
      : 30;
    const needsSecondVisit = service === "utensils_twice" || service === "house_plus_utensils_twice";

    const residentLatitude = address.latitude_e6 / 1_000_000;
    const residentLongitude = address.longitude_e6 / 1_000_000;
    const matches = helpersResult.results.flatMap(helper => {
      const helperOfferings = offeringsByHelper.get(helper.user_id) ?? [];
      const monthlyPricePaise = packagePrice(helperOfferings, service, homeSize);
      if (monthlyPricePaise == null) return [];
      const helperSlots = slotsByHelper.get(helper.user_id) ?? [];
      const helperBusy = busyByHelper.get(helper.user_id) ?? [];
      const firstStart = recurringStart(helperSlots, helperBusy, firstRequested, firstDuration, flexibility);
      if (firstStart == null) return [];
      const secondStart = needsSecondVisit
        ? recurringStart(helperSlots, helperBusy, secondRequested, secondDuration, flexibility)
        : null;
      if (needsSecondVisit && secondStart == null) return [];
      if (secondStart != null) {
        const separated = firstStart + firstDuration + 15 <= secondStart
          || secondStart + secondDuration + 15 <= firstStart;
        if (!separated) return [];
      }

      const distanceKm = haversineKm(
        residentLatitude,
        residentLongitude,
        helper.latitude_e6 / 1_000_000,
        helper.longitude_e6 / 1_000_000,
      );
      const preferredKm = helper.max_travel_distance_meters == null ? null : helper.max_travel_distance_meters / 1_000;
      const withinTravelPreference = preferredKm == null || distanceKm <= preferredKm;
      const deviation = Math.abs(firstStart - firstRequested)
        + (secondStart == null ? 0 : Math.abs(secondStart - secondRequested));
      const review = reviewsByHelper.get(helper.user_id);
      const averageRating = review ? Number(review.average_rating) : null;
      const score = deviation * 4 + distanceKm * 5 + (withinTravelPreference ? 0 : 45)
        - Math.min(helper.years_experience, 20) - (averageRating ? averageRating * 2 : 0);
      return [{
        id: helper.user_id,
        name: helper.name,
        monthlyPriceRupees: Math.round(monthlyPricePaise / 100),
        firstTime: formatMinute(firstStart),
        secondTime: secondStart == null ? null : formatMinute(secondStart),
        exactTime: deviation === 0,
        timeDifferenceMinutes: deviation,
        distanceKm: Math.round(distanceKm * 10) / 10,
        withinTravelPreference,
        yearsExperience: helper.years_experience,
        addressProofProvided: helper.verification_status === "pending" || helper.verification_status === "verified",
        averageRating: averageRating == null ? null : Math.round(averageRating * 10) / 10,
        reviewCount: Number(review?.review_count ?? 0),
        score,
      }];
    }).sort((first, second) => first.score - second.score);

    await db.prepare(
      "INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'resident_matches_viewed', ?)",
    ).bind(crypto.randomUUID(), session.user_id, JSON.stringify({ service, homeSize, resultCount: matches.length, flexibility })).run();

    return Response.json({ matches });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not find available helpers. Please try again." }, { status: 500 });
  }
}
