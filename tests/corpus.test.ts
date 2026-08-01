import { describe, expect, test } from "bun:test";
import {
  corpusTextHash,
  planRAGCorpus,
  reconcileRAGCorpus,
  type RAGCorpusRecord,
  type RAGCorpusStore,
} from "../src/retrieval/corpus";

const memoryStore = (seed: Record<string, RAGCorpusRecord[]> = {}) => {
  const byOwner = new Map<string, Map<string, string>>(
    Object.entries(seed).map(([owner, records]) => [
      owner,
      new Map(records.map((r) => [r.chunkId, r.textHash])),
    ]),
  );
  const store: RAGCorpusStore = {
    forget: (owner, chunkIds) => {
      const bucket = byOwner.get(owner);
      for (const id of chunkIds) bucket?.delete(id);
    },
    list: (owner) =>
      [...(byOwner.get(owner) ?? new Map()).entries()].map(
        ([chunkId, textHash]) => ({ chunkId, textHash }),
      ),
    remember: (owner, records) => {
      const bucket = byOwner.get(owner) ?? new Map<string, string>();
      for (const r of records) bucket.set(r.chunkId, r.textHash);
      byOwner.set(owner, bucket);
    },
  };

  return { byOwner, store };
};

const recorder = () => {
  const embedded: string[][] = [];
  const removed: string[][] = [];

  return {
    apply: {
      embed: (docs: { chunkId: string }[]) => {
        embedded.push(docs.map((d) => d.chunkId));

        return docs.length;
      },
      remove: (ids: string[]) => {
        removed.push(ids);
      },
    },
    embedded,
    removed,
  };
};

describe("planRAGCorpus", () => {
  test("classifies new, changed, unchanged and removed in one pass", async () => {
    const hash = await corpusTextHash("same");
    const { store } = memoryStore({
      alice: [
        { chunkId: "keep", textHash: hash },
        { chunkId: "changed", textHash: "stale" },
        { chunkId: "gone", textHash: "whatever" },
      ],
    });
    const plan = await planRAGCorpus(store, "alice", [
      { chunkId: "keep", text: "same" },
      { chunkId: "changed", text: "now different" },
      { chunkId: "brand-new", text: "hello" },
    ]);

    expect(plan.unchanged).toBe(1);
    expect(plan.embed.map((d) => d.chunkId).sort()).toEqual([
      "brand-new",
      "changed",
    ]);
    expect(plan.remove).toEqual(["gone"]);
  });

  test("owners are isolated — one owner's chunks are never another's removals", async () => {
    const { store } = memoryStore({
      alice: [{ chunkId: "a1", textHash: "x" }],
      bob: [{ chunkId: "b1", textHash: "y" }],
    });
    const plan = await planRAGCorpus(store, "alice", []);

    expect(plan.remove).toEqual(["a1"]);
  });

  test("a duplicate chunkId in desired is collapsed, first wins", async () => {
    const { store } = memoryStore();
    const plan = await planRAGCorpus(store, "alice", [
      { chunkId: "dup", text: "first" },
      { chunkId: "dup", text: "second" },
    ]);

    expect(plan.embed.length).toBe(1);
    expect(plan.embed[0]?.text).toBe("first");
  });

  test("planning is pure — it neither embeds nor forgets", async () => {
    const { byOwner, store } = memoryStore({
      alice: [{ chunkId: "gone", textHash: "x" }],
    });
    await planRAGCorpus(store, "alice", []);

    expect(byOwner.get("alice")?.has("gone")).toBe(true);
  });
});

describe("reconcileRAGCorpus", () => {
  test("embeds the changed, deletes the orphaned, skips the identical", async () => {
    const hash = await corpusTextHash("same");
    const { byOwner, store } = memoryStore({
      alice: [
        { chunkId: "keep", textHash: hash },
        { chunkId: "orphan", textHash: "x" },
      ],
    });
    const { apply, embedded, removed } = recorder();
    const result = await reconcileRAGCorpus(store, "alice", [
      { chunkId: "keep", text: "same" },
      { chunkId: "fresh", text: "new text" },
    ], apply);

    expect(result).toEqual({ embedded: 1, removed: 1, unchanged: 1 });
    expect(embedded).toEqual([["fresh"]]);
    expect(removed).toEqual([["orphan"]]);
    expect(byOwner.get("alice")?.has("orphan")).toBe(false);
    expect(byOwner.get("alice")?.has("fresh")).toBe(true);
  });

  test("deleting happens BEFORE forgetting, so a crash cannot strand a vector", async () => {
    const order: string[] = [];
    const { store } = memoryStore({ alice: [{ chunkId: "x", textHash: "h" }] });
    const wrapped: RAGCorpusStore = {
      ...store,
      forget: async (owner, ids) => {
        order.push("forget");

        return store.forget(owner, ids);
      },
    };
    await reconcileRAGCorpus(wrapped, "alice", [], {
      embed: () => 0,
      remove: () => {
        order.push("remove-vectors");
      },
    });

    expect(order).toEqual(["remove-vectors", "forget"]);
  });

  test("a failed vector delete leaves the record, so the next pass retries", async () => {
    const { byOwner, store } = memoryStore({
      alice: [{ chunkId: "x", textHash: "h" }],
    });
    await expect(
      reconcileRAGCorpus(store, "alice", [], {
        embed: () => 0,
        remove: () => {
          throw new Error("pinecone down");
        },
      }),
    ).rejects.toThrow("pinecone down");
    // Still recorded — so it is still addressable and will be retried.
    expect(byOwner.get("alice")?.has("x")).toBe(true);
  });

  test("a second identical run is free", async () => {
    const { store } = memoryStore();
    const docs = [{ chunkId: "a", text: "one" }, { chunkId: "b", text: "two" }];
    const first = recorder();
    await reconcileRAGCorpus(store, "alice", docs, first.apply);
    const second = recorder();
    const result = await reconcileRAGCorpus(store, "alice", docs, second.apply);

    expect(result).toEqual({ embedded: 0, removed: 0, unchanged: 2 });
    expect(second.embedded).toEqual([]);
  });
});
