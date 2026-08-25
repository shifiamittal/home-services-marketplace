import { assertSameOrigin, clearSessionCookies, revokeSession } from "../../../lib/auth";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await revokeSession(request);
  } catch (error) {
    if (error instanceof Response) return error;
  }
  const response = Response.json({ signedOut: true });
  for (const cookie of clearSessionCookies()) response.headers.append("Set-Cookie", cookie);
  return response;
}
