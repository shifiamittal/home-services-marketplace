import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";

import { fieldError, profileFailure } from "../../../lib/profile-errors";
import { saveAvailability } from "../../../lib/profile-availability";

type ServiceKey = "house_cleaning" | "utensils_once" | "utensils_twice";
type HomeSize = "one_two_bhk" | "three_bhk" | "four_plus_bhk" | "not_applicable";
type DayPattern = "mon_sat" | "mon_fri" | "every_day";

const patternDays: Record<DayPattern, number[]> = {
  mon_sat: [1, 2, 3, 4, 5, 6],
  mon_fri: [1, 2, 3, 4, 5],
  every_day: [0, 1, 2, 3, 4, 5, 6],
};

function minuteOfDay(value: unknown) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return -1;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatMinute(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

async function requireHelper(request: Request) {
  const session = await getSession(request);
  if (!session) throw Response.json({ error: "Sign in again to continue." }, { status: 401 });
  if (!session.roles.includes("provider")) throw Response.json({ error: "A home helper account is required." }, { status: 403 });
  return session;
}

export async function GET(request: Request) {
  try {
    const session = await requireHelper(request);
    const db = await getD1();
    const profile = await db.prepare(
      `SELECT home_locality, home_address, latitude_e6, longitude_e6, max_travel_distance_meters,
              landmark, years_experience, verification_status, profile_status
       FROM helper_profiles WHERE user_id = ? LIMIT 1`,
    ).bind(session.user_id).first<Record<string, string | number>>();
    const offerings = await db.prepare(
      `SELECT service_type, home_size, monthly_price_paise, is_active
       FROM helper_offerings WHERE helper_user_id = ? ORDER BY service_type, home_size`,
    ).bind(session.user_id).all<Record<string, string | number>>();
    const slots = await db.prepare(
      `SELECT source_group_id, day_pattern, start_minute, end_minute
       FROM availability_slots WHERE helper_user_id = ? AND status = 'open'
       ORDER BY created_at, day_of_week`,
    ).bind(session.user_id).all<{ source_group_id: string | null; day_pattern: DayPattern | null; start_minute: number; end_minute: number }>();
    const document = await db.prepare(
      `SELECT original_filename, document_type, status, created_at
       FROM verification_documents
       WHERE helper_user_id = ? AND status != 'deleted'
       ORDER BY CASE WHEN status IN ('pending', 'verified') THEN 0 ELSE 1 END, created_at DESC, id LIMIT 1`,
    ).bind(session.user_id).first<Record<string, string>>();

    const grouped = new Map<string, { id: string; days: DayPattern; start: string; end: string }>();
    for (const slot of slots.results) {
      const id = slot.source_group_id || crypto.randomUUID();
      if (!grouped.has(id)) grouped.set(id, {
        id,
        days: slot.day_pattern || "mon_sat",
        start: formatMinute(slot.start_minute),
        end: formatMinute(slot.end_minute),
      });
    }

    return Response.json({
      exists: Boolean(profile),
      profile: profile ? {
        locality: profile.home_locality,
        homeAddress: profile.home_address || "",
        latitude: typeof profile.latitude_e6 === "number" ? profile.latitude_e6 / 1_000_000 : null,
        longitude: typeof profile.longitude_e6 === "number" ? profile.longitude_e6 / 1_000_000 : null,
        travelDistanceKm: typeof profile.max_travel_distance_meters === "number" ? profile.max_travel_distance_meters / 1_000 : null,
        landmark: profile.landmark || "",
        yearsExperience: profile.years_experience,
        verificationStatus: profile.verification_status,
        profileStatus: profile.profile_status,
      } : null,
      offerings: offerings.results,
      availability: [...grouped.values()],
      addressProof: document ? {
        filename: document.original_filename,
        documentType: document.document_type,
        status: document.status,
        uploadedAt: document.created_at,
      } : null,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not load your work profile." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireHelper(request);
    const body = await request.json().catch(() => null) as null | {
      locality?: unknown;
      homeAddress?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      travelDistanceKm?: unknown;
      yearsExperience?: unknown;
      offerings?: unknown;
      availability?: unknown;
    };
    if (!body || typeof body !== "object" || Array.isArray(body)) return fieldError("profile", "Provide a valid profile.");
    const locality = typeof body.locality === "string" ? body.locality.trim() : "";
    const homeAddress = typeof body.homeAddress === "string" ? body.homeAddress.trim() : "";
    const latitude = typeof body.latitude === "number" ? body.latitude : NaN;
    const longitude = typeof body.longitude === "number" ? body.longitude : NaN;
    const travelDistanceKm = Number(body.travelDistanceKm);
    const yearsExperience = Number(body.yearsExperience);
    if (!locality || locality.length > 160 || !homeAddress || homeAddress.length > 300 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return fieldError("address", "Choose your starting address from Google suggestions.");
    }
    if (!Number.isFinite(travelDistanceKm) || travelDistanceKm <= 0 || travelDistanceKm > 500) {
      return fieldError("travelDistanceKm", "Enter an approximate travel distance in kilometres.");
    }
    if (!Number.isInteger(yearsExperience) || yearsExperience < 0 || yearsExperience > 60) {
      return fieldError("yearsExperience", "Enter valid years of experience.");
    }

    const rawOfferings = Array.isArray(body.offerings) ? body.offerings : [];
    const offerings: Array<{ serviceType: ServiceKey; homeSize: HomeSize; monthlyPricePaise: number }> = [];
    const offeringKeys = new Set<string>();
    for (const item of rawOfferings) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return fieldError("offerings", "Choose valid service prices.");
      const value = item as Record<string, unknown>;
      const serviceType = value.serviceType as ServiceKey;
      const homeSize = value.homeSize as HomeSize;
      const monthlyPriceRupees = Number(value.monthlyPriceRupees);
      const validService = ["house_cleaning", "utensils_once", "utensils_twice"].includes(serviceType);
      const validHomeSize = serviceType === "house_cleaning"
        ? ["one_two_bhk", "three_bhk", "four_plus_bhk"].includes(homeSize)
        : homeSize === "not_applicable";
      if (!validService || !validHomeSize || !Number.isInteger(monthlyPriceRupees) || monthlyPriceRupees < 100 || monthlyPriceRupees > 100_000) {
        return fieldError("offerings", "Enter a valid monthly price for every selected service.");
      }
      const key = `${serviceType}:${homeSize}`;
      if (offeringKeys.has(key)) return fieldError("offerings", "A service price was entered more than once.");
      offeringKeys.add(key);
      offerings.push({ serviceType, homeSize, monthlyPricePaise: monthlyPriceRupees * 100 });
    }
    if (!offerings.length) return fieldError("offerings", "Select at least one service.");

    const rawAvailability = Array.isArray(body.availability) ? body.availability : [];
    if (rawAvailability.length > 28) return fieldError("availability", "Use at most 28 recurring windows.");
    const availability: Array<{ id: string; pattern: DayPattern; start: number; end: number }> = [];
    for (const item of rawAvailability) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return fieldError("availability", "Choose valid recurring windows.");
      const value = item as Record<string, unknown>;
      const pattern = value.days as DayPattern;
      const start = minuteOfDay(value.start);
      const end = minuteOfDay(value.end);
      if (!Object.hasOwn(patternDays, pattern) || start < 0 || end < 0 || end - start < 30) {
        return fieldError("availability", "Each available time must be at least 30 minutes and end after it starts.");
      }
      availability.push({ id: crypto.randomUUID(), pattern, start, end });
    }
    if (!availability.length) return fieldError("availability", "Add at least one available time.");

    for (let first = 0; first < availability.length; first += 1) {
      for (let second = first + 1; second < availability.length; second += 1) {
        const sharesDay = patternDays[availability[first].pattern].some(day => patternDays[availability[second].pattern].includes(day));
        if (sharesDay && availability[first].start < availability[second].end + 15 && availability[second].start < availability[first].end + 15) {
          return fieldError("availability", "Available times on the same day need a 15-minute travel buffer.");
        }
      }
    }

    const db = await getD1();
    const addressProof = await db.prepare(
      `SELECT id FROM verification_documents
       WHERE helper_user_id = ? AND status IN ('pending', 'verified')
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(session.user_id).first<{ id: string }>();
    if (!addressProof) {
      return fieldError("addressProof", "Upload a valid address-proof document before publishing your profile.", 409);
    }
    const statements = [
      db.prepare(
        `INSERT INTO helper_profiles
           (user_id, home_locality, home_address, latitude_e6, longitude_e6, max_travel_distance_meters, years_experience, profile_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
         ON CONFLICT(user_id) DO UPDATE SET home_locality = excluded.home_locality, home_address = excluded.home_address,
         latitude_e6 = excluded.latitude_e6, longitude_e6 = excluded.longitude_e6,
         max_travel_distance_meters = excluded.max_travel_distance_meters, years_experience = excluded.years_experience,
         profile_status = CASE WHEN helper_profiles.profile_status IN ('draft', 'active')
           THEN 'active' ELSE helper_profiles.profile_status END, updated_at = CURRENT_TIMESTAMP`,
      ).bind(session.user_id, locality, homeAddress, Math.round(latitude * 1_000_000), Math.round(longitude * 1_000_000), Math.round(travelDistanceKm * 1_000), yearsExperience),
      db.prepare("DELETE FROM helper_offerings WHERE helper_user_id = ?").bind(session.user_id),
      ...saveAvailability(db, session.user_id, availability.flatMap(group => patternDays[group.pattern].map(day => ({ day, start: group.start, end: group.end, pattern: group.pattern })))),
    ];
    for (const offering of offerings) {
      statements.push(db.prepare(
        `INSERT INTO helper_offerings (id, helper_user_id, service_type, home_size, monthly_price_paise, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
      ).bind(crypto.randomUUID(), session.user_id, offering.serviceType, offering.homeSize, offering.monthlyPricePaise));
    }
    statements.push(db.prepare(
      "INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'helper_profile_saved', ?)",
    ).bind(crypto.randomUUID(), session.user_id, JSON.stringify({ offeringCount: offerings.length, availabilityGroupCount: availability.length, travelDistanceKm })));
    await db.batch(statements);
    const saved = await db.prepare("SELECT profile_status FROM helper_profiles WHERE user_id = ?").bind(session.user_id).first<{ profile_status: string }>();
    return Response.json({ saved: true, profileStatus: saved?.profile_status, combinedPricesCalculated: true });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof Error && error.message.includes("malformed JSON")) {
      return fieldError("availability", "These hours would exclude a pending request or booked service. Keep its time available.", 409);
    }
    return profileFailure("profile_save");
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireHelper(request);
    const body = await request.json() as { paused?: unknown };
    if (typeof body.paused !== "boolean") return Response.json({ error: "Choose whether your profile is active." }, { status: 400 });
    const db = await getD1();
    const nextStatus = body.paused ? "paused" : "active";
    const result = await db.prepare(
      "UPDATE helper_profiles SET profile_status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND profile_status IN ('active', 'paused')",
    ).bind(nextStatus, session.user_id).run();
    if (!result.meta.changes) return Response.json({ error: "Complete your work profile before changing availability." }, { status: 409 });
    await db.prepare(
      "INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'helper_profile_status_changed', ?)",
    ).bind(crypto.randomUUID(), session.user_id, JSON.stringify({ profileStatus: nextStatus })).run();
    return Response.json({ saved: true, profileStatus: nextStatus });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not update your profile availability." }, { status: 500 });
  }
}
