export type BookingWorkflowState =
  | "ready_to_search"
  | "request_pending"
  | "request_declined"
  | "request_expired"
  | "request_withdrawn"
  | "booking_trial"
  | "booking_active"
  | "booking_ending"
  | "booking_cancelled"
  | "booking_completed"
  | "trial_payment_due"
  | "trial_payment_confirmation_pending"
  | "trial_payment_under_review"
  | "inconsistent";

type WorkflowInput = {
  requestStatus?: string | null;
  bookingStatus?: string | null;
  paymentStatus?: string | null;
};

/**
 * One precedence order for every resident and helper surface.
 * Payment resolution remains visible after a booking is cancelled, while an
 * active booking always supersedes the request that created it.
 */
export function deriveBookingWorkflowState({ requestStatus, bookingStatus, paymentStatus }: WorkflowInput): BookingWorkflowState {
  if (paymentStatus === "pending") return "trial_payment_due";
  if (paymentStatus === "resident_marked_paid") return "trial_payment_confirmation_pending";
  if (paymentStatus === "review_requested") return "trial_payment_under_review";

  if (bookingStatus === "trial") return "booking_trial";
  if (bookingStatus === "active") return "booking_active";
  if (bookingStatus === "ending") return "booking_ending";
  if (bookingStatus === "cancelled") return "booking_cancelled";
  if (bookingStatus === "completed") return "booking_completed";

  if (requestStatus === "pending") return "request_pending";
  if (requestStatus === "declined") return "request_declined";
  if (requestStatus === "expired") return "request_expired";
  if (requestStatus === "withdrawn") return "request_withdrawn";
  if (!requestStatus && !bookingStatus) return "ready_to_search";

  // An accepted request must have a booking. Returning an explicit state keeps
  // a partial write from being presented as either pending or confirmed.
  return "inconsistent";
}
