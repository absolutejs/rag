import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { createRAGPagedPDFExtractor } from "../src/ingestion/pdfPages";
import { buildRAGUpsertInputFromUploads } from "../src/ingestion/ingestion";

const mixedPDF = async () => {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(
    await Bun.file(
      new URL("./fixtures/scanned-evidence.png", import.meta.url),
    ).arrayBuffer(),
  );
  pdf.addPage().drawText("Native first page evidence.");
  const scanned = pdf.addPage();
  scanned.drawImage(image, { x: 20, y: 400, width: 500, height: 125 });
  scanned.drawText("Embedded header ".repeat(8));
  pdf.addPage().drawText("Native final page evidence.");
  return pdf.save();
};

test("reads scanned content in mixed PDFs one page at a time and retains page evidence", async () => {
  const bytes = await mixedPDF();
  const calls: number[] = [];
  const extractor = createRAGPagedPDFExtractor({
    provider: {
      name: "fixture-ocr",
      extractText: async (input) => {
        expect((await PDFDocument.load(input.data)).getPageCount()).toBe(1);
        calls.push(Number(input.metadata?.pageNumber));
        return { text: "Scanned evidence: Revenue is 42 dollars." };
      },
    },
  });
  const input = await buildRAGUpsertInputFromUploads({
    extractors: [extractor],
    uploads: [
      {
        content: Buffer.from(bytes).toString("base64"),
        encoding: "base64",
        name: "mixed.pdf",
      },
    ],
  });
  expect(calls).toEqual([2]);
  const text = input.chunks.map((chunk) => chunk.text).join("\n");
  expect(text).toContain("Native first page evidence.");
  expect(text).toContain("Revenue is 42 dollars.");
  expect(text).toContain("Embedded header");
  expect(text).toContain("Native final page evidence.");
  expect(
    input.chunks.find((chunk) => chunk.text.includes("Revenue"))?.metadata
      ?.pageNumber,
  ).toBe(2);
});

test("fails the whole extraction if a scanned page cannot be read", async () => {
  const extractor = createRAGPagedPDFExtractor({
    provider: {
      name: "broken",
      extractText: () => {
        throw new Error("truncated OCR");
      },
    },
  });
  await expect(
    extractor.extract({ data: await mixedPDF(), name: "mixed.pdf" }),
  ).rejects.toThrow("PDF page 2: truncated OCR");
});

test("honors cancellation between pages before making another OCR call", async () => {
  const abort = new AbortController();
  let calls = 0;
  const extractor = createRAGPagedPDFExtractor({
    signal: abort.signal,
    onProgress: () => abort.abort(),
    provider: {
      name: "unused",
      extractText: () => {
        calls++;
        return { text: "unused" };
      },
    },
  });
  await expect(extractor.extract({ data: await mixedPDF() })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("blank PDFs are not reported as successfully ingested", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const extractor = createRAGPagedPDFExtractor({
    provider: { name: "unused", extractText: () => ({ text: "unused" }) },
  });
  await expect(extractor.extract({ data: await pdf.save() })).rejects.toThrow(
    "No readable text",
  );
});
