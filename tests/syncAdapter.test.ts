import { describe, expect, it } from "bun:test";
import type { ViewDiff } from "@absolutejs/sync/engine";
import { createSyncRAGStore } from "../src/adapters/sync";

type Hit = { chunkId: string; chunkText: string };

describe("createSyncRAGStore", () => {
  it("vector query ranks by similarity (drop-in RAGVectorStore)", async () => {
    const store = createSyncRAGStore({
      mockEmbedding: async (text) =>
        text === "alpha" ? [1, 0] : text === "beta" ? [0, 1] : [0.5, 0.5],
    });
    await store.upsert({
      chunks: [
        { chunkId: "a", text: "alpha" },
        { chunkId: "b", text: "beta" },
      ],
    });

    const results = await store.query({ queryVector: [1, 0], topK: 2 });
    expect(results.map((result) => result.chunkId)).toEqual(["a", "b"]);
    expect(results[0]?.score ?? 0).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it("lexical query matches by text", async () => {
    const store = createSyncRAGStore();
    await store.upsert({
      chunks: [
        { chunkId: "1", text: "the quick brown fox" },
        { chunkId: "2", text: "lazy dogs sleep" },
      ],
    });

    const results =
      (await store.queryLexical?.({
        query: "quick fox",
        topK: 5,
      })) ?? [];
    expect(results.map((result) => result.chunkId)).toEqual(["1"]);
  });

  it("count and delete honor filters", async () => {
    const store = createSyncRAGStore();
    await store.upsert({
      chunks: [
        { chunkId: "a", metadata: { tenant: "acme" }, text: "alpha" },
        { chunkId: "b", metadata: { tenant: "beta" }, text: "beta" },
      ],
    });

    expect(await store.count?.()).toBe(2);
    expect(await store.count?.({ filter: { tenant: "acme" } })).toBe(1);
    expect(await store.delete?.({ chunkIds: ["a"] })).toBe(1);
    expect(await store.count?.()).toBe(1);
  });

  it("live retrieval: subscribers re-rank as the corpus changes", async () => {
    const store = createSyncRAGStore();
    const diffs: ViewDiff<Hit>[] = [];
    const sub = await store.engine.subscribe<Hit, string>({
      collection: store.retrievalCollection,
      ctx: {},
      onDiff: (diff) => {
        diffs.push(diff);
      },
      params: "quarterly revenue report",
    });
    expect(sub.initial).toEqual([]); // empty corpus

    // Ingesting a matching doc re-ranks the live collection for this query.
    await store.upsert({
      chunks: [
        {
          chunkId: "r1",
          text: "the quarterly revenue report shows strong growth",
          title: "Q3",
        },
      ],
    });
    expect((diffs.at(-1)?.added ?? []).map((row) => row.chunkId)).toContain(
      "r1",
    );

    // An unrelated doc never reaches this subscriber.
    const before = diffs.length;
    await store.upsert({
      chunks: [{ chunkId: "x", text: "a totally unrelated cooking recipe" }],
    });
    expect(diffs.length).toBe(before);

    sub.unsubscribe();
  });
});
