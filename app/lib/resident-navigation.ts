// State comes only from the owner-scoped resident loader; this is navigation, not API authorization.
type Commitment = { status?: string; bookingId?: string | null; bookingStatus?: string | null };
type Payment = { status?: string } | null;
export function residentManagement(request: Commitment | null = null, payment: Payment = null) {
  const pending = request?.status === "pending";
  const trial = Boolean(request?.bookingId && request.bookingStatus === "trial");
  const live = Boolean(request?.bookingId && ["trial", "active", "ending"].includes(request.bookingStatus || ""));
  const paymentDue = Boolean(payment && ["pending", "resident_marked_paid", "review_requested"].includes(payment.status || ""));
  return { pending, trial, live, paymentDue, linkedIssue: Boolean(request?.bookingId),
    destination: paymentDue ? "requirement" : pending ? "pending" : trial ? "confirmed" : live ? "dashboard" : "residentAccount" };
}

export function residentDestination(complete: boolean, destination: string, management = residentManagement()): string {
  const next = destination === "membership" ? "dashboard" : destination;
  if (complete || ["residentAccount", "terms", "privacyPolicy"].includes(next)) return next;
  if (next === "pending" && management.pending) return next;
  if (next === "confirmed" && management.trial) return next;
  if (next === "dashboard" && management.live) return next;
  if (next === "requirement" && management.paymentDue) return next;
  if (next === "issue" && management.linkedIssue) return next;
  if (["dashboard", "pending", "confirmed", "requirement"].includes(next)) return management.destination;
  return "residentAccount";
}

// A slow read must neither overwrite a newer read nor steal navigation selected while awaiting it.
export function residentLoadDisposition(startLoad: number, latestLoad: number, startNavigation: number, latestNavigation: number) {
  return { accept: startLoad === latestLoad, navigate: startLoad === latestLoad && startNavigation === latestNavigation };
}

export function avatarInitial(savedName: string): string {
  return savedName.trim().charAt(0).toUpperCase() || "N";
}
