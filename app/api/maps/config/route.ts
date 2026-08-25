import { getGoogleMapsPublicConfig } from "../../../lib/auth";

export async function GET() {
  try {
    return Response.json(await getGoogleMapsPublicConfig(), {
      headers: { "Cache-Control": "private, max-age=300" },
    });
  } catch {
    return Response.json({ error: "Address search is not configured yet." }, { status: 503 });
  }
}
