export function fieldError(field: string, message: string, status = 400) {
  return Response.json({ error: message, fields: { [field]: message } }, { status });
}

export function profileFailure(operation: "profile_save" | "profile_status" | "proof_upload" | "proof_cleanup") {
  const correlationId = crypto.randomUUID();
  // Fixed operation and a fresh random identifier only. Never log the caught
  // exception: D1/provider errors can include SQL, payloads or personal data.
  console.error(JSON.stringify({ operation, correlationId }));
  return Response.json({
    error: "We could not save your changes. Please retry.",
    correlationId,
  }, { status: 500 });
}
