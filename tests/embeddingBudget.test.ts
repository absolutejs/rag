import { describe, expect, test } from "bun:test";
import {
  embeddingCacheKey,
  isEmbeddingQuotaError,
  withEmbeddingBudget,
  type RAGEmbeddingCache,
} from "../src/retrieval/embeddingBudget";

const memoryCache = (): RAGEmbeddingCache & { size: () => number } => {
  const store = new Map<string, number[]>();

  return {
    get: (key) => store.get(key) ?? null,
    set: (key, embedding) => {
      store.set(key, embedding);
    },
    size: () => store.size,
  };
};

describe("withEmbeddingBudget caching", () => {
  test("identical text is embedded once and reused after", async () => {
    let calls = 0;
    const cache = memoryCache();
    const embedder = withEmbeddingBudget(
      () => {
        calls += 1;

        return Promise.resolve([1, 2, 3]);
      },
      { cache },
    );
    await embedder.embed({ text: "hello" });
    await embedder.embed({ text: "hello" });
    await embedder.embed({ text: "hello" });
    expect(calls).toBe(1);
    expect(embedder.health()).toMatchObject({ embedded: 1, reused: 2 });
  });

  test("different text still costs an embed", async () => {
    let calls = 0;
    const embedder = withEmbeddingBudget(
      () => {
        calls += 1;

        return Promise.resolve([1]);
      },
      { cache: memoryCache() },
    );
    await embedder.embed({ text: "a" });
    await embedder.embed({ text: "b" });
    expect(calls).toBe(2);
  });

  test("a passage and a query never share a cache entry", async () => {
    const passage = await embeddingCacheKey("same", "m", "passage");
    const query = await embeddingCacheKey("same", "m", "query");
    expect(passage).not.toBe(query);
  });

  test("the key changes with the model", async () => {
    expect(await embeddingCacheKey("t", "model-a")).not.toBe(
      await embeddingCacheKey("t", "model-b"),
    );
  });

  test("works with no cache configured", async () => {
    let calls = 0;
    const embedder = withEmbeddingBudget(() => {
      calls += 1;

      return Promise.resolve([1]);
    });
    await embedder.embed({ text: "x" });
    await embedder.embed({ text: "x" });
    expect(calls).toBe(2);
    expect(embedder.health().reused).toBe(0);
  });
});

describe("quota exhaustion", () => {
  test("recognises the providers' out-of-allowance messages", () => {
    expect(
      isEmbeddingQuotaError(
        new Error("RESOURCE_EXHAUSTED: reached the embedding token limit"),
      ),
    ).toBe(true);
    expect(isEmbeddingQuotaError(new Error("insufficient_quota"))).toBe(true);
    expect(isEmbeddingQuotaError(new Error("connection reset"))).toBe(false);
  });

  test("exposes exhaustion and fires the alert once", async () => {
    let alerts = 0;
    const embedder = withEmbeddingBudget(
      () => Promise.reject(new Error("RESOURCE_EXHAUSTED: token limit")),
      {
        onQuotaExhausted: () => {
          alerts += 1;
        },
      },
    );
    await expect(embedder.embed({ text: "a" })).rejects.toThrow();
    await expect(embedder.embed({ text: "b" })).rejects.toThrow();
    expect(alerts).toBe(1);
    expect(embedder.health().quotaExhaustedAt).toBeInstanceOf(Date);
  });

  test("a transient failure is reported but not treated as exhaustion", async () => {
    const embedder = withEmbeddingBudget(() =>
      Promise.reject(new Error("socket hang up")),
    );
    await expect(embedder.embed({ text: "a" })).rejects.toThrow();
    const health = embedder.health();
    expect(health.quotaExhaustedAt).toBeNull();
    expect(health.lastError).toBe("socket hang up");
  });

  test("a later success clears the last error", async () => {
    let fail = true;
    const embedder = withEmbeddingBudget(() =>
      fail ? Promise.reject(new Error("blip")) : Promise.resolve([1]),
    );
    await expect(embedder.embed({ text: "a" })).rejects.toThrow();
    fail = false;
    await embedder.embed({ text: "a" });
    expect(embedder.health().lastError).toBeNull();
  });
});
