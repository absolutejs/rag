import { expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  buildRAGUpsertInputFromUploads,
  createRAGPDFOCRExtractor,
  loadRAGDocumentUpload,
} from "../src/ingestion/ingestion";

const upload = (bytes: Uint8Array) => ({
  content: Buffer.from(bytes).toString("base64"),
  contentType: "application/pdf",
  encoding: "base64" as const,
  name: "briefing.pdf",
  source: "artifact:briefing:revision:1",
});

for (const useObjectStreams of [true, false]) {
  test(`reads compressed content and font-encoded text (object streams: ${useObjectStreams})`, async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf
      .addPage()
      .drawText("Partnership briefing: caf\u00e9", { font, x: 40, y: 700 });
    pdf
      .addPage()
      .drawText("Verified capabilities on the final page.", {
        font,
        x: 40,
        y: 700,
      });
    const bytes = await pdf.save({ useObjectStreams });
    expect(Buffer.from(bytes).toString("latin1")).toContain("/FlateDecode");
    const document = await loadRAGDocumentUpload(upload(bytes));
    expect(document.text).toContain("Partnership briefing: caf\u00e9");
    expect(document.text).toContain("Verified capabilities on the final page.");
    expect(document.metadata?.pageCount).toBe(2);
    expect(document.metadata?.pdfTextBlocks).toMatchObject([
      { pageNumber: 1, text: "Partnership briefing: caf\u00e9" },
      { pageNumber: 2, text: "Verified capabilities on the final page." },
    ]);
    const indexed = await buildRAGUpsertInputFromUploads({
      uploads: [upload(bytes)],
    });
    expect(
      indexed.chunks.some((chunk) => chunk.text.includes("final page")),
    ).toBe(true);
  });
}

test("indexes beyond application intake page and character caps without truncating", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= 151; index++) {
    const page = pdf.addPage();
    for (let line = 1; line <= 20; line++) {
      page.drawText(
        `Page ${index} line ${line}: retain the complete evidence for retrieval.`,
        {
          font,
          size: 10,
          x: 30,
          y: 760 - line * 14,
        },
      );
    }
  }
  const document = await loadRAGDocumentUpload(upload(await pdf.save()));
  expect(document.metadata?.pageCount).toBe(151);
  expect(document.text.length).toBeGreaterThan(100_000);
  expect(document.text).toContain(
    "Page 151 line 20: retain the complete evidence for retrieval.",
  );
});

test("rejects malformed and empty PDFs instead of indexing their raw operators", async () => {
  await expect(
    loadRAGDocumentUpload(
      upload(Buffer.from("%PDF-1.4\nBT (fake text) Tj ET\n%%EOF")),
    ),
  ).rejects.toThrow();
  const pdf = await PDFDocument.create();
  pdf.addPage();
  await expect(loadRAGDocumentUpload(upload(await pdf.save()))).rejects.toThrow(
    "could not extract readable text",
  );
});

test("retains explicit OCR fallback for a valid PDF with no text layer", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = await pdf.save();
  let calls = 0;
  const loaded = await loadRAGDocumentUpload({
    ...upload(bytes),
    extractors: [
      createRAGPDFOCRExtractor({
        provider: {
          name: "test-ocr",
          extractText: (input) => {
            calls++;
            expect(input.data).toEqual(bytes);
            return { text: "Scanned page evidence." };
          },
        },
      }),
    ],
  });
  expect(calls).toBe(1);
  expect(loaded.text).toBe("Scanned page evidence.");
  expect(loaded.metadata?.pageCount).toBe(1);
  expect(loaded.metadata?.pdfTextMode).toBe("ocr");
});
