export type ValidAddressProof = {
  contentType: "image/jpeg" | "image/png" | "application/pdf";
  extension: "jpg" | "png" | "pdf";
  filename: string;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function endsWith(bytes: Uint8Array, signature: number[]) {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[bytes.length - signature.length + index] === value);
}

function ascii(bytes: Uint8Array) {
  return new TextDecoder("latin1").decode(bytes);
}

function containsActiveContent(text: string) {
  return /<\s*(?:html|script|iframe|svg)|javascript\s*:|\/JavaScript\b|\/JS\b|\/Launch\b|\/OpenAction\b/i.test(text);
}

function validJpeg(bytes: Uint8Array) {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff]) || !endsWith(bytes, [0xff, 0xd9])) return false;
  let position = 2;
  let hasFrame = false;
  while (position < bytes.length - 1) {
    if (bytes[position] !== 0xff) return false;
    while (bytes[position] === 0xff) position += 1;
    const marker = bytes[position++];
    if (marker === 0xd9) return hasFrame && position === bytes.length;
    if (marker === 0x00 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (position + 2 > bytes.length) return false;
    const length = bytes[position] * 256 + bytes[position + 1];
    if (length < 2 || position + length > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) hasFrame = true;
    if (marker === 0xda) {
      position += length;
      while (position < bytes.length - 1) {
        if (bytes[position] !== 0xff) {
          position += 1;
          continue;
        }
        const next = bytes[position + 1];
        if (next === 0x00 || next >= 0xd0 && next <= 0xd7) {
          position += 2;
          continue;
        }
        return next === 0xd9 && hasFrame && position + 2 === bytes.length;
      }
      return false;
    }
    position += length;
  }
  return false;
}

function validPng(bytes: Uint8Array) {
  if (!startsWith(bytes, PNG_SIGNATURE) || !endsWith(bytes, PNG_IEND)) return false;
  let position = PNG_SIGNATURE.length;
  let first = true;
  while (position + 12 <= bytes.length) {
    const length = bytes[position] * 0x1000000 + bytes[position + 1] * 0x10000 + bytes[position + 2] * 0x100 + bytes[position + 3];
    const type = ascii(bytes.subarray(position + 4, position + 8));
    const chunkEnd = position + 12 + length;
    if (length < 0 || chunkEnd > bytes.length || first && (type !== "IHDR" || length !== 13)) return false;
    if (type === "IEND") return length === 0 && chunkEnd === bytes.length;
    first = false;
    position = chunkEnd;
  }
  return false;
}

export function sanitizeUploadFilename(filename: string, extension: ValidAddressProof["extension"]) {
  const leaf = filename.split(/[\\/]/).pop() ?? "address-proof";
  const withoutExtension = leaf.replace(/\.[^.]*$/, "");
  const safeBase = withoutExtension
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 100) || "address-proof";
  return `${safeBase}.${extension}`;
}

export function validateAddressProof(
  filename: string,
  declaredType: string,
  bytes: Uint8Array,
): ValidAddressProof {
  if (bytes.length < 4 || bytes.length > 5 * 1024 * 1024) throw new Error("invalid_size");
  const prefixText = ascii(bytes.subarray(0, Math.min(bytes.length, 4_096)));
  if (containsActiveContent(prefixText)) throw new Error("active_content");

  let contentType: ValidAddressProof["contentType"];
  let extension: ValidAddressProof["extension"];
  if (validJpeg(bytes)) {
    contentType = "image/jpeg";
    extension = "jpg";
  } else if (validPng(bytes)) {
    contentType = "image/png";
    extension = "png";
  } else if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    const text = ascii(bytes);
    const tail = text.slice(-1_024);
    if (!tail.includes("%%EOF") || containsActiveContent(text)) throw new Error("unsafe_pdf");
    contentType = "application/pdf";
    extension = "pdf";
  } else {
    throw new Error("unsupported_signature");
  }

  if (declaredType !== contentType) throw new Error("mime_mismatch");
  return { contentType, extension, filename: sanitizeUploadFilename(filename, extension) };
}
