import { describe, expect, it } from "bun:test";
import {
  createRAGCollection,
  ingestRAGSource,
  removeRAGSource,
} from "../src/index";
import { createInMemoryRAGStore } from "../src/adapters/inMemory";
import type {
  RAGEmbeddingInput,
  RAGEmbeddingKind,
  RAGVectorDeleteInput,
  RAGVectorStore,
} from "../types/engine";

// Asymmetric embedder: records the `kind` it is called with so the test can
// prove ingest embeds with the "passage" kind and search embeds with "query".
// Vectors are deterministic on whether the text mentions the target keyword.
const createTrackingEmbedder = () => {
  const kinds: RAGEmbeddingKind[] = [];
  const embed = (input: RAGEmbeddingInput) => {
    kinds.push(input.kind ?? "query");
    const matches = input.text.toLowerCase().includes("aurora");

    return Promise.resolve(matches ? [1, 0] : [0, 1]);
  };

  return { embed, kinds };
};

const MULTI_CHUNK_TEXT = [
  "Aurora launch packet alpha covers the staging rollout in detail.",
  "Aurora launch packet beta covers the production cutover in detail.",
  "Aurora launch packet gamma covers the rollback contingency in detail.",
  "Aurora launch packet delta covers the post-incident review in detail.",
].join("\n\n");

describe("ingestSource / removeSource", () => {
  it("ingests a multi-chunk source, searches it, removes it, and replaces on re-ingest", async () => {
    const tracker = createTrackingEmbedder();
    const store = createInMemoryRAGStore({ dimensions: 2 });
    const collection = createRAGCollection({
      defaultTopK: 10,
      embedding: tracker.embed,
      store,
    });

    const ingested = await ingestRAGSource(collection, {
      chunking: { chunkOverlap: 0, maxChunkLength: 60 },
      document: { text: MULTI_CHUNK_TEXT },
      sourceId: "packet-1",
    });

    // Multi-chunk + deterministic, source-derived ids.
    expect(ingested.sourceId).toBe("packet-1");
    expect(ingested.chunkCount).toBeGreaterThan(1);
    expect(ingested.chunkIds).toEqual(
      Array.from({ length: ingested.chunkCount }, (_u, i) => `packet-1#${i}`),
    );

    // Every chunk was embedded with the passage kind (asymmetric ingest).
    expect(tracker.kinds.length).toBe(ingested.chunkCount);
    expect(tracker.kinds.every((kind) => kind === "passage")).toBe(true);

    const beforeRemove = await collection.search({ query: "aurora packet" });
    expect(beforeRemove.length).toBe(ingested.chunkCount);
    expect(beforeRemove.every((r) => r.chunkId.startsWith("packet-1#"))).toBe(
      true,
    );
    // Search embedded the query with the query kind.
    expect(tracker.kinds.at(-1)).toBe("query");

    const removed = await removeRAGSource(collection, {
      chunkCount: ingested.chunkCount,
      sourceId: "packet-1",
    });
    expect(removed.deleted).toBe(ingested.chunkCount);

    const afterRemove = await collection.search({ query: "aurora packet" });
    expect(afterRemove.length).toBe(0);

    // Re-ingest with a smaller source -> replaces, chunk count shrinks.
    const reingested = await ingestRAGSource(collection, {
      chunking: { chunkOverlap: 0, maxChunkLength: 60 },
      document: { text: "Aurora launch packet alpha only." },
      sourceId: "packet-1",
    });
    expect(reingested.chunkCount).toBeLessThan(ingested.chunkCount);

    const afterReingest = await collection.search({ query: "aurora packet" });
    expect(afterReingest.length).toBe(reingested.chunkCount);
    expect(afterReingest.every((r) => r.chunkId.startsWith("packet-1#"))).toBe(
      true,
    );
  });

  it("removes by deterministic id set on stores that cannot metadata-filter-delete", async () => {
    const tracker = createTrackingEmbedder();
    const base = createInMemoryRAGStore({ dimensions: 2 });

    // Wrap the store to simulate serverless Pinecone: filter-deletes throw,
    // only id-based deletes are supported.
    const serverlessStore: RAGVectorStore = {
      ...base,
      delete: (input?: RAGVectorDeleteInput) => {
        if (input?.filter && Object.keys(input.filter).length > 0) {
          throw new Error("metadata filter delete is not supported");
        }

        return base.delete!(input);
      },
    };

    const collection = createRAGCollection({
      defaultTopK: 10,
      embedding: tracker.embed,
      store: serverlessStore,
    });

    const ingested = await ingestRAGSource(collection, {
      chunking: { chunkOverlap: 0, maxChunkLength: 60 },
      document: { text: MULTI_CHUNK_TEXT },
      sourceId: "packet-2",
    });
    expect(ingested.chunkCount).toBeGreaterThan(1);

    // Pass only chunkCount -> must reconstruct the deterministic id set.
    const removed = await removeRAGSource(collection, {
      chunkCount: ingested.chunkCount,
      sourceId: "packet-2",
    });
    expect(removed.deleted).toBe(ingested.chunkCount);

    const afterRemove = await collection.search({ query: "aurora packet" });
    expect(afterRemove.length).toBe(0);
  });
});
