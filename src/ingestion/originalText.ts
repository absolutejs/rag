import type { RAGDocumentChunk } from "../../types/engine";

/** Offsets are UTF-16 code units, as used by JavaScript String.slice. */
export type RAGOriginalTextLocator = {
  sourceId: string;
  version: string;
  start: number;
  end: number;
};

export type RAGOriginalText = {
  sourceId: string;
  version: string;
  text: string;
  title?: string;
};

const positiveInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};

const validateSource = (source: RAGOriginalText) => {
  if (!source.sourceId.trim() || !source.version.trim())
    throw new Error("Original text requires a source ID and immutable version");
};

const splitsSurrogate = (text: string, offset: number) =>
  offset > 0 &&
  offset < text.length &&
  /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
  /[\uDC00-\uDFFF]/.test(text[offset]!);

/** Verifies identity/version and returns verbatim evidence; never normalizes it.
 * The caller must authorize the source before loading it. Rejects invalid ranges
 * instead of silently returning evidence with a different locator.
 */
export const readRAGOriginalText = (
  source: RAGOriginalText,
  locator: RAGOriginalTextLocator,
  maxCharacters = 12_000,
) => {
  validateSource(source);
  positiveInteger(maxCharacters, "maxCharacters");
  if (
    source.sourceId !== locator.sourceId ||
    source.version !== locator.version
  )
    throw new Error(
      "Original source identity or version does not match the citation",
    );
  if (
    !Number.isSafeInteger(locator.start) ||
    !Number.isSafeInteger(locator.end) ||
    locator.start < 0 ||
    locator.end <= locator.start ||
    locator.end > source.text.length ||
    locator.end - locator.start > maxCharacters ||
    splitsSurrogate(source.text, locator.start) ||
    splitsSurrogate(source.text, locator.end)
  )
    throw new RangeError(
      "Citation must identify a bounded, valid original text range",
    );
  return source.text.slice(locator.start, locator.end);
};

/** An opt-in ingestion path for citable text originals. Unlike format extraction,
 * this preserves whitespace, repeated paragraphs and Unicode exactly. Prefer
 * paragraph/line boundaries while retaining exact offsets and bounded overlap.
 * Chunk size is an indexing choice, not a model context capacity limit.
 */
export const chunkRAGOriginalText = (
  source: RAGOriginalText,
  options: {
    maxCharacters?: number;
    overlapCharacters?: number;
    metadata?: Record<string, unknown>;
  } = {},
): RAGDocumentChunk[] => {
  validateSource(source);
  const maxCharacters = positiveInteger(
    options.maxCharacters ?? 2400,
    "maxCharacters",
  );
  const overlap =
    options.overlapCharacters ?? Math.min(240, Math.floor(maxCharacters / 10));
  if (!Number.isSafeInteger(overlap) || overlap < 0 || overlap >= maxCharacters)
    throw new RangeError(
      "overlapCharacters must be a nonnegative integer smaller than maxCharacters",
    );
  // Grapheme boundaries keep combining marks and emoji sequences intact. Fail
  // explicitly if one grapheme exceeds the configured indexing bound.
  const boundaries = [0];
  for (const segment of new Intl.Segmenter("und", {
    granularity: "grapheme",
  }).segment(source.text)) {
    if (segment.segment.length > maxCharacters)
      throw new RangeError("A source grapheme exceeds maxCharacters");
    boundaries.push(segment.index + segment.segment.length);
  }
  const floorBoundary = (offset: number) => {
    let low = 0;
    let high = boundaries.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (boundaries[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return boundaries[low]!;
  };
  const chunks: RAGDocumentChunk[] = [];
  let start = 0;
  while (start < source.text.length) {
    let end = floorBoundary(
      Math.min(source.text.length, start + maxCharacters),
    );
    if (end < source.text.length) {
      const paragraph = source.text.lastIndexOf("\n\n", end - 2);
      const line = source.text.lastIndexOf("\n", end - 1);
      const preferred =
        paragraph >= start + maxCharacters / 2 ? paragraph + 2 : line + 1;
      if (preferred >= start + maxCharacters / 2)
        end = floorBoundary(preferred);
    }
    const locator: RAGOriginalTextLocator = {
      sourceId: source.sourceId,
      version: source.version,
      start,
      end,
    };
    chunks.push({
      chunkId: `${encodeURIComponent(source.sourceId)}:${encodeURIComponent(source.version)}:${start}:${end}`,
      source: source.sourceId,
      title: source.title,
      text: source.text.slice(start, end),
      metadata: { ...options.metadata, sourceLocator: locator },
    });
    if (end === source.text.length) break;
    const next = floorBoundary(Math.max(start + 1, end - overlap));
    start = next > start ? next : end;
  }
  return chunks;
};
