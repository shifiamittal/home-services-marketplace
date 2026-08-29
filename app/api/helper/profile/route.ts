import { coordinates, effectiveLocationText, storedCoordinates } from "../../../lib/address-integrity";
import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";

import { fieldError, profileFailure } from "../../../lib/profile-errors";
import { exactDays, loadSchedule, minuteOfDay, scheduleWriteGuard, validWindow, type StoredWindow } from "../../../lib/helper-schedule";
import { helperAddressExpressions, saveAddressVerification } from "../../../lib/helper-address-verification";
import { saveAvailability } from "../../../lib/profile-availability";
import { formattedHelperAddress, parseHelperAddress, type HelperAddress } from "../../../lib/helper-address";
import { helperAddressState, meaningfulLegacyHelperAddressSql, storedStructuredHelperAddress } from "../../../lib/helper-address-state";
import { parseLegacyOfferings, parseServices, servicesResponse, type OfferingRow } from "../../../lib/helper-offerings";
import { loadBusyPeriods, parseBusyPeriods, saveBusyPeriods, type BusyPeriod } from "../../../lib/helper-busy-periods";
type DayPattern = "mon_sat" | "mon_fri" | "every_day";

const patternDays: Record<DayPattern, number[]> = {
  mon_sat: [1, 2, 3, 4, 5, 6],
  mon_fri: [1, 2, 3, 4, 5],
  every_day: [0, 1, 2, 3, 4, 5, 6],
};

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
      `SELECT home_locality, home_address, house_or_flat, floor, building_or_society, city, state, pin_code,
              latitude_e6, longitude_e6, max_travel_distance_meters,
              landmark, years_experience, verification_status, profile_status
       FROM helper_profiles WHERE user_id = ? LIMIT 1`,
    ).bind(session.user_id).first<Record<string, string | number>>();
    const offerings = await db.prepare(
      `SELECT service_type, home_size, monthly_price_paise, is_active
       FROM helper_offerings WHERE helper_user_id = ? ORDER BY service_type, home_size`,
    ).bind(session.user_id).all<{ service_type: string; home_size: string; monthly_price_paise: number; is_active: number }>();
    const slots = await db.prepare(
      `SELECT day_of_week, start_minute, end_minute
       FROM availability_slots WHERE helper_user_id = ? AND status = 'open'
       ORDER BY created_at, day_of_week`,
    ).bind(session.user_id).all<StoredWindow>();
    const busy = await db.prepare(`SELECT id,day_of_week,start_minute,end_minute FROM external_busy_periods
      WHERE helper_user_id=? AND status='active' ORDER BY start_minute,end_minute,day_of_week`).bind(session.user_id)
      .all<{ id: string; day_of_week: number; start_minute: number; end_minute: number }>();
    const document = await db.prepare(
      `SELECT original_filename, document_type, status, created_at
       FROM verification_documents
       WHERE helper_user_id = ? AND status != 'deleted'
       ORDER BY CASE WHEN status IN ('pending', 'verified') THEN 0 ELSE 1 END, created_at DESC, id LIMIT 1`,
    ).bind(session.user_id).first<Record<string, string>>();

    const schedule = loadSchedule(slots.results);

    const point = profile ? storedCoordinates(profile.latitude_e6, profile.longitude_e6) : null;
    const addressState = profile ? helperAddressState(profile) : "none";
    const structuredAddress = profile && addressState === "structured" ? storedStructuredHelperAddress(profile) : null;
    const legacyAddress = profile && addressState === "legacy" ? effectiveLocationText(profile.home_address, profile.home_locality) : null;
    const serviceState = servicesResponse(offerings.results);
    return Response.json({
      exists: Boolean(profile),
      profile: profile ? {
        locality: profile.home_locality,
        homeAddress: effectiveLocationText(profile.home_address, null),
        addressState,
        address: structuredAddress,
        legacyAddress,
        latitude: point?.latitude == null ? null : point.latitude / 1_000_000,
        longitude: point?.longitude == null ? null : point.longitude / 1_000_000,
        travelDistanceKm: typeof profile.max_travel_distance_meters === "number" ? profile.max_travel_distance_meters / 1_000 : null,
        landmark: profile.landmark || "",
        yearsExperience: profile.years_experience,
        verificationStatus: profile.verification_status,
        profileStatus: profile.profile_status,
      } : null,
      offerings: offerings.results,
      ...serviceState,
      availability: schedule.kind === "common" ? schedule.windows : [],
      schedule,
      busyPeriods: loadBusyPeriods(busy.results),
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
  let updatingBusyPeriods = false;
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
      services?: unknown;
      availability?: unknown;
      replaceSchedule?: unknown;
      address?: unknown;
      preserveAddress?: unknown;
      busyPeriods?: unknown;
    };
    if (!body || typeof body !== "object" || Array.isArray(body)) return fieldError("profile", "Provide a valid profile.");
    if (body.preserveAddress !== undefined && typeof body.preserveAddress !== "boolean") return fieldError("address", "Choose whether to keep your saved address.");
    const preserveAddress = body.preserveAddress === true;
    const writeStructuredAddress = body.address !== undefined;
    if (preserveAddress && writeStructuredAddress) return fieldError("address", "Choose either your saved address or a corrected address.");
    let structuredAddress: HelperAddress | null = null;
    let locality = "", homeAddress = "";
    if (writeStructuredAddress) {
      try { structuredAddress = parseHelperAddress(body.address); }
      catch (error) { return fieldError("address", error instanceof Error ? error.message : "Enter a valid address."); }
      locality = structuredAddress.city;
      homeAddress = formattedHelperAddress(structuredAddress);
    } else if (!preserveAddress) {
      // Compatibility for clients and records created before structured helper addresses.
      locality = typeof body.locality === "string" ? body.locality.trim() : "";
      homeAddress = typeof body.homeAddress === "string" ? body.homeAddress.trim() : "";
    }
    let point;
    try { point = preserveAddress ? { latitude: null, longitude: null } : coordinates(body.latitude, body.longitude); }
    catch { return fieldError("address", "Choose a valid address location."); }
    const omittedCoordinates = !preserveAddress && body.latitude === undefined && body.longitude === undefined;
    const travelDistanceKm = Number(body.travelDistanceKm);
    const yearsExperience = Number(body.yearsExperience);
    if (!preserveAddress && (!locality || locality.length > 160 || !homeAddress || homeAddress.length > 500)) {
      return fieldError("address", "Enter your required address details.");
    }
    if (!Number.isFinite(travelDistanceKm) || travelDistanceKm <= 0 || travelDistanceKm > 500) {
      return fieldError("travelDistanceKm", "Enter an approximate travel distance in kilometres.");
    }
    if (!Number.isInteger(yearsExperience) || yearsExperience < 0 || yearsExperience > 60) {
      return fieldError("yearsExperience", "Enter valid years of experience.");
    }

    const updateServices = body.services !== undefined || body.offerings !== undefined;
    let offerings: OfferingRow[] = [];
    if (updateServices) {
      try {
        offerings = body.services !== undefined ? parseServices(body.services) : parseLegacyOfferings(body.offerings);
      } catch (error) {
        return fieldError("offerings", error instanceof Error ? error.message : "Choose valid service prices.");
      }
    } else {
      const existing = await (await getD1()).prepare(
        "SELECT service_type, home_size, monthly_price_paise FROM helper_offerings WHERE helper_user_id = ? AND is_active = 1",
      ).bind(session.user_id).all<Record<string, string | number>>();
      if (!existing.results.length) return fieldError("offerings", "Select at least one service.");
    }

    const preserveSchedule = body.availability === undefined;
    const replaceSchedule = body.replaceSchedule === true;
    if (body.replaceSchedule !== undefined && typeof body.replaceSchedule !== "boolean") return fieldError("availability", "Confirm whether to replace your schedule.");
    if (!preserveSchedule && !Array.isArray(body.availability)) return fieldError("availability", "Choose valid working days and hours.");
    const rawAvailability = Array.isArray(body.availability) ? body.availability : [];
    const availability: Array<{ days: number[]; pattern: string | null; start: number; end: number }> = [];
    for (const item of rawAvailability) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return fieldError("availability", "Choose valid working days and hours.");
      const value = item as Record<string, unknown>;
      const explicitPattern = typeof value.days === "string" && Object.hasOwn(patternDays, value.days) ? value.days as DayPattern : null;
      let days: number[];
      try { days = exactDays(explicitPattern ? patternDays[explicitPattern] : value.days); }
      catch { return fieldError("availability", "Select at least one valid weekday."); }
      const start = minuteOfDay(value.start), end = minuteOfDay(value.end);
      if (!validWindow({ day_of_week: days[0], start_minute: start, end_minute: end })) return fieldError("availability", "Use same-day working hours on the 15-minute grid, ending after the start.");
      availability.push({ days, pattern: explicitPattern, start, end });
    }
    if (!preserveSchedule && availability.length !== 1) return fieldError("availability", "Select one common working-hours range for your selected days.");
    updatingBusyPeriods = body.busyPeriods !== undefined;
    let busyPeriods: BusyPeriod[] = [];
    if (updatingBusyPeriods) {
      try { busyPeriods = parseBusyPeriods(body.busyPeriods); }
      catch (error) { return fieldError("busyPeriods", error instanceof Error ? error.message : "Add valid recurring busy periods."); }
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
    const address = helperAddressExpressions("helper_profiles", "excluded", "?", "?");
    const statements = [
      // This is the first operation INSIDE the atomic batch. SQLite CASE
      // evaluates only the selected branch; abs(INT64_MIN) deliberately aborts
      // ineligible saves with an integer-overflow error, distinct from the
      // existing JSON-based commitment guards. No earlier read can authorize it.
      db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM users WHERE id = ? AND status = 'active'
      ) AND (NOT ? OR EXISTS (
        SELECT 1 FROM helper_profiles hp WHERE hp.user_id = ? AND ${meaningfulLegacyHelperAddressSql("hp")}
      )
      ) THEN 1 ELSE abs(-9223372036854775808) END`).bind(session.user_id, Number(preserveAddress), session.user_id),
      ...saveAddressVerification(db, session.user_id, { locality, homeAddress, ...point, omittedCoordinates, preserveAddress },
        JSON.stringify({ offeringCount: updateServices ? offerings.length : null, availabilityGroupCount: availability.length, travelDistanceKm })),
      db.prepare(
        `INSERT INTO helper_profiles
           (user_id, home_locality, home_address, house_or_flat, floor, building_or_society, city, state, pin_code,
            latitude_e6, longitude_e6, max_travel_distance_meters, years_experience, profile_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
         ON CONFLICT(user_id) DO UPDATE SET
         home_locality = CASE WHEN ? THEN helper_profiles.home_locality ELSE excluded.home_locality END,
         home_address = CASE WHEN ? THEN helper_profiles.home_address ELSE excluded.home_address END,
         house_or_flat = CASE WHEN ? THEN helper_profiles.house_or_flat ELSE excluded.house_or_flat END,
         floor = CASE WHEN ? THEN helper_profiles.floor ELSE excluded.floor END,
         building_or_society = CASE WHEN ? THEN helper_profiles.building_or_society ELSE excluded.building_or_society END,
         city = CASE WHEN ? THEN helper_profiles.city ELSE excluded.city END,
         state = CASE WHEN ? THEN helper_profiles.state ELSE excluded.state END,
         pin_code = CASE WHEN ? THEN helper_profiles.pin_code ELSE excluded.pin_code END,
         latitude_e6 = ${address.latitude}, longitude_e6 = ${address.longitude},
         max_travel_distance_meters = excluded.max_travel_distance_meters, years_experience = excluded.years_experience,
         profile_status = CASE WHEN helper_profiles.profile_status IN ('draft', 'active')
           THEN 'active' ELSE helper_profiles.profile_status END, updated_at = CURRENT_TIMESTAMP`,
      ).bind(session.user_id, locality, homeAddress,
        structuredAddress?.houseOrFlat ?? null, structuredAddress?.floor ?? null, structuredAddress?.buildingOrSociety ?? null,
        structuredAddress?.city ?? null, structuredAddress?.state ?? null, structuredAddress?.pinCode ?? null,
        point.latitude, point.longitude, Math.round(travelDistanceKm * 1_000), yearsExperience,
        Number(preserveAddress), Number(preserveAddress),
        ...Array(6).fill(Number(preserveAddress)),
        Number(preserveAddress), Number(omittedCoordinates), Number(preserveAddress), Number(omittedCoordinates)),
      scheduleWriteGuard(db, session.user_id, preserveSchedule, replaceSchedule),
      ...(preserveSchedule ? [] : saveAvailability(db, session.user_id, availability.flatMap(group => group.days.map(day => ({ day, start: group.start, end: group.end, pattern: group.pattern }))))),
      ...(updatingBusyPeriods ? saveBusyPeriods(db, session.user_id, busyPeriods) : []),
      ...(updateServices ? [
        db.prepare("UPDATE helper_offerings SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE helper_user_id = ? AND is_active = 1").bind(session.user_id),
      ] : []),
    ];
    for (const offering of updateServices ? offerings : []) {
      statements.push(db.prepare(
        `INSERT INTO helper_offerings (id, helper_user_id, service_type, home_size, monthly_price_paise, is_active)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(helper_user_id, service_type, home_size) DO UPDATE SET
           monthly_price_paise = excluded.monthly_price_paise, is_active = 1, updated_at = CURRENT_TIMESTAMP`,
      ).bind(crypto.randomUUID(), session.user_id, offering.serviceType, offering.homeSize, offering.monthlyPricePaise));
    }
    // Read the authoritative response state inside the save transaction. If
    // this read fails, the profile and audit roll back together; after commit
    // constructing the response needs no further database operation.
    statements.push(db.prepare("SELECT profile_status,verification_status FROM helper_profiles WHERE user_id = ?").bind(session.user_id));
    const results = await db.batch<{ profile_status: string; verification_status: string }>(statements);
    const saved = results[results.length - 1].results[0];
    return Response.json({ saved: true, profileStatus: saved.profile_status, verificationStatus: saved.verification_status, combinedPricesCalculated: true });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof Error && error.message.includes("integer overflow")) {
      return Response.json({ error: "Your account cannot save changes right now. Refresh and try again." }, { status: 409 });
    }
    if (error instanceof Error && error.message.includes("malformed JSON")) {
      if (updatingBusyPeriods) return fieldError("busyPeriods", "Keep busy periods inside working hours and clear of pending requests or live bookings.", 409);
      return fieldError("availability", "Keep pending and booked service times covered. Legacy schedules need explicit replacement confirmation; otherwise leave the schedule unchanged.", 409);
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
    const previousStatus = body.paused ? "active" : "paused";
    // Both the transition guard and its audit run inside the same transaction.
    // changes() belongs to the immediately preceding guarded UPDATE: a stale
    // transition cannot insert an audit record, and either write failing rolls
    // back the entire batch. RETURNING avoids a racy post-commit status read.
    const [transition] = await db.batch<{ profile_status: string }>([
      db.prepare(
        `UPDATE helper_profiles SET profile_status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND profile_status = ?
           AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')
         RETURNING profile_status`,
      ).bind(nextStatus, session.user_id, previousStatus, session.user_id),
      db.prepare(
        `INSERT INTO analytics_events (id, user_id, event_name, properties_json)
         SELECT ?, ?, 'helper_profile_status_changed', ? WHERE changes() = 1`,
      ).bind(crypto.randomUUID(), session.user_id, JSON.stringify({ profileStatus: nextStatus })),
    ]);
    if (!transition.results.length) return Response.json({ error: "Your profile status changed or cannot be edited. Refresh and try again." }, { status: 409 });
    return Response.json({ saved: true, profileStatus: nextStatus });
  } catch (error) {
    if (error instanceof Response) return error;
    return profileFailure("profile_status");
  }
}
