import { buildPushHTTPRequest } from "@pushforge/builder";

type PushPayload = { title: string; body: string; url?: string; tag?: string };

async function runtimeValue(name: string) {
  const { env } = await import("cloudflare:workers");
  const workerEnv = env as unknown as Record<string, string | undefined>;
  return workerEnv[name] ?? process.env[name];
}

export async function getVapidPublicKey() {
  return await runtimeValue("VAPID_PUBLIC_KEY") ?? "";
}

export async function sendPushToUser(db: D1Database, userId: string, payload: PushPayload) {
  const privateJwk = await runtimeValue("VAPID_PRIVATE_JWK");
  const subject = await runtimeValue("VAPID_SUBJECT");
  if (!privateJwk || !subject) return;
  const subscriptions = await db.prepare(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? AND status = 'active'",
  ).bind(userId).all<{ id: string; endpoint: string; p256dh: string; auth: string }>();
  for (const subscription of subscriptions.results) {
    try {
      const outgoing = await buildPushHTTPRequest({
        privateJWK: privateJwk,
        subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        message: {
          payload: { ...payload, icon: "/favicon.svg" },
          adminContact: subject,
          options: { ttl: 86_400, urgency: "high" },
        },
      });
      const response = await fetch(outgoing.endpoint, { method: "POST", headers: outgoing.headers, body: outgoing.body });
      if (response.status === 404 || response.status === 410) {
        await db.prepare("UPDATE push_subscriptions SET status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(subscription.id).run();
      } else if (response.ok) {
        await db.prepare("UPDATE push_subscriptions SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(subscription.id).run();
      }
    } catch {
      // In-app notifications remain available when a device push cannot be delivered.
    }
  }
}
