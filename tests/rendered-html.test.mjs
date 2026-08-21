import assert from "node:assert/strict";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;
const productionDescription =
  "A refined mobile-first marketplace prototype for recurring household professionals in Omaxe New Chandigarh.";

test("renders the production marketplace", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, /<title>Premium Household Help Marketplace Mocks<\/title>/i);
  assert.match(
    html,
    new RegExp(
      `<meta(?=[^>]*\\bname=["']description["'])(?=[^>]*\\bcontent=["']${productionDescription.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'])[^>]*>`,
      "i",
    ),
  );
  assert.match(html, /Reliable home support/i);
  assert.doesNotMatch(html, developmentPreviewMeta);
});
