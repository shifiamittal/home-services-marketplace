type NotificationResult =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed"; errorCode: string }
  | { status: "not_configured"; errorCode: string };

export type BookingFlowKey =
  | "MSG91_NEW_REQUEST_FLOW_ID"
  | "MSG91_BOOKING_ACCEPTED_FLOW_ID"
  | "MSG91_BOOKING_DECLINED_FLOW_ID";

async function runtimeValue(name: string) {
  const { env } = await import("cloudflare:workers");
  const workerEnv = env as unknown as Record<string, string | undefined>;
  return workerEnv[name] ?? process.env[name];
}

function mobileForMsg91(value: string) {
  return value.replace(/\D/g, "").replace(/^0+/, "");
}

export async function sendBookingSms(
  flowKey: BookingFlowKey,
  mobile: string,
  variables: Record<string, string>,
): Promise<NotificationResult> {
  const [authkey, flowId, sender] = await Promise.all([
    runtimeValue("MSG91_AUTH_KEY"),
    runtimeValue(flowKey),
    runtimeValue("MSG91_SENDER_ID"),
  ]);
  if (!authkey || !flowId) {
    return { status: "not_configured", errorCode: `missing_${!authkey ? "authkey" : flowKey.toLowerCase()}` };
  }
  const recipient = { mobiles: mobileForMsg91(mobile), ...variables };
  try {
    const response = await fetch("https://control.msg91.com/api/v5/flow", {
      method: "POST",
      headers: {
        accept: "application/json",
        authkey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        flow_id: flowId,
        ...(sender ? { sender } : {}),
        recipients: [recipient],
      }),
    });
    const payload = await response.json().catch(() => null) as { type?: string; message?: string } | null;
    if (!response.ok || payload?.type === "error") {
      return { status: "failed", errorCode: payload?.message?.slice(0, 120) || `http_${response.status}` };
    }
    return { status: "sent", providerMessageId: payload?.message || null };
  } catch {
    return { status: "failed", errorCode: "msg91_network_error" };
  }
}

export async function recordNotificationResult(db: D1Database, notificationId: string, result: NotificationResult) {
  await db.prepare(
    `UPDATE notification_log SET status = ?, provider_message_id = ?, error_code = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(
    result.status === "sent" ? "sent" : "failed",
    result.status === "sent" ? result.providerMessageId : null,
    result.status === "sent" ? null : result.errorCode,
    notificationId,
  ).run();
}
