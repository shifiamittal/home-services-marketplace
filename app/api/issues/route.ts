import { assertSameOrigin, getD1, getSession } from "../../lib/auth";
import { allocateIssueStatements } from "../../lib/issues";

const residentCategories = new Set([
  "Helper did not arrive",
  "Timing did not work",
  "Not satisfied with service",
  "Safety or misconduct",
  "Something else",
]);

const helperCategories = new Set([
  "Resident was unavailable",
  "Work requested was different",
  "Payment is overdue",
  "Safety or misconduct",
  "I need to end this job",
  "Something else",
]);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in again to continue." }, { status: 401 });

    const body = await request.json() as Record<string, unknown>;
    const category = typeof body.category === "string" ? body.category.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim().slice(0, 1_000) : "";
    const bookingId = typeof body.bookingId === "string" && body.bookingId ? body.bookingId : null;
    const allowed = session.role === "resident" ? residentCategories : helperCategories;
    if (!allowed.has(category)) return Response.json({ error: "Choose one of the available issue types." }, { status: 400 });

    const db = await getD1();
    let reportedUserId: string | null = null;
    if (bookingId) {
      const booking = await db.prepare(
        "SELECT resident_user_id, helper_user_id FROM bookings WHERE id = ? LIMIT 1",
      ).bind(bookingId).first<{ resident_user_id: string; helper_user_id: string }>();
      if (!booking || (session.user_id !== booking.resident_user_id && session.user_id !== booking.helper_user_id)) {
        return Response.json({ error: "This booking was not found." }, { status: 404 });
      }
      reportedUserId = session.user_id === booking.resident_user_id ? booking.helper_user_id : booking.resident_user_id;
    }

    const issueId = crypto.randomUUID();
    await db.batch([
      ...allocateIssueStatements(db, {
        id: issueId,
        bookingId,
        reporterUserId: session.user_id,
        reportedUserId,
        category,
        description: description || null,
      }),
      db.prepare(
        "INSERT INTO issue_status_history (id, issue_id, from_status, to_status, note) VALUES (?, ?, NULL, 'new', 'Submitted through the app')",
      ).bind(crypto.randomUUID(), issueId),
      db.prepare(
        "INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'issue_submitted', ?)",
      ).bind(crypto.randomUUID(), session.user_id, JSON.stringify({ issueId, bookingId, category })),
    ]);
    const created = await db.prepare("SELECT case_number FROM issues WHERE id = ? LIMIT 1")
      .bind(issueId).first<{ case_number: number }>();
    if (!created) throw new Error("Issue case number allocation failed.");
    const caseNumber = created.case_number;
    return Response.json({ submitted: true, caseNumber });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: "We could not submit your report. Please try again." }, { status: 500 });
  }
}
