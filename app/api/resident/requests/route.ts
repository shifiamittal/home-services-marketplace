import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";
import { deriveBookingWorkflowState } from "../../../lib/booking-workflow";
import { sendPushToUser } from "../../../lib/push";
import { expirePendingRequests, insertSlotClaims, isUniqueConstraintError, transitionGuard } from "../../../lib/workflow-integrity";

type Service = "house_cleaning" | "utensils_once" | "utensils_twice" | "house_plus_utensils_once" | "house_plus_utensils_twice";
type HomeSize = "one_two_bhk" | "three_bhk" | "four_plus_bhk";
type SlotRow = { id: string; day_of_week: number; start_minute: number; end_minute: number };
type RequestedSlot = { visitOrdinal: number; dayOfWeek: number; start: number; end: number; includesHouseCleaning: boolean; availabilitySlotId: string };

const weekdays = [1, 2, 3, 4, 5, 6];

function minuteOfDay(value: unknown) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return -1;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatMinute(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function cleaningDuration(homeSize: HomeSize) {
  return homeSize === "one_two_bhk" ? 30 : homeSize === "three_bhk" ? 45 : 60;
}

function combinedDuration(homeSize: HomeSize) {
  return homeSize === "one_two_bhk" ? 60 : homeSize === "three_bhk" ? 75 : 90;
}

function packagePrice(offerings: Array<{ service_type: string; home_size: string; monthly_price_paise: number }>, service: Service, homeSize: HomeSize) {
  const price = (serviceType: string, size: string) => offerings.find(item => item.service_type === serviceType && item.home_size === size)?.monthly_price_paise;
  const house = price("house_cleaning", homeSize);
  const once = price("utensils_once", "not_applicable");
  const twice = price("utensils_twice", "not_applicable");
  if (service === "house_cleaning") return house ?? null;
  if (service === "utensils_once") return once ?? null;
  if (service === "utensils_twice") return twice ?? null;
  if (service === "house_plus_utensils_once") return house != null && once != null ? house + once : null;
  return house != null && twice != null ? house + twice : null;
}

function serviceLabel(service: Service) {
  if (service === "house_cleaning") return "house cleaning";
  if (service === "utensils_once") return "utensil cleaning once daily";
  if (service === "utensils_twice") return "utensil cleaning twice daily";
  if (service === "house_plus_utensils_once") return "house and utensil cleaning once daily";
  return "house and utensil cleaning twice daily";
}

async function requireResident(request: Request) {
  const session = await getSession(request);
  if (!session) throw Response.json({ error: "Sign in again to continue." }, { status: 401 });
  if (!session.roles.includes("resident")) throw Response.json({ error: "A resident account is required." }, { status: 403 });
  return session;
}

export async function GET(request: Request) {
  try {
    const session = await requireResident(request);
    const db = await getD1();
    await expirePendingRequests(db);
    const payment = await db.prepare(
      `SELECT tp.id, tp.amount_paise, tp.status, tp.transaction_reference, tp.resident_marked_paid_at,
              u.name AS helper_name, u.mobile_e164 AS helper_mobile
       FROM trial_payments tp JOIN users u ON u.id = tp.helper_user_id
       WHERE tp.resident_user_id = ? AND tp.status IN ('pending', 'resident_marked_paid', 'review_requested')
       ORDER BY tp.created_at DESC LIMIT 1`,
    ).bind(session.user_id).first<Record<string, string | number | null>>();
    const current = await db.prepare(
      `SELECT br.id, br.status, br.package_snapshot_json, br.monthly_price_paise, br.requested_start_date,
              br.response_due_at, br.responded_at, br.helper_user_id, u.name AS helper_name,
              b.id AS booking_id, b.status AS booking_status, b.trial_visits_allowed,
              b.trial_visits_completed, b.cycle_started_at, b.cycle_ends_at, u.mobile_e164 AS helper_mobile
       FROM booking_requests br
       JOIN users u ON u.id = br.helper_user_id
       LEFT JOIN bookings b ON b.request_id = br.id
       WHERE br.resident_user_id = ? AND br.status IN ('pending', 'accepted', 'declined', 'expired')
       ORDER BY br.created_at DESC LIMIT 1`,
    ).bind(session.user_id).first<Record<string, string | number | null>>();
    const paymentPending = payment ? {
      id: payment.id,
      amountRupees: Number(payment.amount_paise) / 100,
      status: payment.status,
      transactionReference: payment.transaction_reference,
      residentMarkedPaidAt: payment.resident_marked_paid_at,
      helperName: payment.helper_name,
      helperMobile: payment.helper_mobile,
    } : null;
    if (!current) return Response.json({
      workflowState: deriveBookingWorkflowState({ paymentStatus: payment ? String(payment.status) : null }),
      request: null,
      paymentPending,
    });
    const slots = await db.prepare(
      `SELECT visit_ordinal, MIN(start_minute) AS start_minute, MAX(end_minute) AS end_minute,
              MAX(includes_house_cleaning) AS includes_house_cleaning
       FROM request_slots WHERE request_id = ? GROUP BY visit_ordinal ORDER BY visit_ordinal`,
    ).bind(current.id).all<{ visit_ordinal: number; start_minute: number; end_minute: number; includes_house_cleaning: number }>();
    const trialDays = current.booking_id ? await db.prepare(
      `SELECT trial_ordinal, MIN(scheduled_for) AS scheduled_for,
              CASE WHEN MIN(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) = 1 THEN 'completed' ELSE 'scheduled' END AS status
       FROM service_visits WHERE booking_id = ? AND trial_ordinal IS NOT NULL
       GROUP BY trial_ordinal ORDER BY trial_ordinal`,
    ).bind(current.booking_id).all<{ trial_ordinal: number; scheduled_for: string; status: string }>() : { results: [] };
    const workflowState = deriveBookingWorkflowState({
      requestStatus: String(current.status),
      bookingStatus: current.booking_status ? String(current.booking_status) : null,
      paymentStatus: payment ? String(payment.status) : null,
    });
    return Response.json({ workflowState, paymentPending, request: {
      id: current.id,
      status: current.status,
      helperId: current.helper_user_id,
      helperName: current.helper_name,
      helperMobile: current.status === "accepted" ? current.helper_mobile : null,
      package: JSON.parse(String(current.package_snapshot_json)),
      monthlyPriceRupees: Number(current.monthly_price_paise) / 100,
      requestedStartDate: current.requested_start_date,
      responseDueAt: current.response_due_at,
      respondedAt: current.responded_at,
      bookingId: current.booking_id,
      bookingStatus: current.booking_status,
      workflowState,
      trialVisitsAllowed: current.trial_visits_allowed,
      trialVisitsCompleted: current.trial_visits_completed,
      cycleStartedAt: current.cycle_started_at,
      cycleEndsAt: current.cycle_ends_at,
      canCancelNow: current.booking_status === "trial" && Number(current.trial_visits_completed) < 2
        || current.booking_status === "active" && new Date(String(current.cycle_ends_at)).getTime() <= Date.now(),
      trialDays: trialDays.results.map(day => ({ ordinal: day.trial_ordinal, scheduledFor: day.scheduled_for, status: day.status })),
      slots: slots.results.map(slot => ({
        visitOrdinal: slot.visit_ordinal,
        startTime: formatMinute(slot.start_minute),
        endTime: formatMinute(slot.end_minute),
        includesHouseCleaning: Boolean(slot.includes_house_cleaning),
      })),
    } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not load your current request." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireResident(request);
    const body = await request.json() as Record<string, unknown>;
    const helperId = typeof body.helperId === "string" ? body.helperId : "";
    const service = body.service as Service;
    const homeSize = body.homeSize as HomeSize;
    const firstStart = minuteOfDay(body.firstTime);
    const secondStart = minuteOfDay(body.secondTime);
    const cleaningVisit = body.cleaningVisit === "second" ? "second" : "first";
    const requestedStartDate = typeof body.requestedStartDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.requestedStartDate) ? body.requestedStartDate : "";
    const validService = ["house_cleaning", "utensils_once", "utensils_twice", "house_plus_utensils_once", "house_plus_utensils_twice"].includes(service);
    if (!helperId || !validService || !["one_two_bhk", "three_bhk", "four_plus_bhk"].includes(homeSize) || firstStart < 0 || !requestedStartDate
      || (service.endsWith("twice") && secondStart < 0)) {
      return Response.json({ error: "Review the selected helper, service, times and start date." }, { status: 400 });
    }
    const startDate = new Date(`${requestedStartDate}T00:00:00Z`);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (Number.isNaN(startDate.getTime()) || startDate < today || startDate.getUTCDay() === 0) {
      return Response.json({ error: "Choose a Monday–Saturday start date that is not in the past." }, { status: 400 });
    }

    const db = await getD1();
    await expirePendingRequests(db);
    const unpaidTrial = await db.prepare(
      `SELECT id FROM trial_payments WHERE resident_user_id = ?
       AND status IN ('pending', 'resident_marked_paid') LIMIT 1`,
    ).bind(session.user_id).first<{ id: string }>();
    if (unpaidTrial) return Response.json({ error: "Confirm payment for completed trial work before sending another booking request." }, { status: 409 });
    const existing = await db.prepare(
      `SELECT br.id FROM booking_requests br LEFT JOIN bookings b ON b.request_id = br.id
       WHERE br.resident_user_id = ? AND (br.status = 'pending' OR b.status IN ('trial', 'active', 'ending')) LIMIT 1`,
    ).bind(session.user_id).first<{ id: string }>();
    if (existing) return Response.json({ error: "You already have a pending request or active booking." }, { status: 409 });

    const address = await db.prepare(
      "SELECT id FROM resident_addresses WHERE resident_user_id = ? AND is_primary = 1 LIMIT 1",
    ).bind(session.user_id).first<{ id: string }>();
    if (!address) return Response.json({ error: "Add your home address before requesting a booking." }, { status: 400 });
    const helper = await db.prepare(
      `SELECT hp.user_id, u.name, u.mobile_e164 FROM helper_profiles hp JOIN users u ON u.id = hp.user_id
       WHERE hp.user_id = ? AND hp.profile_status = 'active' LIMIT 1`,
    ).bind(helperId).first<{ user_id: string; name: string; mobile_e164: string }>();
    if (!helper) return Response.json({ error: "This helper’s profile is not currently available." }, { status: 409 });
    const offerings = await db.prepare(
      "SELECT service_type, home_size, monthly_price_paise FROM helper_offerings WHERE helper_user_id = ? AND is_active = 1",
    ).bind(helperId).all<{ service_type: string; home_size: string; monthly_price_paise: number }>();
    const monthlyPricePaise = packagePrice(offerings.results, service, homeSize);
    if (monthlyPricePaise == null) return Response.json({ error: "This package is no longer offered by the selected helper." }, { status: 409 });

    const firstDuration = service === "house_cleaning" ? cleaningDuration(homeSize)
      : service === "house_plus_utensils_once" ? combinedDuration(homeSize)
        : service === "house_plus_utensils_twice" && cleaningVisit === "first" ? combinedDuration(homeSize) : 30;
    const needsSecond = service === "utensils_twice" || service === "house_plus_utensils_twice";
    const secondDuration = service === "house_plus_utensils_twice" && cleaningVisit === "second" ? combinedDuration(homeSize) : 30;
    const availability = await db.prepare(
      `SELECT id, day_of_week, start_minute, end_minute FROM availability_slots
       WHERE helper_user_id = ? AND status = 'open'`,
    ).bind(helperId).all<SlotRow>();
    const requestedSlots: RequestedSlot[] = [];
    for (const day of weekdays) {
      const firstAvailability = availability.results.find(slot => slot.day_of_week === day && slot.start_minute <= firstStart && slot.end_minute >= firstStart + firstDuration);
      if (!firstAvailability) return Response.json({ error: "The selected time is no longer available. Refresh your matches." }, { status: 409 });
      requestedSlots.push({ visitOrdinal: 1, dayOfWeek: day, start: firstStart, end: firstStart + firstDuration, includesHouseCleaning: service.includes("house") && cleaningVisit === "first", availabilitySlotId: firstAvailability.id });
      if (needsSecond) {
        const secondAvailability = availability.results.find(slot => slot.day_of_week === day && slot.start_minute <= secondStart && slot.end_minute >= secondStart + secondDuration);
        if (!secondAvailability) return Response.json({ error: "The selected second time is no longer available. Refresh your matches." }, { status: 409 });
        requestedSlots.push({ visitOrdinal: 2, dayOfWeek: day, start: secondStart, end: secondStart + secondDuration, includesHouseCleaning: service.includes("house") && cleaningVisit === "second", availabilitySlotId: secondAvailability.id });
      }
    }

    const busy = await db.prepare(
      `SELECT rs.day_of_week, rs.start_minute, rs.end_minute
       FROM request_slots rs JOIN booking_requests br ON br.id = rs.request_id
       WHERE br.helper_user_id = ? AND br.status = 'pending' AND br.response_due_at > CURRENT_TIMESTAMP
       UNION ALL
       SELECT bs.day_of_week, bs.start_minute, bs.end_minute
       FROM booking_slots bs JOIN bookings b ON b.id = bs.booking_id
       WHERE b.helper_user_id = ? AND b.status IN ('trial', 'active', 'ending')`,
    ).bind(helperId, helperId).all<{ day_of_week: number; start_minute: number; end_minute: number }>();
    const overlaps = requestedSlots.some(slot => busy.results.some(item => item.day_of_week === slot.dayOfWeek
      && slot.start < item.end_minute + 15 && item.start_minute < slot.end + 15));
    if (overlaps) return Response.json({ error: "Another resident has just held this time. Please choose another match." }, { status: 409 });

    const requestId = crypto.randomUUID();
    const responseDueAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    const snapshot = { service, homeSize, cleaningVisit, firstDuration, secondDuration: needsSecond ? secondDuration : null };
    const statements = [
      db.prepare(
        `INSERT INTO booking_requests
         (id, resident_user_id, helper_user_id, resident_address_id, package_snapshot_json, monthly_price_paise, requested_start_date, status, response_due_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).bind(requestId, session.user_id, helperId, address.id, JSON.stringify(snapshot), monthlyPricePaise, requestedStartDate, responseDueAt),
      insertSlotClaims(db, helperId, requestId, requestedSlots.map(slot => ({
        dayOfWeek: slot.dayOfWeek,
        start: slot.start,
        end: slot.end,
      }))),
    ];
    for (const slot of requestedSlots) {
      statements.push(db.prepare(
        `INSERT INTO request_slots
         (id, request_id, availability_slot_id, visit_ordinal, day_of_week, start_minute, end_minute, includes_house_cleaning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), requestId, slot.availabilitySlotId, slot.visitOrdinal, slot.dayOfWeek, slot.start, slot.end, slot.includesHouseCleaning ? 1 : 0));
    }
    statements.push(
      db.prepare("INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'booking_request_created', ?)")
        .bind(crypto.randomUUID(), session.user_id, JSON.stringify({ requestId, helperId, service, responseDueAt })),
      db.prepare(
        `INSERT INTO notification_log
          (id, user_id, channel, template_key, title, body, action_view, related_entity_type, related_entity_id, dedupe_key, status)
          VALUES (?, ?, 'in_app', 'new_booking_request', 'New booking request', ?, 'incoming', 'booking_request', ?, ?, 'delivered')`,
      ).bind(
        crypto.randomUUID(),
        helperId,
        `${session.name} requested ${serviceLabel(service)} at ${needsSecond ? `${formatMinute(firstStart)} and ${formatMinute(secondStart)}` : formatMinute(firstStart)}. Respond within 24 hours.`,
        requestId,
        `new-booking-request:${requestId}:${helperId}`,
      ),
    );
    await db.batch(statements);
    await sendPushToUser(db, helperId, {
      title: "New booking request",
      body: `${session.name} requested ${serviceLabel(service)}. Respond within 24 hours.`,
      url: "/",
      tag: `booking-request-${requestId}`,
    });
    return Response.json({ requestId, responseDueAt, status: "pending" });
  } catch (error) {
    if (error instanceof Response) return error;
    if (isUniqueConstraintError(error)) {
      return Response.json({ error: "This time was just booked by someone else. Please choose another match." }, { status: 409 });
    }
    if (error instanceof Error && error.message.includes("travel buffer")) {
      return Response.json({ error: "The selected times overlap after the required travel buffer." }, { status: 400 });
    }
    return Response.json({ error: "We could not create the booking request. Please try again." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireResident(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const db = await getD1();
    const pending = await db.prepare(
      "SELECT id FROM booking_requests WHERE id = ? AND resident_user_id = ? AND status = 'pending' LIMIT 1",
    ).bind(requestId, session.user_id).first<{ id: string }>();
    if (!pending) return Response.json({ error: "This request can no longer be withdrawn." }, { status: 409 });
    try {
      await db.batch([
        transitionGuard(db, "booking_request", requestId, "pending", "withdrawn", session.user_id),
        db.prepare(
          `UPDATE booking_requests SET status = 'withdrawn', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND resident_user_id = ? AND status = 'pending'`,
        ).bind(requestId, session.user_id),
        db.prepare("DELETE FROM slot_claims WHERE request_id = ? AND booking_id IS NULL").bind(requestId),
        db.prepare("INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'booking_request_withdrawn', ?)")
          .bind(crypto.randomUUID(), session.user_id, JSON.stringify({ requestId })),
      ]);
    } catch (error) {
      if (isUniqueConstraintError(error)) return Response.json({ error: "This request can no longer be withdrawn." }, { status: 409 });
      throw error;
    }
    return Response.json({ withdrawn: true });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not withdraw the request." }, { status: 500 });
  }
}
