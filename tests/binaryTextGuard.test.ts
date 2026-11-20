import { expect, test } from "bun:test";
import {
  loadRAGDocumentFromURL,
  createRAGImageOCRExtractor,
} from "../src/ingestion/ingestion";
const png = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
]);
test("signed image URLs cannot fall through to paid embeddings of binary text", async () => {
  await expect(
    loadRAGDocumentFromURL(
      { url: "https://files.test/opaque", contentType: "image/png" },
      async () => new Response(png),
    ),
  ).rejects.toThrow("No RAG file extractor matched");
});
test("a binary signature with generic MIME cannot be forced through text fallback", async () => {
  await expect(
    loadRAGDocumentFromURL(
      { url: "https://files.test/opaque", format: "text" },
      async () =>
        new Response(png, {
          headers: { "content-type": "application/octet-stream" },
        }),
    ),
  ).rejects.toThrow("No RAG file extractor matched");
});
test("registered OCR preserves image text instead of decoding the image bytes", async () => {
  const extractor = createRAGImageOCRExtractor({
    name: "test",
    extractText: async () => ({ text: "ARTZA" }),
  });
  const result = await loadRAGDocumentFromURL(
    {
      url: "https://files.test/opaque",
      contentType: "image/png",
      extractors: [extractor],
    },
    async () => new Response(png),
  );
  expect(result.text).toContain("ARTZA");
});
test("opaque URLs still ingest real Unicode plain text", async () => {
  const result = await loadRAGDocumentFromURL(
    { url: "https://files.test/opaque" },
    async () =>
      new Response("שלום Artza 🌍", {
        headers: { "content-type": "application/octet-stream" },
      }),
  );
  expect(result.text).toBe("שלום Artza 🌍");
});
