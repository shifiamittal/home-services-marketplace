import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";
import { deriveBookingWorkflowState } from "../../../lib/booking-workflow";
import { sendPushToUser } from "../../../lib/push";
import { serviceCompletionAvailableAt } from "../../../lib/service-time";
import { ELIGIBLE_HELPER_SQL, deadlineInstant, expirePendingRequests, isUniqueConstraintError, transitionGuard } from "../../../lib/workflow-integrity";

function formatMinute(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function packageLabel(service: unknown) {
  if (service === "house_cleaning") return "house cleaning";
  if (service === "utensils_once") return "utensil cleaning once daily";
  if (service === "utensils_twice") return "utensil cleaning twice daily";
  if (service === "house_plus_utensils_once") return "house and utensil cleaning once daily";
  return "house and utensil cleaning twice daily";
}

function trialServiceDates(startDate: string) {
  const dates: string[] = [];
  const date = new Date(`${startDate}T00:00:00.000Z`);
  while (dates.length < 2) {
    if (date.getUTCDay() !== 0) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

async function requireHelper(request: Request) {
  const session = await getSession(request);
  if (!session) throw Response.json({ error: "Sign in again to continue." }, { status: 401 });
  if (!session.roles.includes("provider")) throw Response.json({ error: "A home helper account is required." }, { status: 403 });
  return session;
}

async function requestDetails(db: D1Database, requestId: string, helperId: string, revealContact: boolean, requireEligible = false) {
  const item = await db.prepare(
    `SELECT br.id, br.status, br.resident_user_id, br.helper_user_id, br.package_snapshot_json,
            br.monthly_price_paise, br.requested_start_date, br.response_due_at, br.responded_at,
            u.name AS resident_name, u.mobile_e164 AS resident_mobile,
            ra.house_or_flat, ra.street_or_block, ra.locality,
            b.id AS booking_id, b.status AS booking_status, b.trial_visits_allowed,
            b.trial_visits_completed, b.cycle_started_at, b.cycle_ends_at
     FROM booking_requests br
     JOIN users u ON u.id = br.resident_user_id
     JOIN resident_addresses ra ON ra.id = br.resident_address_id
     LEFT JOIN bookings b ON b.request_id = br.id
     WHERE br.id = ? AND br.helper_user_id = ? AND ra.resident_user_id = br.resident_user_id
       AND (NOT ? OR EXISTS (SELECT 1 FROM helper_profiles hp JOIN users u ON u.id = hp.user_id
         WHERE hp.user_id = br.helper_user_id AND ${ELIGIBLE_HELPER_SQL})) LIMIT 1`,
  ).bind(requestId, helperId, requireEligible ? 1 : 0).first<Record<string, string | number | null>>();
  if (!item) return null;
  revealContact = revealContact && item.status === "accepted" && Boolean(item.booking_id);
  const slots = await db.prepare(
    `SELECT visit_ordinal, MIN(start_minute) AS start_minute, MAX(end_minute) AS end_minute,
            MAX(includes_house_cleaning) AS includes_house_cleaning
     FROM request_slots WHERE request_id = ? GROUP BY visit_ordinal ORDER BY visit_ordinal`,
  ).bind(requestId).all<{ visit_ordinal: number; start_minute: number; end_minute: number; includes_house_cleaning: number }>();
  if (item.booking_id && item.booking_status === "trial") {
    const existingVisit = await db.prepare("SELECT id FROM service_visits WHERE booking_id = ? LIMIT 1").bind(item.booking_id).first<{ id: string }>();
    if (!existingVisit) {
      const bookedSlots = await db.prepare(
        "SELECT id, day_of_week, start_minute FROM booking_slots WHERE booking_id = ? ORDER BY day_of_week, visit_ordinal",
      ).bind(item.booking_id).all<{ id: string; day_of_week: number; start_minute: number }>();
      const visitStatements = [];
      for (const [trialIndex, serviceDate] of trialServiceDates(String(item.requested_start_date)).entries()) {
        const dayOfWeek = new Date(`${serviceDate}T00:00:00.000Z`).getUTCDay();
        for (const slot of bookedSlots.results.filter(candidate => candidate.day_of_week === dayOfWeek)) {
          const scheduledFor = new Date(`${serviceDate}T00:00:00.000Z`);
          scheduledFor.setUTCMinutes(slot.start_minute);
          visitStatements.push(db.prepare(
            `INSERT INTO service_visits (id, booking_id, booking_slot_id, scheduled_for, trial_ordinal, status)
             VALUES (?, ?, ?, ?, ?, 'scheduled')`,
          ).bind(crypto.randomUUID(), item.booking_id, slot.id, scheduledFor.toISOString(), trialIndex + 1));
        }
      }
      if (visitStatements.length) await db.batch(visitStatements);
    }
  }
  const trialDays = item.booking_id ? await db.prepare(
    `SELECT sv.trial_ordinal, MIN(sv.scheduled_for) AS scheduled_for, MAX(bs.end_minute) AS final_end_minute,
            CASE WHEN MIN(CASE WHEN sv.status = 'completed' THEN 1 ELSE 0 END) = 1 THEN 'completed' ELSE 'scheduled' END AS status
     FROM service_visits sv JOIN booking_slots bs ON bs.id = sv.booking_slot_id
     WHERE sv.booking_id = ? AND sv.trial_ordinal IS NOT NULL
     GROUP BY sv.trial_ordinal ORDER BY sv.trial_ordinal`,
  ).bind(item.booking_id).all<{ trial_ordinal: number; scheduled_for: string; final_end_minute: number; status: string }>() : { results: [] };
  const workflowState = deriveBookingWorkflowState({
    requestStatus: String(item.status),
    bookingStatus: item.booking_status ? String(item.booking_status) : null,
  });
  return {
    id: item.id,
    status: item.status,
    residentId: item.resident_user_id,
    residentName: item.resident_name,
    residentMobile: revealContact ? item.resident_mobile : null,
    // Legacy locality is untrusted free text and may be a complete address.
    residentLocality: revealContact ? item.locality : null,
    residentAddress: revealContact ? `${item.house_or_flat}, ${item.street_or_block || item.locality}` : null,
    package: JSON.parse(String(item.package_snapshot_json)),
    monthlyPriceRupees: Number(item.monthly_price_paise) / 100,
    requestedStartDate: item.requested_start_date,
    responseDueAt: item.response_due_at,
    respondedAt: item.responded_at,
    bookingId: item.booking_id,
    bookingStatus: item.booking_status,
    workflowState,
    trialVisitsAllowed: item.trial_visits_allowed,
    trialVisitsCompleted: item.trial_visits_completed,
    cycleStartedAt: item.cycle_started_at,
    cycleEndsAt: item.cycle_ends_at,
    canCancelNow: item.booking_status === "trial" && Number(item.trial_visits_completed) < 2
      || item.booking_status === "active" && new Date(String(item.cycle_ends_at)).getTime() <= Date.now(),
    trialDays: trialDays.results.map(day => ({
      ordinal: day.trial_ordinal,
      scheduledFor: day.scheduled_for,
      completionAvailableAt: serviceCompletionAvailableAt(day.scheduled_for, day.final_end_minute),
      status: day.status,
    })),
    slots: slots.results.map(slot => ({
      visitOrdinal: slot.visit_ordinal,
      startTime: formatMinute(slot.start_minute),
      endTime: formatMinute(slot.end_minute),
      includesHouseCleaning: Boolean(slot.includes_house_cleaning),
    })),
  };
}

export async function GET(request: Request) {
  try {
    const session = await requireHelper(request);
    const db = await getD1();
    await expirePendingRequests(db);
    const pending = await db.prepare(
      `SELECT id FROM booking_requests
       WHERE helper_user_id = ? AND status = 'pending' AND COALESCE(${deadlineInstant("response_due_at")} > julianday('now'), 0)
       ORDER BY ${deadlineInstant("response_due_at")} ASC, id LIMIT 1`,
    ).bind(session.user_id).first<{ id: string }>();
    const active = await db.prepare(
      `SELECT br.id FROM booking_requests br JOIN bookings b ON b.request_id = br.id
       WHERE br.helper_user_id = ? AND b.status IN ('trial', 'active', 'ending')
       ORDER BY b.created_at DESC`,
    ).bind(session.user_id).all<{ id: string }>();
    const activeBookings = await Promise.all(active.results.map(item => requestDetails(db, item.id, session.user_id, true)));
    const payment = await db.prepare(
      `SELECT tp.id, tp.amount_paise, tp.status, tp.transaction_reference, tp.resident_marked_paid_at,
              u.name AS resident_name
       FROM trial_payments tp JOIN users u ON u.id = tp.resident_user_id
       WHERE tp.helper_user_id = ? AND tp.status IN ('pending', 'resident_marked_paid', 'review_requested')
       ORDER BY tp.created_at DESC LIMIT 1`,
    ).bind(session.user_id).first<Record<string, string | number | null>>();
    return Response.json({
      pendingRequest: pending ? await requestDetails(db, pending.id, session.user_id, false) : null,
      activeBooking: activeBookings[0] ?? null,
      activeBookings: activeBookings.filter(Boolean),
      paymentPending: payment ? {
        id: payment.id,
        amountRupees: Number(payment.amount_paise) / 100,
        status: payment.status,
        transactionReference: payment.transaction_reference,
        residentMarkedPaidAt: payment.resident_marked_paid_at,
        residentName: payment.resident_name,
      } : null,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not load your booking requests." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await requireHelper(request);
    const body = await request.json() as Record<string, unknown>;
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const decision = body.decision === "accept" ? "accept" : body.decision === "decline" ? "decline" : "";
    if (!requestId || !decision) return Response.json({ error: "Choose accept or decline." }, { status: 400 });
    const db = await getD1();
    await expirePendingRequests(db);
    const item = await db.prepare(
      `SELECT br.id, br.resident_user_id, br.status, br.response_due_at, br.package_snapshot_json,
              br.requested_start_date, u.name AS resident_name, u.mobile_e164 AS resident_mobile,
              COALESCE(${deadlineInstant("br.response_due_at")} > julianday('now'), 0) AS deadline_live
       FROM booking_requests br JOIN users u ON u.id = br.resident_user_id
       WHERE br.id = ? AND br.helper_user_id = ? LIMIT 1`,
    ).bind(requestId, session.user_id).first<{ id: string; resident_user_id: string; status: string; response_due_at: string; package_snapshot_json: string; requested_start_date: string; resident_name: string; resident_mobile: string; deadline_live: number }>();
    if (!item || item.status !== "pending" || item.deadline_live !== 1) {
      return Response.json({ error: "This request is no longer awaiting a response." }, { status: 409 });
    }

    // Deadline and ownership are checked again at mutation time, not using
    // the JS parse of a possibly zone-less timestamp or a stale pre-read.
    const responseGuard = () => db.prepare(`SELECT json(CASE WHEN EXISTS (
      SELECT 1 FROM booking_requests br WHERE br.id = ? AND br.helper_user_id = ?
        AND br.resident_user_id = ? AND br.status = 'pending'
        AND COALESCE(${deadlineInstant("br.response_due_at")} > julianday('now'), 0)
    ) THEN 'true' ELSE 'request_response_conflict' END)`).bind(requestId, session.user_id, item.resident_user_id);

    if (decision === "decline") {
      const snapshot = JSON.parse(item.package_snapshot_json) as { service?: string };
      try {
        await db.batch([
        responseGuard(),
        transitionGuard(db, "booking_request", requestId, "pending", "declined", session.user_id),
        db.prepare("UPDATE booking_requests SET status = 'declined', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND helper_user_id = ? AND status = 'pending'")
          .bind(requestId, session.user_id),
        db.prepare("DELETE FROM slot_claims WHERE request_id = ? AND booking_id IS NULL").bind(requestId),
        db.prepare("INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'booking_request_declined', ?)")
          .bind(crypto.randomUUID(), session.user_id, JSON.stringify({ requestId })),
        db.prepare(
          `INSERT INTO notification_log
           (id, user_id, channel, template_key, title, body, action_view, related_entity_type, related_entity_id, dedupe_key, status)
           VALUES (?, ?, 'in_app', 'booking_request_declined', 'Choose another home helper', ?, 'requirement', 'booking_request', ?, ?, 'delivered')`,
        ).bind(
          crypto.randomUUID(),
          item.resident_user_id,
          `${session.name} was unavailable for your ${packageLabel(snapshot.service)} request. Your held time is available again.`,
          requestId,
          `booking-request-declined:${requestId}:${item.resident_user_id}`,
        ),
        ]);
      } catch (error) {
        if (isUniqueConstraintError(error)) return Response.json({ error: "This request is no longer awaiting a response." }, { status: 409 });
        throw error;
      }
      await sendPushToUser(db, item.resident_user_id, {
        title: "Choose another home helper",
        body: `${session.name} was unavailable for your request.`,
        url: "/",
        tag: `booking-declined-${requestId}`,
      });
      return Response.json({ status: "declined" });
    }

    const existingBooking = await db.prepare("SELECT id FROM bookings WHERE request_id = ? LIMIT 1").bind(requestId).first<{ id: string }>();
    if (existingBooking) return Response.json({ error: "This request has already been booked." }, { status: 409 });
    const bookingId = crypto.randomUUID();
    const cycleStartedAt = new Date(`${item.requested_start_date}T00:00:00.000Z`).toISOString();
    const cycleEndsAt = new Date(new Date(cycleStartedAt).getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString();
    const slots = await db.prepare(
      `SELECT availability_slot_id, visit_ordinal, day_of_week, start_minute, end_minute
       FROM request_slots WHERE request_id = ? ORDER BY day_of_week, visit_ordinal`,
    ).bind(requestId).all<{ availability_slot_id: string; visit_ordinal: number; day_of_week: number; start_minute: number; end_minute: number }>();
    if (!slots.results.length) return Response.json({ error: "The held time could not be found." }, { status: 409 });
    const statements = [
      responseGuard(),
      // Authorize the assigned helper inside the same atomic batch, before any
      // transition, booking, history or claim mutation. A pre-read is not authority.
      db.prepare(`SELECT json(CASE WHEN EXISTS (
        SELECT 1 FROM booking_requests br
        JOIN helper_profiles hp ON hp.user_id = br.helper_user_id
        JOIN users u ON u.id = hp.user_id
        WHERE br.id = ? AND br.helper_user_id = ? AND ${ELIGIBLE_HELPER_SQL}
      ) THEN 'true' ELSE 'request_response_conflict' END)`).bind(requestId, session.user_id),
      db.prepare(`SELECT json(CASE WHEN EXISTS (
        SELECT 1 FROM bookings WHERE resident_user_id = ? AND status IN ('trial', 'active', 'ending')
      ) OR EXISTS (
        SELECT 1 FROM booking_requests WHERE resident_user_id = ? AND id != ? AND status = 'pending'
      ) THEN 'resident_lifecycle_conflict' ELSE 'true' END)`).bind(item.resident_user_id, item.resident_user_id, requestId),
      transitionGuard(db, "booking_request", requestId, "pending", "accepted", session.user_id),
      db.prepare("UPDATE booking_requests SET status = 'accepted', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND helper_user_id = ? AND status = 'pending'")
        .bind(requestId, session.user_id),
      db.prepare(
        `INSERT INTO bookings
         (id, request_id, resident_user_id, helper_user_id, status, trial_visits_allowed, trial_visits_completed, cycle_started_at, cycle_ends_at, renewal_enabled)
         VALUES (?, ?, ?, ?, 'trial', 2, 0, ?, ?, 0)`,
      ).bind(bookingId, requestId, item.resident_user_id, session.user_id, cycleStartedAt, cycleEndsAt),
      db.prepare("INSERT INTO booking_status_history (id, booking_id, from_status, to_status, actor_user_id, reason) VALUES (?, ?, NULL, 'trial', ?, 'helper_accepted_request')")
        .bind(crypto.randomUUID(), bookingId, session.user_id),
      db.prepare("UPDATE slot_claims SET booking_id = ? WHERE request_id = ? AND booking_id IS NULL")
        .bind(bookingId, requestId),
    ];
    const bookedSlots: Array<{ id: string; dayOfWeek: number; visitOrdinal: number; startMinute: number }> = [];
    for (const slot of slots.results) {
      const bookingSlotId = crypto.randomUUID();
      bookedSlots.push({ id: bookingSlotId, dayOfWeek: slot.day_of_week, visitOrdinal: slot.visit_ordinal, startMinute: slot.start_minute });
      statements.push(db.prepare(
        `INSERT INTO booking_slots
         (id, booking_id, availability_slot_id, visit_ordinal, day_of_week, start_minute, end_minute)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(bookingSlotId, bookingId, slot.availability_slot_id, slot.visit_ordinal, slot.day_of_week, slot.start_minute, slot.end_minute));
    }
    for (const [trialIndex, serviceDate] of trialServiceDates(item.requested_start_date).entries()) {
      const dayOfWeek = new Date(`${serviceDate}T00:00:00.000Z`).getUTCDay();
      for (const slot of bookedSlots.filter(candidate => candidate.dayOfWeek === dayOfWeek)) {
        const scheduledFor = new Date(`${serviceDate}T00:00:00.000Z`);
        scheduledFor.setUTCMinutes(slot.startMinute);
        statements.push(db.prepare(
          `INSERT INTO service_visits (id, booking_id, booking_slot_id, scheduled_for, trial_ordinal, status)
           VALUES (?, ?, ?, ?, ?, 'scheduled')`,
        ).bind(crypto.randomUUID(), bookingId, slot.id, scheduledFor.toISOString(), trialIndex + 1));
      }
    }
    statements.push(
      db.prepare("INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'booking_request_accepted', ?)")
        .bind(crypto.randomUUID(), session.user_id, JSON.stringify({ requestId, bookingId })),
      db.prepare(
        `INSERT INTO notification_log
          (id, user_id, channel, template_key, title, body, action_view, related_entity_type, related_entity_id, dedupe_key, status)
          VALUES (?, ?, 'in_app', 'booking_confirmed', 'Booking confirmed', ?, 'confirmed', 'booking', ?, ?, 'delivered')`,
      ).bind(
        crypto.randomUUID(),
        item.resident_user_id,
        `${session.name} accepted your ${packageLabel((JSON.parse(item.package_snapshot_json) as { service?: string }).service)} request. Your recurring time is now booked.`,
        bookingId,
        `booking-confirmed:${bookingId}:${item.resident_user_id}`,
      ),
    );
    try {
      await db.batch(statements);
    } catch (error) {
      if (isUniqueConstraintError(error)) return Response.json({ error: "This request is no longer awaiting a response." }, { status: 409 });
      throw error;
    }
    await sendPushToUser(db, item.resident_user_id, {
      title: "Booking confirmed",
      body: `${session.name} accepted your request. Your recurring time is now booked.`,
      url: "/",
      tag: `booking-confirmed-${bookingId}`,
    });
    const acceptedRequest = await requestDetails(db, requestId, session.user_id, true, true);
    return Response.json({ status: "accepted", bookingId, cycleEndsAt, request: acceptedRequest });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof Error && error.message.includes("malformed JSON")) {
      return Response.json({ error: "This request is no longer awaiting a response." }, { status: 409 });
    }
    return Response.json({ error: "We could not save your response. Please try again." }, { status: 500 });
  }
}
