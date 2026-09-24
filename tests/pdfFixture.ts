import { deflateSync } from "node:zlib";

// Convert the original layout-test notation to real PDF objects, font resources,
// compressed streams and an xref table. Production never parses this notation.
const normalizeWhitespace = (value: string) =>
  value.replace(/\s+/g, " ").trim();
const decodePdfLiteral = (value: string) =>
  value
    .replace(/\\([\\()])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    );

const PDF_TABLE_GAP_THRESHOLD = 120;

const extractPdfArrayText = (value: string) => {
  const parts: string[] = [];
  const tokenPattern = /\(((?:\\.|[^\\)])*)\)|([-+]?\d*\.?\d+)/g;
  let pendingColumnGap = false;

  for (const match of value.matchAll(tokenPattern)) {
    if (match[1] !== undefined) {
      const decoded = decodePdfLiteral(match[1]);
      if (
        pendingColumnGap &&
        decoded &&
        !/^\s/.test(decoded) &&
        parts.at(-1) !== " | "
      ) {
        parts.push(" | ");
      }

      parts.push(decoded);
      pendingColumnGap = false;
      continue;
    }

    const gap = Number(match[2]);
    if (Number.isFinite(gap) && gap >= PDF_TABLE_GAP_THRESHOLD) {
      pendingColumnGap = true;
    }
  }

  return normalizeWhitespace(parts.join(""))
    .replace(/\s+\|\s+/g, " | ")
    .trim();
};

const appendPdfText = (parts: string[], value: string) => {
  if (!value) {
    return;
  }

  parts.push(value);
};

const appendPdfLineBreak = (parts: string[]) => {
  const last = parts.at(-1);
  if (!last || last.endsWith("\n")) {
    return;
  }

  parts.push("\n");
};

const PDF_TEXT_OPERATOR_PATTERN =
  /(\[((?:\\.|[^\]])*)\]\s*TJ)|(\(((?:\\.|[^\\)])*)\)\s*Tj)|([-+]?\d*\.?\d+\s+[-+]?\d*\.?\d+\s+\(((?:\\.|[^\\)])*)\)\s*")|(\(((?:\\.|[^\\)])*)\)\s*')|((?:[-+]?\d*\.?\d+\s+){2}(?:Td|TD))|(T\*)|((?:[-+]?\d*\.?\d+\s+){6}Tm)/g;

const extractTextFromPDFTextObject = (value: string) => {
  const parts: string[] = [];

  for (const match of value.matchAll(PDF_TEXT_OPERATOR_PATTERN)) {
    if (match[2] !== undefined) {
      appendPdfText(parts, extractPdfArrayText(match[2]));
      continue;
    }

    if (match[4] !== undefined) {
      appendPdfText(parts, decodePdfLiteral(match[4]));
      continue;
    }

    if (match[6] !== undefined) {
      appendPdfLineBreak(parts);
      appendPdfText(parts, decodePdfLiteral(match[6]));
      continue;
    }

    if (match[8] !== undefined) {
      appendPdfLineBreak(parts);
      appendPdfText(parts, decodePdfLiteral(match[8]));
      continue;
    }

    if (
      match[9] !== undefined ||
      match[10] !== undefined ||
      match[11] !== undefined
    ) {
      appendPdfLineBreak(parts);
    }
  }

  return parts.join("");
};

export const makePDFFixture = (
  template: string,
  _encoding?: string,
): Buffer => {
  const markers = [...template.matchAll(/\/Type\s*\/Page\b/g)];
  const pages: string[][] = Array.from(
    { length: Math.max(markers.length, 1) },
    () => [],
  );
  for (const match of template.matchAll(/BT([\s\S]*?)ET/g)) {
    const end = match.index! + match[0].length;
    const index = markers.findIndex((marker) => marker.index! >= end);
    pages[index < 0 ? pages.length - 1 : index]!.push(
      extractTextFromPDFTextObject(match[1]!),
    );
  }
  const escape = (value: string) => value.replace(/[\\()]/g, "\\$&");
  const objects: Buffer[] = [];
  const add = (value: string | Buffer) => {
    objects.push(Buffer.from(value));
  };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] >>`,
  );
  add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  for (const [index, blocks] of pages.entries()) {
    let y = 760;
    const operations = blocks
      .map((block) => {
        const lines = block.split("\n");
        const result = `BT /F1 10 Tf 12 TL 1 0 0 1 30 ${y} Tm\n${lines.map((line, lineIndex) => `${lineIndex ? "T* " : ""}(${escape(line)}) Tj`).join("\n")}\nET`;
        y -= lines.length * 12 + 24;
        return result;
      })
      .join("\n");
    const stream = deflateSync(Buffer.from(operations, "latin1"));
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
    );
    add(
      Buffer.concat([
        Buffer.from(
          `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`,
        ),
        stream,
        Buffer.from("\nendstream"),
      ]),
    );
  }
  let document = Buffer.from("%PDF-1.7\n");
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(document.length);
    document = Buffer.concat([
      document,
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
  }
  const xref = document.length;
  return Buffer.concat([
    document,
    Buffer.from(
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  ]);
};
