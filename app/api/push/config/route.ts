import { getVapidPublicKey } from "../../../lib/push";

export async function GET() {
  const publicKey = await getVapidPublicKey();
  if (!publicKey) return Response.json({ error: "Device alerts are not configured." }, { status: 503 });
  return Response.json({ publicKey });
}
