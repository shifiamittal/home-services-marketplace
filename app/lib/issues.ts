export type IssueInput = {
  id: string;
  bookingId: string | null;
  reporterUserId: string;
  reportedUserId: string | null;
  category: string;
  description: string | null;
};

export function allocateIssueStatements(db: D1Database, issue: IssueInput) {
  return [
    db.prepare("UPDATE issue_case_counter SET next_case_number = next_case_number + 1 WHERE id = 1"),
    db.prepare(
      `INSERT INTO issues
       (id, case_number, booking_id, reporter_user_id, reported_user_id, category, description, status)
       SELECT ?, next_case_number - 1, ?, ?, ?, ?, ?, 'new'
       FROM issue_case_counter WHERE id = 1`,
    ).bind(
      issue.id,
      issue.bookingId,
      issue.reporterUserId,
      issue.reportedUserId,
      issue.category,
      issue.description,
    ),
  ];
}
