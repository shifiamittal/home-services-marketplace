import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";
import { validateAddressProof } from "../../../lib/upload-security";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in again to continue." }, { status: 401 });
    if (!session.roles.includes("provider")) return Response.json({ error: "A home helper account is required." }, { status: 403 });
    const { env } = await import("cloudflare:workers");
    const bucket = env.BUCKET;
    if (!bucket) return Response.json({ error: "Private document storage is unavailable." }, { status: 503 });

    const form = await request.formData();
    const file = form.get("file");
    // Retain the required legacy schema column without asking for classification.
    const documentType = "other_address_proof";
    if (!(file instanceof File) || file.size < 1 || file.size > 5 * 1024 * 1024) {
      return Response.json({ error: "Upload a clear JPEG or PNG image no larger than 5 MB." }, { status: 400 });
    }

    const db = await getD1();
    const existing = await db.prepare(
      "SELECT id, r2_object_key, status FROM verification_documents WHERE helper_user_id = ? AND status != 'deleted'",
    ).bind(session.user_id).all<{ id: string; r2_object_key: string; status: string }>();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let validated: ReturnType<typeof validateAddressProof>;
    try {
      validated = validateAddressProof(file.name, file.type, bytes);
    } catch {
      return Response.json({ error: "Upload a valid JPEG or PNG image with a matching filename extension and file type." }, { status: 400 });
    }
    const documentId = crypto.randomUUID();
    const objectKey = `private/address-proofs/${session.user_id}/${documentId}.${validated.extension}`;
    await bucket.put(objectKey, bytes, {
      httpMetadata: { contentType: validated.contentType, contentDisposition: "attachment" },
      customMetadata: { ownerUserId: session.user_id, documentType },
    });
    await db.batch([
      // Recheck eligibility, ownership and the complete expected current set
      // before any D1 mutation. A competing replacement/review must retry.
      db.prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id
           WHERE u.id = ? AND u.status = 'active' AND ur.role = 'helper'
         ) AND (SELECT count(*) FROM verification_documents WHERE helper_user_id = ? AND status != 'deleted') = json_array_length(?)
         AND NOT EXISTS (
           SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS (
             SELECT 1 FROM verification_documents vd WHERE vd.helper_user_id = ?
               AND vd.id = json_extract(expected.value, '$.id')
               AND vd.r2_object_key = json_extract(expected.value, '$.r2_object_key')
               AND vd.status = json_extract(expected.value, '$.status') AND vd.status != 'deleted'
           )
         ) THEN 1 ELSE abs(-9223372036854775808) END`,
      ).bind(session.user_id, session.user_id, JSON.stringify(existing.results), JSON.stringify(existing.results), session.user_id),
      db.prepare(
        `INSERT INTO helper_profiles (user_id, home_locality, verification_status, profile_status)
         VALUES (?, '', 'pending', 'draft')
         ON CONFLICT(user_id) DO UPDATE SET verification_status = 'pending', updated_at = CURRENT_TIMESTAMP`,
      ).bind(session.user_id),
      db.prepare("UPDATE verification_documents SET status = 'deleted' WHERE helper_user_id = ? AND status != 'deleted'").bind(session.user_id),
      db.prepare(
        `INSERT INTO verification_documents
         (id, helper_user_id, document_type, r2_object_key, original_filename, content_type, size_bytes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).bind(documentId, session.user_id, documentType, objectKey, validated.filename, validated.contentType, file.size),
      db.prepare(
        "INSERT INTO analytics_events (id, user_id, event_name, properties_json) VALUES (?, ?, 'address_proof_uploaded', ?)",
      ).bind(crypto.randomUUID(), session.user_id, JSON.stringify({ documentType, contentType: validated.contentType, sizeBytes: file.size })),
    ]);
    await Promise.all(existing.results.map(item => bucket.delete(item.r2_object_key).catch(() => undefined)));
    return Response.json({ uploaded: true, filename: validated.filename, status: "provided" });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof Error && error.message.includes("integer overflow")) {
      return Response.json({ error: "We could not save your changes. Refresh and try again." }, { status: 409 });
    }
    return Response.json({ error: "We could not upload the address proof. Please try again." }, { status: 500 });
  }
}
