import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";
import { sendPushToUser } from "../../../lib/push";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in again to continue." }, { status: 401 });
    const body = await request.json() as Record<string, unknown>;
    const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
    const action = typeof body.action === "string" ? body.action : "";
    const db = await getD1();
    const payment = await db.prepare(
      `SELECT tp.id, tp.booking_id, tp.resident_user_id, tp.helper_user_id, tp.amount_paise, tp.status,
              tp.resident_marked_paid_at, ru.name AS resident_name, hu.name AS helper_name
       FROM trial_payments tp JOIN users ru ON ru.id = tp.resident_user_id JOIN users hu ON hu.id = tp.helper_user_id
       WHERE tp.id = ? LIMIT 1`,
    ).bind(paymentId).first<{ id: string; booking_id: string; resident_user_id: string; helper_user_id: string; amount_paise: number; status: string; resident_marked_paid_at: string | null; resident_name: string; helper_name: string }>();
    if (!payment) return Response.json({ error: "This trial payment was not found." }, { status: 404 });

    if (action === "mark_paid") {
      if (session.user_id !== payment.resident_user_id) return Response.json({ error: "Only the resident can submit this payment." }, { status: 403 });
      if (payment.status !== "pending") return Response.json({ error: "This payment has already been updated." }, { status: 409 });
      await db.batch([
        db.prepare("UPDATE trial_payments SET status = 'resident_marked_paid', transaction_reference = NULL, resident_marked_paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'").bind(payment.id),
        db.prepare(`INSERT INTO notification_log (id, user_id, channel, template_key, title, body, action_view, related_entity_type, related_entity_id, status)
          VALUES (?, ?, 'in_app', 'trial_payment_sent', 'Confirm trial payment', ?, 'providerDashboard', 'trial_payment', ?, 'delivered')`)
          .bind(crypto.randomUUID(), payment.helper_user_id, `${payment.resident_name} marked ₹${(payment.amount_paise / 100).toLocaleString("en-IN")} as paid. Confirm after checking your payment app.`, payment.id),
        db.prepare("INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'trial_payment_marked_sent', ?)")
          .bind(crypto.randomUUID(), session.user_id, JSON.stringify({ paymentId: payment.id, bookingId: payment.booking_id })),
      ]);
      await sendPushToUser(db, payment.helper_user_id, { title: "Confirm trial payment", body: `${payment.resident_name} submitted a trial payment.`, url: "/", tag: `trial-payment-${payment.id}` });
      return Response.json({ status: "resident_marked_paid" });
    }

    if (action === "confirm_received") {
      if (session.user_id !== payment.helper_user_id) return Response.json({ error: "Only the home helper can confirm receipt." }, { status: 403 });
      if (payment.status !== "resident_marked_paid") return Response.json({ error: "This payment is not awaiting confirmation." }, { status: 409 });
      await db.batch([
        db.prepare("UPDATE trial_payments SET status = 'confirmed', helper_confirmed_at = CURRENT_TIMESTAMP, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'resident_marked_paid'").bind(payment.id),
        db.prepare(`INSERT INTO notification_log (id, user_id, channel, template_key, title, body, action_view, related_entity_type, related_entity_id, status)
          VALUES (?, ?, 'in_app', 'trial_payment_confirmed', 'Payment confirmed', ?, 'requirement', 'trial_payment', ?, 'delivered')`)
          .bind(crypto.randomUUID(), payment.resident_user_id, `${payment.helper_name} confirmed receipt. You can now send a new booking request.`, payment.id),
        db.prepare("INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'trial_payment_confirmed', ?)")
          .bind(crypto.randomUUID(), session.user_id, JSON.stringify({ paymentId: payment.id, bookingId: payment.booking_id })),
      ]);
      await sendPushToUser(db, payment.resident_user_id, { title: "Payment confirmed", body: "You can now send a new booking request.", url: "/", tag: `trial-payment-confirmed-${payment.id}` });
      return Response.json({ status: "confirmed" });
    }

    if (action === "request_review") {
      if (session.user_id !== payment.resident_user_id) return Response.json({ error: "Only the resident can request review." }, { status: 403 });
      if (payment.status !== "resident_marked_paid" || !payment.resident_marked_paid_at) return Response.json({ error: "This payment is not awaiting confirmation." }, { status: 409 });
      if (Date.now() - new Date(payment.resident_marked_paid_at).getTime() < 12 * 60 * 60 * 1_000) return Response.json({ error: "You can request review 12 hours after submitting payment." }, { status: 409 });
      const nextCase = await db.prepare("SELECT COALESCE(MAX(case_number), 1000) + 1 AS next_case FROM issues").first<{ next_case: number }>();
      await db.batch([
        db.prepare("UPDATE trial_payments SET status = 'review_requested', review_requested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'resident_marked_paid'").bind(payment.id),
        db.prepare(`INSERT INTO issues (id, case_number, booking_id, reporter_user_id, reported_user_id, category, description)
          VALUES (?, ?, ?, ?, ?, 'Payment sent but not confirmed', ?)`)
          .bind(crypto.randomUUID(), nextCase?.next_case ?? 1001, payment.booking_id, payment.resident_user_id, payment.helper_user_id, `The resident marked the trial payment as paid, but helper confirmation was not received within 12 hours.`),
        db.prepare("INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'trial_payment_review_requested', ?)")
          .bind(crypto.randomUUID(), session.user_id, JSON.stringify({ paymentId: payment.id, bookingId: payment.booking_id })),
      ]);
      return Response.json({ status: "review_requested", residentUnlocked: true });
    }
    return Response.json({ error: "Choose a valid payment action." }, { status: 400 });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not update this payment." }, { status: 500 });
  }
}
