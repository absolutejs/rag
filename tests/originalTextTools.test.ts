import { describe, expect, test } from "bun:test";
import { createRAGOriginalTextTools } from "../src/retrieval/originalTextTools";
import {
  chunkRAGOriginalText,
  type RAGOriginalText,
} from "../src/ingestion/originalText";
import { createRAGCollection } from "../src/retrieval/collection";
import { createInMemoryRAGStore } from "../src/adapters/inMemory";

const documents: RAGOriginalText[] = [
  {
    sourceId: "orion",
    version: "v1",
    text: "Our spending ceiling is $17,431.29. The identifier is OR-9021.",
  },
  {
    sourceId: "correction",
    version: "v1",
    text: "Correction to Orion's budget: $18,001.07 replaces the previous ceiling.",
  },
  {
    sourceId: "private",
    version: "v1",
    text: "Private owner's Orion budget is $999,999.",
  },
];

const setup = async (maxTokens = 2000) => {
  // Deterministic semantic oracle tests retrieval plumbing, not live embedding quality.
  const store = createInMemoryRAGStore({
    dimensions: 2,
    mockEmbedding: async (text) =>
      /budget|ceiling/i.test(text) ? [1, 0] : [0, 1],
  });
  const collection = createRAGCollection({ store });
  await collection.ingest({
    chunks: documents.flatMap((document) =>
      chunkRAGOriginalText(document, {
        metadata: { owner: document.sourceId === "private" ? "b" : "a" },
      }),
    ),
  });
  const calls: string[] = [];
  const vector = store.query;
  const lexical = store.queryLexical!;
  store.query = (input) => {
    calls.push("vector");
    return vector(input);
  };
  store.queryLexical = (input) => {
    calls.push("lexical");
    return lexical(input);
  };
  const traces: string[] = [];
  const tools = createRAGOriginalTextTools({
    collection,
    filter: { owner: "a" },
    loadSource: async (id, version) =>
      documents.find(
        (document) =>
          document.sourceId !== "private" &&
          document.sourceId === id &&
          document.version === version,
      ) ?? null,
    budget: { maxTokens, countTokens: async (text) => text.length },
    onTrace: (trace) => {
      traces.push(trace.mode);
    },
  });
  return { tools, calls, traces };
};

describe("hybrid source evidence tools", () => {
  test("combines semantic synonym and lexical correction evidence with exact original reads", async () => {
    const { tools, calls, traces } = await setup();
    const result = JSON.parse(
      await tools.search_text_source!.handler({ query: "budget" }),
    );
    expect(calls.sort()).toEqual(["lexical", "vector"]);
    expect(traces).toEqual(["hybrid"]);
    expect(
      result.passages.map((passage: any) => passage.sourceId).sort(),
    ).toEqual(["correction", "orion"]);
    for (const passage of result.passages) {
      const read = JSON.parse(await tools.read_text_source!.handler(passage));
      expect(read.passage.text).toBe(
        documents.find((document) => document.sourceId === passage.sourceId)!
          .text,
      );
    }
  });
  test("source constraints cannot replace ownership and exact reads reauthorize", async () => {
    const { tools } = await setup();
    const result = JSON.parse(
      await tools.search_text_source!.handler({
        query: "budget",
        sourceId: "private",
        filter: { owner: "b" },
      }),
    );
    expect(result.passages).toEqual([]);
    expect(
      await tools.read_text_source!.handler({
        sourceId: "private",
        version: "v1",
        start: 0,
        end: 10,
      }),
    ).toBe("This source version is unavailable.");
    expect(
      await tools.read_text_source!.handler({
        sourceId: "orion",
        version: "v2",
        start: 0,
        end: 10,
      }),
    ).toBe("This source version is unavailable.");
  });
  test("evidence respects the caller's tokenizer budget without truncating originals", async () => {
    const { tools } = await setup(310);
    const text = await tools.search_text_source!.handler({ query: "budget" });
    expect(text.length).toBeLessThanOrEqual(310);
    const result = JSON.parse(text);
    expect(result.budgetLimited).toBe(true);
    expect(result.passages.length).toBe(1);
    expect(result.passages[0].text).toBe(
      documents.find((doc) => doc.sourceId === result.passages[0].sourceId)!
        .text,
    );
  });
  test("does not trust index text as original evidence", async () => {
    const store = createInMemoryRAGStore({
      dimensions: 2,
      mockEmbedding: async () => [1, 0],
    });
    const collection = createRAGCollection({ store });
    const chunks = chunkRAGOriginalText(documents[0]!, {
      metadata: { owner: "a" },
    });
    chunks[0]!.text = "Injected index-only claim: budget is $0.";
    await collection.ingest({ chunks });
    const tools = createRAGOriginalTextTools({
      collection,
      filter: { owner: "a" },
      loadSource: async () => documents[0]!,
      budget: { maxTokens: 2000, countTokens: async (text) => text.length },
    });
    const result = JSON.parse(
      await tools.search_text_source!.handler({ query: "budget" }),
    );
    expect(result.passages[0].text).toBe(documents[0]!.text);
    expect(result.passages[0].text).not.toContain("$0");
  });
});
