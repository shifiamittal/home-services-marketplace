import assert from "node:assert/strict";
import test from "node:test";

import { deriveBookingWorkflowState } from "../app/lib/booking-workflow.ts";

test("derives one authoritative state for the complete booking lifecycle", () => {
  const cases = [
    [{}, "ready_to_search"],
    [{ requestStatus: "pending" }, "request_pending"],
    [{ requestStatus: "declined" }, "request_declined"],
    [{ requestStatus: "expired" }, "request_expired"],
    [{ requestStatus: "withdrawn" }, "request_withdrawn"],
    [{ requestStatus: "accepted", bookingStatus: "trial" }, "booking_trial"],
    [{ requestStatus: "accepted", bookingStatus: "active" }, "booking_active"],
    [{ requestStatus: "accepted", bookingStatus: "ending" }, "booking_ending"],
    [{ requestStatus: "accepted", bookingStatus: "cancelled" }, "booking_cancelled"],
    [{ requestStatus: "accepted", bookingStatus: "completed" }, "booking_completed"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(deriveBookingWorkflowState(input), expected);
  }
});

test("payment resolution supersedes stale request and booking screens", () => {
  assert.equal(deriveBookingWorkflowState({
    requestStatus: "accepted",
    bookingStatus: "cancelled",
    paymentStatus: "pending",
  }), "trial_payment_due");
  assert.equal(deriveBookingWorkflowState({
    requestStatus: "accepted",
    bookingStatus: "cancelled",
    paymentStatus: "resident_marked_paid",
  }), "trial_payment_confirmation_pending");
  assert.equal(deriveBookingWorkflowState({
    requestStatus: "accepted",
    bookingStatus: "cancelled",
    paymentStatus: "review_requested",
  }), "trial_payment_under_review");
});

test("never presents an accepted request without a booking as confirmed", () => {
  assert.equal(deriveBookingWorkflowState({ requestStatus: "accepted" }), "inconsistent");
  assert.equal(deriveBookingWorkflowState({ requestStatus: "pending", bookingStatus: "trial" }), "booking_trial");
});
