import { describe, expect, it } from "bun:test";
import {
  createCohereRAGReranker,
  createJinaRAGReranker,
  createVoyageRAGReranker,
} from "../../../../src/ai/rag/rerankerProviders";
import type { RAGQueryResult, RAGRerankerInput } from "@absolutejs/ai";

type CapturedRequest = { url: string; body: Record<string, unknown> };

const createFetch = (
  body: unknown,
  captured: CapturedRequest[],
  ok = true,
): typeof fetch =>
  Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        body: JSON.parse(String(init?.body ?? "{}")),
        url: String(input),
      });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: ok ? 200 : 500,
        }),
      ) as ReturnType<typeof fetch>;
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;

const candidate = (chunkId: string, text: string): RAGQueryResult => ({
  chunkId,
  chunkText: text,
  score: 0,
});

const input = (results: RAGQueryResult[], topK = 2): RAGRerankerInput => ({
  query: "how do I reset my password",
  queryVector: [],
  results,
  topK,
});

describe("vendor cross-encoder rerankers", () => {
  it("Cohere: posts to /v2/rerank with top_n and re-sorts by relevance", async () => {
    const captured: CapturedRequest[] = [];
    const reranker = createCohereRAGReranker({
      apiKey: "key",
      fetch: createFetch(
        {
          results: [
            { index: 2, relevance_score: 0.95 },
            { index: 0, relevance_score: 0.4 },
            { index: 1, relevance_score: 0.1 },
          ],
        },
        captured,
      ),
    });
    const out = await reranker.rerank(
      input([
        candidate("a", "billing info"),
        candidate("b", "weather report"),
        candidate("c", "password reset steps"),
      ]),
    );
    expect(captured[0]?.url).toBe("https://api.cohere.com/v2/rerank");
    expect(captured[0]?.body.top_n).toBe(2);
    expect(captured[0]?.body.model).toBe("rerank-v3.5");
    expect(out.map((r) => r.chunkId)).toEqual(["c", "a"]);
    expect(out[0]?.score).toBe(0.95);
  });

  it("Voyage: uses top_k and the voyage endpoint + data[] response", async () => {
    const captured: CapturedRequest[] = [];
    const reranker = createVoyageRAGReranker({
      apiKey: "key",
      fetch: createFetch(
        {
          data: [
            { index: 1, relevance_score: 0.8 },
            { index: 0, relevance_score: 0.2 },
          ],
        },
        captured,
      ),
    });
    const out = await reranker.rerank(
      input([candidate("a", "one"), candidate("b", "two")]),
    );
    expect(captured[0]?.url).toBe("https://api.voyageai.com/v1/rerank");
    expect(captured[0]?.body.top_k).toBe(2);
    expect(out.map((r) => r.chunkId)).toEqual(["b", "a"]);
  });

  it("Jina: posts to the jina endpoint with default model", async () => {
    const captured: CapturedRequest[] = [];
    const reranker = createJinaRAGReranker({
      apiKey: "key",
      fetch: createFetch(
        { results: [{ index: 0, relevance_score: 0.7 }] },
        captured,
      ),
    });
    const out = await reranker.rerank(input([candidate("a", "doc")], 1));
    expect(captured[0]?.url).toBe("https://api.jina.ai/v1/rerank");
    expect(captured[0]?.body.model).toBe(
      "jina-reranker-v2-base-multilingual",
    );
    expect(out).toHaveLength(1);
  });

  it("respects candidateTopK to cap submitted documents", async () => {
    const captured: CapturedRequest[] = [];
    const reranker = createCohereRAGReranker({
      apiKey: "key",
      fetch: createFetch({ results: [{ index: 0, relevance_score: 1 }] }, captured),
    });
    await reranker.rerank({
      ...input(
        [
          candidate("a", "1"),
          candidate("b", "2"),
          candidate("c", "3"),
        ],
        1,
      ),
      candidateTopK: 2,
    });
    expect((captured[0]?.body.documents as string[]).length).toBe(2);
  });

  it("applies scoreThreshold filtering", async () => {
    const reranker = createCohereRAGReranker({
      apiKey: "key",
      fetch: createFetch(
        {
          results: [
            { index: 0, relevance_score: 0.9 },
            { index: 1, relevance_score: 0.2 },
          ],
        },
        [],
      ),
    });
    const out = await reranker.rerank({
      ...input([candidate("a", "x"), candidate("b", "y")]),
      scoreThreshold: 0.5,
    });
    expect(out.map((r) => r.chunkId)).toEqual(["a"]);
  });

  it("returns empty for no candidates and throws on HTTP error", async () => {
    const empty = createCohereRAGReranker({
      apiKey: "key",
      fetch: createFetch({ results: [] }, []),
    });
    expect(await empty.rerank(input([]))).toEqual([]);

    const failing = createCohereRAGReranker({
      apiKey: "key",
      fetch: createFetch({}, [], false),
    });
    await expect(
      failing.rerank(input([candidate("a", "x")])),
    ).rejects.toThrow(/cohere rerank failed/i);
  });

  it("exposes providerName + defaultModel metadata", () => {
    const reranker = createVoyageRAGReranker({ apiKey: "key" });
    expect(reranker.providerName).toBe("voyage");
    expect(reranker.defaultModel).toBe("rerank-2");
  });
});
