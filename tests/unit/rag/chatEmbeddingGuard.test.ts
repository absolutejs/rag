import { describe, expect, it } from "bun:test";
import { ragChat } from "../../../src/rag/chat";
import { createInMemoryRAGStore } from "../../../src/rag/adapters/inMemory";
import { createRAGCollection } from "../../../src/rag/collection";
import { openaiEmbeddings } from "../../../src/rag/embeddingProviders";

const provider = () => ({
  async *stream() {},
});

describe("ragChat embedding model guard", () => {
  // The colleague's exact misconfiguration: an OpenAI embedding provider with no
  // defaultModel and no top-level embeddingModel. Previously this silently fell
  // back to the chat model, 404'd against OpenAI, and hung the WebSocket.
  it("throws at construction when an embedding provider has no resolvable model", () => {
    expect(() =>
      ragChat({
        embedding: openaiEmbeddings({ apiKey: "test-key" }),
        provider,
        ragStore: createInMemoryRAGStore({ dimensions: 2 }),
      }),
    ).toThrow(/embedding model/i);
  });

  it("does not throw when embeddingModel is provided", () => {
    expect(() =>
      ragChat({
        embedding: openaiEmbeddings({ apiKey: "test-key" }),
        embeddingModel: "text-embedding-3-small",
        provider,
        ragStore: createInMemoryRAGStore({ dimensions: 2 }),
      }),
    ).not.toThrow();
  });

  it("does not throw when the provider supplies its own default model", () => {
    expect(() =>
      ragChat({
        embedding: openaiEmbeddings({
          apiKey: "test-key",
          defaultModel: "text-embedding-3-small",
        }),
        provider,
        ragStore: createInMemoryRAGStore({ dimensions: 2 }),
      }),
    ).not.toThrow();
  });

  it("does not throw for a pre-built collection without an embedding model", () => {
    const collection = createRAGCollection({
      store: createInMemoryRAGStore({ dimensions: 2 }),
    });

    expect(() => ragChat({ collection, provider })).not.toThrow();
  });

  it("does not throw when retrieval is disabled (no ragStore or collection)", () => {
    expect(() => ragChat({ provider })).not.toThrow();
  });

  it("does not throw when relying on a store-supplied embed() and no provider", () => {
    expect(() =>
      ragChat({
        provider,
        ragStore: createInMemoryRAGStore({ dimensions: 2 }),
      }),
    ).not.toThrow();
  });
});
