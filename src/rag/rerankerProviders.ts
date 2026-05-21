import type {
  RAGQueryResult,
  RAGRerankerInput,
  RAGRerankerProvider,
} from "@absolutejs/ai";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit | BunFetchRequestInit,
) => Promise<Response>;

/** A vendor rerank API response row: an index into the submitted documents + a score. */
type VendorRerankRow = {
  index: number;
  relevance_score?: number;
  relevanceScore?: number;
  score?: number;
};

type VendorRerankResponse = {
  results?: VendorRerankRow[];
  data?: VendorRerankRow[];
};

const rowScore = (row: VendorRerankRow): number =>
  row.relevance_score ?? row.relevanceScore ?? row.score ?? 0;

const applyRanking = (
  candidates: RAGQueryResult[],
  rows: VendorRerankRow[],
  topK: number,
): RAGQueryResult[] => {
  const ranked: RAGQueryResult[] = [];
  for (const row of rows) {
    const candidate = candidates[row.index];
    if (!candidate) continue;
    ranked.push({ ...candidate, score: rowScore(row) });
  }
  ranked.sort((left, right) => right.score - left.score);
  return ranked.slice(0, topK);
};

const limitCandidates = (input: RAGRerankerInput): RAGQueryResult[] => {
  const cap = input.candidateTopK ?? input.results.length;
  return input.results.slice(0, Math.max(0, cap));
};

export type CrossEncoderRerankerConfig = {
  apiKey: string;
  defaultModel?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Extra headers (e.g. API version) merged into the request. */
  headers?: Record<string, string>;
};

type HttpCrossEncoderRerankerOptions = {
  config: CrossEncoderRerankerConfig;
  providerName: string;
  fallbackModel: string;
  endpoint: string;
  buildBody: (params: {
    model: string;
    query: string;
    documents: string[];
    topN: number;
  }) => Record<string, unknown>;
};

const createHttpCrossEncoderReranker = (
  options: HttpCrossEncoderRerankerOptions,
): RAGRerankerProvider => {
  const fetchImpl = options.config.fetch ?? fetch;
  const defaultModel = options.config.defaultModel ?? options.fallbackModel;

  return {
    defaultModel,
    providerName: options.providerName,
    rerank: async (input: RAGRerankerInput): Promise<RAGQueryResult[]> => {
      const candidates = limitCandidates(input);
      if (candidates.length === 0) return [];
      const model = input.model ?? defaultModel;
      const documents = candidates.map((candidate) => candidate.chunkText);
      const topN = Math.min(input.topK, candidates.length);
      const response = await fetchImpl(options.endpoint, {
        body: JSON.stringify(
          options.buildBody({ documents, model, query: input.query, topN }),
        ),
        headers: {
          Authorization: `Bearer ${options.config.apiKey}`,
          "Content-Type": "application/json",
          ...options.config.headers,
        },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(
          `${options.providerName} rerank failed: HTTP ${response.status}`,
        );
      }
      const payload = (await response.json()) as VendorRerankResponse;
      const rows = payload.results ?? payload.data ?? [];
      const ranked = applyRanking(candidates, rows, input.topK);
      if (input.scoreThreshold !== undefined) {
        return ranked.filter((result) => result.score >= input.scoreThreshold!);
      }
      return ranked;
    },
  };
};

export const createCohereRAGReranker = (
  config: CrossEncoderRerankerConfig,
): RAGRerankerProvider =>
  createHttpCrossEncoderReranker({
    buildBody: ({ model, query, documents, topN }) => ({
      documents,
      model,
      query,
      top_n: topN,
    }),
    config,
    endpoint: `${config.baseUrl ?? "https://api.cohere.com"}/v2/rerank`,
    fallbackModel: "rerank-v3.5",
    providerName: "cohere",
  });

export const createVoyageRAGReranker = (
  config: CrossEncoderRerankerConfig,
): RAGRerankerProvider =>
  createHttpCrossEncoderReranker({
    buildBody: ({ model, query, documents, topN }) => ({
      documents,
      model,
      query,
      top_k: topN,
    }),
    config,
    endpoint: `${config.baseUrl ?? "https://api.voyageai.com"}/v1/rerank`,
    fallbackModel: "rerank-2",
    providerName: "voyage",
  });

export const createJinaRAGReranker = (
  config: CrossEncoderRerankerConfig,
): RAGRerankerProvider =>
  createHttpCrossEncoderReranker({
    buildBody: ({ model, query, documents, topN }) => ({
      documents,
      model,
      query,
      top_n: topN,
    }),
    config,
    endpoint: `${config.baseUrl ?? "https://api.jina.ai"}/v1/rerank`,
    fallbackModel: "jina-reranker-v2-base-multilingual",
    providerName: "jina",
  });
