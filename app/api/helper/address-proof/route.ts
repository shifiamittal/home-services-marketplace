import { assertSameOrigin, getD1, getSession } from "../../../lib/auth";
import { validateAddressProof } from "../../../lib/upload-security";

const acceptedDocuments = new Set(["aadhaar", "voter_id", "other_address_proof"]);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in again to continue." }, { status: 401 });
    if (!session.roles.includes("provider")) return Response.json({ error: "A home helper account is required." }, { status: 403 });
    const { env } = await import("cloudflare:workers");
    const bucket = (env as unknown as { BUCKET?: R2Bucket }).BUCKET;
    if (!bucket) return Response.json({ error: "Private document storage is unavailable." }, { status: 503 });

    const form = await request.formData();
    const file = form.get("file");
    const documentType = form.get("documentType");
    if (!(file instanceof File) || file.size < 1 || file.size > 5 * 1024 * 1024) {
      return Response.json({ error: "Upload a clear JPG, PNG or PDF smaller than 5 MB." }, { status: 400 });
    }
    if (typeof documentType !== "string" || !acceptedDocuments.has(documentType)) {
      return Response.json({ error: "Choose the type of address proof." }, { status: 400 });
    }

    const db = await getD1();
    const existing = await db.prepare(
      "SELECT id, r2_object_key FROM verification_documents WHERE helper_user_id = ? AND status != 'deleted'",
    ).bind(session.user_id).all<{ id: string; r2_object_key: string }>();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let validated: ReturnType<typeof validateAddressProof>;
    try {
      validated = validateAddressProof(file.name, file.type, bytes);
    } catch {
      return Response.json({ error: "This file is not a structurally valid JPG, PNG or safe PDF." }, { status: 400 });
    }
    const documentId = crypto.randomUUID();
    const objectKey = `private/address-proofs/${session.user_id}/${documentId}.${validated.extension}`;
    await bucket.put(objectKey, bytes, {
      httpMetadata: { contentType: validated.contentType, contentDisposition: "attachment" },
      customMetadata: { ownerUserId: session.user_id, documentType },
    });
    await db.batch([
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
    return Response.json({ error: "We could not upload the address proof. Please try again." }, { status: 500 });
  }
}
