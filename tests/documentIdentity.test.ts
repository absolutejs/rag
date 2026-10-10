import { expect, test } from "bun:test";
import { buildRAGUpsertInputFromUploads, prepareRAGDocument } from "../src/ingestion/ingestion";

test("long artifact sources, revisions and page suffixes retain distinct stable chunk identities", async () => {
  const prefix = "artifact:18d398b3-c40f-4735-9251-bb5e91cb68b6:revision:";
  const sources = [`${prefix}1:content`, `${prefix}1:asset:html`, `${prefix}1:asset:pdf#page=1`, `${prefix}1:asset:pdf#page=2`, `${prefix}2:content`];
  const input = { uploads: sources.map(source => ({ source, name: "evidence.txt", content: `Evidence for ${source}`, encoding: "utf8" as const })) };
  const first = await buildRAGUpsertInputFromUploads(input);
  const second = await buildRAGUpsertInputFromUploads(input);
  expect(first.chunks).toHaveLength(sources.length);
  expect(new Set(first.chunks.map(chunk => chunk.chunkId)).size).toBe(sources.length);
  expect(second.chunks.map(chunk => chunk.chunkId)).toEqual(first.chunks.map(chunk => chunk.chunkId));
});

test("lossy punctuation, case, Unicode and common text prefixes cannot collapse document IDs", () => {
  const sources = ["a/b", "a-b", "A/B", "資料一", "資料二"];
  const ids = sources.map(source => prepareRAGDocument({ source, text: "Evidence" }).documentId);
  expect(new Set(ids).size).toBe(sources.length);
  const prefix = "Shared introductory text. ".repeat(10);
  expect(prepareRAGDocument({ text: `${prefix}First document` }).documentId)
    .not.toBe(prepareRAGDocument({ text: `${prefix}Second document` }).documentId);
});

test("explicit document IDs remain caller-owned and source identity survives content edits", () => {
  expect(prepareRAGDocument({ id: "customer-source", text: "One" }).chunks[0]?.chunkId).toBe("customer-source:001");
  expect(prepareRAGDocument({ source: "same/source", text: "One" }).documentId)
    .toBe(prepareRAGDocument({ source: "same/source", text: "Two" }).documentId);
});
