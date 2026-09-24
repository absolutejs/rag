import type {
  RAGExtractedFileDocument,
  RAGFileExtractor,
  RAGOCRProvider,
} from "../../types/engine";

export type RAGPagedPDFExtractorOptions = {
  provider: RAGOCRProvider;
  signal?: AbortSignal;
  onProgress?: (progress: {
    page: number;
    pageCount: number;
    mode: "native" | "ocr" | "blank";
  }) => void;
};

/** Preserve page evidence and OCR image-bearing pages individually, including
 * scans inside otherwise readable PDFs. The provider must reject truncated OCR.
 * Nothing is returned until every page has been processed successfully. */
export const createRAGPagedPDFExtractor = (
  options: RAGPagedPDFExtractorOptions,
): RAGFileExtractor => ({
  name: `absolute_pdf_paged:${options.provider.name}`,
  supports: (input) =>
    input.contentType === "application/pdf" ||
    /\.pdf(?:[?#].*)?$/iu.test(input.name ?? input.path ?? input.source ?? ""),
  extract: async (input) => {
    options.signal?.throwIfAborted();
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const { getDocument, OPS } =
      await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: Uint8Array.from(input.data),
      disableFontFace: true,
      useSystemFonts: true,
      stopAtErrors: true,
    });
    try {
      const pdf = await task.promise;
      const documents: RAGExtractedFileDocument[] = [];
      let original: import("pdf-lib").PDFDocument | undefined;
      const imageOperators = new Set([
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintImageMaskXObject,
        OPS.paintImageXObjectRepeat,
        OPS.paintImageMaskXObjectRepeat,
        OPS.paintInlineImageXObjectGroup,
        OPS.paintImageMaskXObjectGroup,
      ]);
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        options.signal?.throwIfAborted();
        const page = await pdf.getPage(pageNumber);
        try {
          const content = await page.getTextContent();
          const nativeText = content.items
            .map((item) =>
              "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "",
            )
            .join("")
            .trim();
          const operations = await page.getOperatorList();
          const needsOCR =
            (!nativeText && operations.fnArray.length > 0) ||
            operations.fnArray.some((operation) =>
              imageOperators.has(operation),
            );
          let text = nativeText;
          let mode: "native" | "ocr" | "blank" = nativeText
            ? "native"
            : "blank";
          if (needsOCR) {
            const { PDFDocument } = await import("pdf-lib");
            original ??= await PDFDocument.load(input.data);
            const single = await PDFDocument.create();
            const [copied] = await single.copyPages(original, [pageNumber - 1]);
            single.addPage(copied!);
            const result = await options.provider.extractText({
              ...input,
              contentType: "application/pdf",
              data: await single.save(),
              metadata: {
                ...input.metadata,
                pageNumber,
                pageCount: pdf.numPages,
              },
            });
            options.signal?.throwIfAborted();
            const extracted = result.text.trim();
            if (!extracted)
              throw new Error(
                `OCR returned no readable text for PDF page ${pageNumber}.`,
              );
            // Preserve any embedded evidence the OCR response omitted.
            text =
              nativeText && !extracted.includes(nativeText)
                ? `${nativeText}\n\n${extracted}`
                : extracted;
            mode = "ocr";
          }
          if (text)
            documents.push({
              chunking: input.chunking,
              contentType: "application/pdf",
              format: "text",
              source:
                input.source ?? input.path ?? input.name ?? "document.pdf",
              title: input.title,
              text,
              metadata: {
                ...input.metadata,
                fileKind: "pdf",
                pageNumber,
                pageCount: pdf.numPages,
                sourceNativeKind: "pdf_page",
                pdfEvidenceMode: mode === "ocr" && nativeText ? "hybrid" : mode,
                pdfEvidenceOrigin: mode,
                ...(mode === "ocr" ? { ocrEngine: options.provider.name } : {}),
              },
            });
          options.onProgress?.({
            page: pageNumber,
            pageCount: pdf.numPages,
            mode,
          });
        } catch (error) {
          throw new Error(
            `Could not completely read PDF page ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        } finally {
          page.cleanup();
        }
      }
      if (!documents.length)
        throw new Error("No readable text found in this PDF.");
      return documents;
    } finally {
      await task.destroy();
    }
  },
});
