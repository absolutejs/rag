import { afterAll, describe, expect, test } from "bun:test";
import { createPostgresRAGStore } from "@absolutejs/rag-postgres";
import { createRAGCollection } from "../src/retrieval/collection";
import { chunkRAGOriginalText } from "../src/ingestion/originalText";
import { createRAGOriginalTextTools } from "../src/retrieval/originalTextTools";

const url = process.env.RAG_POSTGRES_TEST_URL;
const suite = url ? describe : describe.skip;

suite("persistent intake evidence with PostgreSQL", () => {
  const tableName = `intake_evidence_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const db = url ? new Bun.SQL(url) : undefined;
  const sources = [
    {
      sourceId: "a:original",
      version: "v1",
      text: "Our spending ceiling is $17,431.29.\r\nExact ID: OR-9021.",
    },
    {
      sourceId: "a:correction",
      version: "v2",
      text: "Correction: the budget is $18,001.07, replacing $17,431.29.",
    },
    {
      sourceId: "b:private",
      version: "v1",
      text: "The budget is private: $888,888.",
    },
  ];
  afterAll(async () => {
    if (db) {
      await db.unsafe(`DROP TABLE IF EXISTS "${tableName}"`);
      await db.close();
    }
  });
  test("reopens indexed evidence, executes both channels and enforces scope/deletion", async () => {
    const store = () =>
      createPostgresRAGStore({
        sql: db!,
        tableName,
        dimensions: 2,
        indexType: "none",
        mockEmbedding: async () => [1, 0],
      });
    const writer = createRAGCollection({ store: store() });
    await writer.ingest({
      chunks: sources.flatMap((source) =>
        chunkRAGOriginalText(source, {
          metadata: {
            owner: source.sourceId.startsWith("a:") ? "a" : "b",
            intake: "active",
          },
        }),
      ),
    });
    const reopened = store();
    const channels: string[] = [];
    const query = reopened.query;
    const lexical = reopened.queryLexical!;
    reopened.query = (input) => {
      channels.push("vector");
      return query(input);
    };
    reopened.queryLexical = (input) => {
      channels.push("lexical");
      return lexical(input);
    };
    const tools = createRAGOriginalTextTools({
      collection: createRAGCollection({ store: reopened }),
      filter: { owner: "a", intake: "active" },
      loadSource: async (id, version) =>
        sources.find(
          (source) =>
            source.sourceId.startsWith("a:") &&
            source.sourceId === id &&
            source.version === version,
        ) ?? null,
      budget: { maxTokens: 4000, countTokens: async (text) => text.length },
    });
    const found = JSON.parse(
      await tools.search_text_source!.handler({ query: "budget" }),
    );
    expect(channels.sort()).toEqual(["lexical", "vector"]);
    expect(
      found.passages.map((passage: any) => passage.sourceId).sort(),
    ).toEqual(["a:correction", "a:original"]);
    for (const passage of found.passages) {
      expect(
        JSON.parse(await tools.read_text_source!.handler(passage)).passage.text,
      ).toBe(
        sources.find((source) => source.sourceId === passage.sourceId)!.text,
      );
    }
    expect(
      await reopened.delete!({ filter: { owner: "a", source: "a:original" } }),
    ).toBe(1);
    const remaining = JSON.parse(
      await tools.search_text_source!.handler({ query: "budget" }),
    );
    expect(remaining.passages.map((passage: any) => passage.sourceId)).toEqual([
      "a:correction",
    ]);
    expect(await reopened.count!({ filter: { owner: "b" } })).toBe(1);
  });
});
