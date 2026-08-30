import assert from "node:assert/strict";
import test from "node:test";
import { clientEditorId } from "../app/lib/client-editor-id.ts";

test("client editor IDs use native randomUUID when available", () => {
  const expected = "native-editor-id";
  assert.equal(clientEditorId({ randomUUID: () => expected, getRandomValues() { throw new Error("fallback used"); } }), expected);
});

test("client editor IDs remain unique when randomUUID is unavailable", () => {
  let seed = 0;
  const source = { getRandomValues(array) { seed += 1; array.forEach((_, index) => { array[index] = (seed * 31 + index * 17) & 255; }); return array; } };
  const first = clientEditorId(source);
  const second = clientEditorId(source);
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
