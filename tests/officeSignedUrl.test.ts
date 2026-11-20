import { expect, test } from "bun:test";
import {
  loadRAGDocumentFromURL,
  loadRAGDocumentsFromUploads,
} from "../src/ingestion/ingestion";

const formats = [
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [
    "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
] as const;
for (const [extension, contentType] of formats) {
  test(`extracts streaming ${extension} from an opaque signed URL with its MIME type`, async () => {
    const data = await Bun.file(
      `${import.meta.dir}/fixtures/streaming-office.${extension}`,
    ).arrayBuffer();
    const doc = await loadRAGDocumentFromURL(
      {
        url: "https://files.invalid/f/opaque-key?signature=private",
        contentType: contentType.toUpperCase() + "; charset=binary",
      },
      async () => new Response(data),
    );
    expect(doc.text.length).toBeGreaterThan(50);
    expect(doc.metadata?.extractor).toBe("absolute_office_document");
    expect(doc.text).not.toContain("PK\u0003\u0004");
    expect(doc.text).not.toMatch(/<\/?[ap]:/);
    const named = await loadRAGDocumentsFromUploads({
      uploads: [
        {
          name: `source.${extension}`,
          contentType,
          encoding: "base64",
          content: Buffer.from(data).toString("base64"),
        },
      ],
    });
    expect(named.documents[0]?.text).toBe(doc.text);
  });
}
test("truncated streaming Office ZIP fails explicitly rather than returning partial content", async () => {
  const data = await Bun.file(
    `${import.meta.dir}/fixtures/streaming-office.pptx`,
  ).arrayBuffer();
  await expect(
    loadRAGDocumentFromURL(
      { url: "https://files.invalid/key", contentType: formats[2][1] },
      async () => new Response(data.slice(0, -22)),
    ),
  ).rejects.toThrow("central directory");
});
test("actual malformed XML still fails validation", async () => {
  await expect(
    loadRAGDocumentFromURL(
      { url: "https://files.invalid/key", contentType: "application/xml" },
      async () => new Response("<root><f></ri></root>"),
    ),
  ).rejects.toThrow("malformed XML");
});

test("PowerPoint text runs exclude similarly named layout tags and preserve numeric slide order", async () => {
  const data = await Bun.file(
    `${import.meta.dir}/fixtures/pptx-text-order.pptx`,
  ).arrayBuffer();
  const doc = await loadRAGDocumentFromURL(
    { url: "https://files.invalid/key", contentType: formats[2][1] },
    async () => new Response(data),
  );
  expect(doc.text).toBe(
    "Slide 1 heading\nBody 1 retained\n\nSlide 2 heading\nBody 2 retained\n\nSlide 10 heading\nBody 10 retained",
  );
});
