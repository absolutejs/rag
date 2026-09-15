import { describe, expect, test } from "bun:test";
import { createRAGCollection } from "../src/retrieval/collection";
import { createInMemoryRAGStore } from "../src/adapters/inMemory";
import { createHeuristicRAGRetrievalStrategy } from "../src/retrieval/retrievalStrategies";

describe("intake retrieval contracts", () => {
  for (const mode of ["hybrid", "lexical"] as const) {
    test(`${mode} rejects a backend without lexical search before embedding`, async () => {
      let embeddingCalls = 0;
      let vectorCalls = 0;
      const store = createInMemoryRAGStore({
        dimensions: 2,
        mockEmbedding: async () => {
          embeddingCalls++;
          return [1, 0];
        },
      });
      store.queryLexical = undefined;
      store.query = async () => {
        vectorCalls++;
        return [];
      };
      const collection = createRAGCollection({ store });
      await expect(
        collection.search({ query: "budget", retrieval: mode }),
      ).rejects.toThrow("requires a store with queryLexical");
      expect(embeddingCalls).toBe(0);
      expect(vectorCalls).toBe(0);
    });
  }

  for (const filter of [{ source: "intake/orion" }, { documentId: "orion" }]) {
    for (const mode of ["hybrid", "lexical"] as const) {
      test(`${mode} preserves both scope and requested channels for ${JSON.stringify(filter)}`, async () => {
        const calls: Array<{ channel: string; filter: unknown }> = [];
        const store = createInMemoryRAGStore({
          dimensions: 2,
          mockEmbedding: async () => [1, 0],
        });
        store.query = async (input) => {
          calls.push({ channel: "vector", filter: input.filter });
          return [
            {
              chunkId: "semantic",
              text: "Our spending ceiling is $17,431.29.",
              score: 0.9,
            },
          ];
        };
        store.queryLexical = async (input) => {
          calls.push({ channel: "lexical", filter: input.filter });
          return [
            {
              chunkId: "exact",
              text: "Corrected budget: $17,431.29.",
              score: 1,
            },
          ];
        };
        const collection = createRAGCollection({
          store,
          retrievalStrategy: createHeuristicRAGRetrievalStrategy(),
        });
        const result = await collection.searchWithTrace({
          query: "budget",
          filter,
          retrieval: mode,
          topK: 4,
        });
        expect(result.trace.mode).toBe(mode);
        expect(calls.map((call) => call.channel).sort()).toEqual(
          mode === "hybrid" ? ["lexical", "vector"] : ["lexical"],
        );
        expect(
          calls.every(
            (call) => JSON.stringify(call.filter) === JSON.stringify(filter),
          ),
        ).toBe(true);
        expect(result.results.some((item) => item.chunkId === "exact")).toBe(
          true,
        );
        if (mode === "hybrid")
          expect(
            result.results.some((item) => item.chunkId === "semantic"),
          ).toBe(true);
      });
    }
  }

  test("vector-only backends remain supported for explicit vector queries", async () => {
    const store = createInMemoryRAGStore({
      dimensions: 2,
      mockEmbedding: async () => [1, 0],
    });
    store.queryLexical = undefined;
    store.query = async () => [
      { chunkId: "hit", text: "Source fact", score: 1 },
    ];
    const result = await createRAGCollection({ store }).search({
      query: "fact",
      retrieval: "vector",
    });
    expect(result[0]?.chunkId).toBe("hit");
  });
});
