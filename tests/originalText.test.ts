import { describe, expect, test } from "bun:test";
import {
  chunkRAGOriginalText,
  readRAGOriginalText,
  type RAGOriginalTextLocator,
} from "../src/ingestion/originalText";

const source = {
  sourceId: "member/a/intake",
  version: "sha256:first",
  text:
    "  Heading\r\n\r\n" +
    "Repeated paragraph: cafe\u0301 👩🏽‍💻 预算\t$17,431.29.\n\n".repeat(15) +
    "Correction: the ceiling is $18,001.07.  ",
};

describe("verbatim original evidence", () => {
  test("preserves every original code unit, including repeated paragraphs and late corrections", () => {
    const chunks = chunkRAGOriginalText(source, {
      maxCharacters: 120,
      overlapCharacters: 20,
    });
    const covered = new Set<number>();
    const graphemeBoundaries = new Set([
      0,
      ...[
        ...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(
          source.text,
        ),
      ].map((item) => item.index + item.segment.length),
    ]);
    for (const chunk of chunks) {
      const locator = chunk.metadata?.sourceLocator as RAGOriginalTextLocator;
      expect(readRAGOriginalText(source, locator, 120)).toBe(chunk.text);
      expect(graphemeBoundaries.has(locator.start)).toBe(true);
      expect(graphemeBoundaries.has(locator.end)).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(120);
      for (let i = locator.start; i < locator.end; i++) covered.add(i);
    }
    expect(covered.size).toBe(source.text.length);
    expect(chunks.at(-1)?.text).toContain("$18,001.07");
    expect(new Set(chunks.map((chunk) => chunk.chunkId)).size).toBe(
      chunks.length,
    );
    expect(
      chunkRAGOriginalText(source, {
        maxCharacters: 120,
        overlapCharacters: 20,
      }),
    ).toEqual(chunks);
  });
  test("citation rejects another owner/version and invalid or excessive ranges", () => {
    const locator = {
      sourceId: source.sourceId,
      version: source.version,
      start: 0,
      end: 10,
    };
    for (const modified of [
      { ...locator, sourceId: "member/b/intake" },
      { ...locator, version: "sha256:replacement" },
      { ...locator, start: -1 },
      { ...locator, end: source.text.length + 1 },
      { ...locator, end: 0 },
      { ...locator, start: 0.1 },
    ])
      expect(() => readRAGOriginalText(source, modified)).toThrow();
    expect(() => readRAGOriginalText(source, locator, 5)).toThrow();
    const emoji = source.text.indexOf("👩");
    expect(() =>
      readRAGOriginalText(source, {
        ...locator,
        start: emoji + 1,
        end: emoji + 2,
      }),
    ).toThrow();
  });
  test("identity encoding is unambiguous and source locator cannot be overridden", () => {
    const a = chunkRAGOriginalText(
      { sourceId: "a:b", version: "c", text: "fact" },
      { metadata: { sourceLocator: "forged" } },
    );
    const b = chunkRAGOriginalText({
      sourceId: "a",
      version: "b:c",
      text: "fact",
    });
    expect(a[0]?.chunkId).not.toBe(b[0]?.chunkId);
    expect(a[0]?.metadata?.sourceLocator).toEqual({
      sourceId: "a:b",
      version: "c",
      start: 0,
      end: 4,
    });
  });
  test("empty originals and invalid chunk settings terminate explicitly", () => {
    expect(chunkRAGOriginalText({ ...source, text: "" })).toEqual([]);
    for (const maxCharacters of [0, -1, NaN, Infinity, 1.1])
      expect(() => chunkRAGOriginalText(source, { maxCharacters })).toThrow();
    expect(() =>
      chunkRAGOriginalText(source, {
        maxCharacters: 10,
        overlapCharacters: 10,
      }),
    ).toThrow();
    expect(() =>
      chunkRAGOriginalText({ ...source, text: "👩🏽‍💻" }, { maxCharacters: 2 }),
    ).toThrow();
    expect(() => chunkRAGOriginalText({ ...source, version: "" })).toThrow();
  });
});
