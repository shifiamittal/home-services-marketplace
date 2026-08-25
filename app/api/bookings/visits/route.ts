import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";
import { sendPushToUser } from "../../../lib/push";
import { indiaLocalDateMinuteToUtcMs } from "../../../lib/service-time";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getSession(request);
    if (!session || !session.roles.includes("provider")) return Response.json({ error: "A home helper account is required." }, { status: 403 });
    const body = await request.json() as Record<string, unknown>;
    const bookingId = typeof body.bookingId === "string" ? body.bookingId : "";
    const trialOrdinal = Number(body.trialOrdinal);
    if (!bookingId || ![1, 2].includes(trialOrdinal)) return Response.json({ error: "Choose the trial service day to complete." }, { status: 400 });
    const db = await getD1();
    const booking = await db.prepare(
      `SELECT id, resident_user_id, helper_user_id, status, trial_visits_completed
       FROM bookings WHERE id = ? AND helper_user_id = ? LIMIT 1`,
    ).bind(bookingId, session.user_id).first<{ id: string; resident_user_id: string; helper_user_id: string; status: string; trial_visits_completed: number }>();
    if (!booking || booking.status !== "trial") return Response.json({ error: "This booking is not in its trial period." }, { status: 409 });
    if (trialOrdinal !== booking.trial_visits_completed + 1) return Response.json({ error: "Complete the trial service days in order." }, { status: 409 });
    const visits = await db.prepare(
      `SELECT sv.id, sv.scheduled_for, bs.end_minute
       FROM service_visits sv JOIN booking_slots bs ON bs.id = sv.booking_slot_id
       WHERE sv.booking_id = ? AND sv.trial_ordinal = ? AND sv.status = 'scheduled'`,
    ).bind(bookingId, trialOrdinal).all<{ id: string; scheduled_for: string; end_minute: number }>();
    if (!visits.results.length) return Response.json({ error: "The scheduled trial visit could not be found." }, { status: 409 });
    const localDate = visits.results[0].scheduled_for.slice(0, 10);
    const finalVisitEndMinute = Math.max(...visits.results.map(visit => visit.end_minute));
    const completionAvailableAt = indiaLocalDateMinuteToUtcMs(localDate, finalVisitEndMinute);
    if (Date.now() < completionAvailableAt) {
      const availableAt = new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(completionAvailableAt));
      return Response.json({ error: `This service day can be marked complete after the final visit ends at ${availableAt}.` }, { status: 409 });
    }
    const nextStatus = trialOrdinal === 2 ? "active" : "trial";
    const statements = visits.results.map(visit => db.prepare(
      `UPDATE service_visits SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
       helper_confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'scheduled'`,
    ).bind(visit.id));
    statements.push(db.prepare(
      `UPDATE bookings SET trial_visits_completed = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'trial' AND trial_visits_completed = ?`,
    ).bind(trialOrdinal, nextStatus, bookingId, trialOrdinal - 1));
    if (nextStatus === "active") statements.push(db.prepare(
      "INSERT INTO booking_status_history (id, booking_id, from_status, to_status, actor_user_id, reason) VALUES (?, ?, 'trial', 'active', ?, 'two_trial_service_days_completed')",
    ).bind(crypto.randomUUID(), bookingId, session.user_id));
    statements.push(
      db.prepare("INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'trial_service_day_completed', ?)")
        .bind(crypto.randomUUID(), session.user_id, JSON.stringify({ bookingId, trialOrdinal })),
      db.prepare(
        `INSERT INTO notification_log
         (id, user_id, channel, template_key, title, body, action_view, related_entity_type, related_entity_id, status)
         VALUES (?, ?, 'in_app', 'trial_service_completed', ?, ?, 'dashboard', 'booking', ?, 'delivered')`,
      ).bind(crypto.randomUUID(), booking.resident_user_id, `Trial service day ${trialOrdinal} completed`, trialOrdinal === 2 ? "The paid trial is complete. Your booking now continues through the 30-day service period." : "Your home helper marked the first paid trial service day complete.", bookingId),
    );
    await db.batch(statements);
    await sendPushToUser(db, booking.resident_user_id, {
      title: `Trial service day ${trialOrdinal} completed`,
      body: trialOrdinal === 2 ? "Your booking now continues through the 30-day service period." : "Your first paid trial service day is complete.",
      url: "/",
      tag: `trial-day-${bookingId}-${trialOrdinal}`,
    });
    return Response.json({ completed: true, trialVisitsCompleted: trialOrdinal, bookingStatus: nextStatus });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not complete this service day." }, { status: 500 });
  }
}
