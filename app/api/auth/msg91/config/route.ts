import { getMsg91PublicConfig } from "../../../../lib/auth";

export async function GET() {
  try {
    return Response.json(await getMsg91PublicConfig(), {
      headers: { "Cache-Control": "private, max-age=300" },
    });
  } catch {
    return Response.json({ error: "Mobile verification is not configured." }, { status: 503 });
  }
}
