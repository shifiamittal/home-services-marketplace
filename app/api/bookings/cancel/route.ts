import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";
import { sendPushToUser } from "../../../lib/push";
import { allocateIssueStatements } from "../../../lib/issues";
import { isUniqueConstraintError, transitionGuard } from "../../../lib/workflow-integrity";

const residentReasons = new Set([
  "Helper did not arrive",
  "Timing did not work",
  "Not satisfied with service",
  "Safety or misconduct",
  "Something else",
]);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in again to continue." }, { status: 401 });
    const body = await request.json() as Record<string, unknown>;
    const bookingId = typeof body.bookingId === "string" ? body.bookingId : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const feedback = typeof body.feedback === "string" ? body.feedback.trim().slice(0, 1000) : "";
    if (!bookingId || !reason) return Response.json({ error: "Choose a cancellation reason." }, { status: 400 });

    const db = await getD1();
    const booking = await db.prepare(
      `SELECT b.id, b.status, b.resident_user_id, b.helper_user_id, b.trial_visits_completed,
              b.cycle_ends_at, br.monthly_price_paise, ru.name AS resident_name,
              hu.name AS helper_name, hu.mobile_e164 AS helper_mobile
       FROM bookings b JOIN booking_requests br ON br.id = b.request_id
       JOIN users ru ON ru.id = b.resident_user_id JOIN users hu ON hu.id = b.helper_user_id
       WHERE b.id = ? LIMIT 1`,
    ).bind(bookingId).first<{ id: string; status: string; resident_user_id: string; helper_user_id: string; trial_visits_completed: number; cycle_ends_at: string; monthly_price_paise: number; resident_name: string; helper_name: string; helper_mobile: string }>();
    if (!booking || (session.user_id !== booking.resident_user_id && session.user_id !== booking.helper_user_id)) {
      return Response.json({ error: "This booking was not found." }, { status: 404 });
    }
    const isResident = session.user_id === booking.resident_user_id;
    if (isResident && !residentReasons.has(reason)) return Response.json({ error: "Choose one of the available reasons." }, { status: 400 });
    if (!["trial", "active"].includes(booking.status)) return Response.json({ error: "This booking is no longer active." }, { status: 409 });

    const duringTrial = booking.status === "trial" && booking.trial_visits_completed < 2;
    const afterCycle = Date.now() >= new Date(booking.cycle_ends_at).getTime();
    if (!duringTrial && !afterCycle) {
      return Response.json({
        error: `Cancellation becomes available again after ${new Date(booking.cycle_ends_at).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}.`,
      }, { status: 409 });
    }

    const amountPaise = duringTrial && booking.trial_visits_completed > 0
      ? Math.round((booking.monthly_price_paise / 26) * booking.trial_visits_completed)
      : 0;
    const otherUserId = isResident ? booking.helper_user_id : booking.resident_user_id;
    const otherName = isResident ? booking.helper_name : booking.resident_name;
    const statements = [
      transitionGuard(db, "booking", booking.id, `${booking.status}:${booking.trial_visits_completed}`, "cancelled", session.user_id),
      db.prepare("UPDATE bookings SET status = 'cancelled', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ? AND trial_visits_completed = ?")
        .bind(booking.id, booking.status, booking.trial_visits_completed),
      db.prepare("UPDATE service_visits SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND status = 'scheduled'")
        .bind(booking.id),
      db.prepare("DELETE FROM slot_claims WHERE booking_id = ?").bind(booking.id),
      db.prepare("INSERT INTO booking_cancellations (id, booking_id, actor_user_id, phase, reason, feedback) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), booking.id, session.user_id, duringTrial ? "trial" : "post_cycle", reason, feedback || null),
      db.prepare("INSERT INTO booking_status_history (id, booking_id, from_status, to_status, actor_user_id, reason) VALUES (?, ?, ?, 'cancelled', ?, ?)")
        .bind(crypto.randomUUID(), booking.id, booking.status, session.user_id, reason),
      db.prepare("INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'booking_cancelled', ?)")
        .bind(crypto.randomUUID(), session.user_id, JSON.stringify({ bookingId, phase: duringTrial ? "trial" : "post_cycle", reason, completedTrialDays: booking.trial_visits_completed })),
      db.prepare(
        `INSERT INTO notification_log
         (id, user_id, channel, template_key, title, body, action_view, related_entity_type, related_entity_id, dedupe_key, status)
         VALUES (?, ?, 'in_app', 'booking_cancelled', 'Booking cancelled', ?, ?, 'booking', ?, ?, 'delivered')`,
      ).bind(crypto.randomUUID(), otherUserId, `${session.name} cancelled the booking. The recurring time is now available.`, isResident ? "providerDashboard" : "requirement", booking.id, `booking-cancelled:${booking.id}:${otherUserId}`),
    ];
    const paymentId = amountPaise > 0 ? crypto.randomUUID() : null;
    if (paymentId) {
      statements.push(db.prepare(
        `INSERT INTO trial_payments (id, booking_id, resident_user_id, helper_user_id, amount_paise, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
      ).bind(paymentId, booking.id, booking.resident_user_id, booking.helper_user_id, amountPaise));
    }
    if (reason === "Safety or misconduct") {
      statements.push(...allocateIssueStatements(db, {
        id: crypto.randomUUID(),
        bookingId: booking.id,
        reporterUserId: session.user_id,
        reportedUserId: otherUserId,
        category: "Safety or misconduct",
        description: feedback || null,
      }));
    }
    try {
      await db.batch(statements);
    } catch (error) {
      if (isUniqueConstraintError(error)) return Response.json({ error: "This booking has already changed. Refresh and try again." }, { status: 409 });
      throw error;
    }
    await sendPushToUser(db, otherUserId, {
      title: "Booking cancelled",
      body: `${session.name} cancelled the booking. The recurring time is now available.`,
      url: "/",
      tag: `booking-cancelled-${booking.id}`,
    });
    return Response.json({
      cancelled: true,
      paymentDueRupees: amountPaise / 100,
      paymentPending: paymentId ? {
        id: paymentId,
        amountRupees: amountPaise / 100,
        status: "pending",
        helperName: booking.helper_name,
        helperMobile: booking.helper_mobile,
        residentName: booking.resident_name,
      } : null,
      otherName,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not cancel this booking. Please try again." }, { status: 500 });
  }
}
