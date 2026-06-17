// Factory option shapes for the retrieval pipeline: collection, reranker, query
// transform, retrieval strategy, and embedding provider. Implementations in
// src/retrieval/*.ts
// import these.

import type {
  RAGEmbeddingFunction,
  RAGEmbeddingProviderLike,
  RAGQueryTransformer,
  RAGQueryTransformProviderLike,
  RAGReranker,
  RAGRerankerProviderLike,
  RAGRetrievalStrategyProviderLike,
  RAGVectorStore,
} from "./engine";

export type CreateRAGCollectionOptions = {
  store: RAGVectorStore;
  embedding?: RAGEmbeddingProviderLike;
  defaultTopK?: number;
  defaultCandidateMultiplier?: number;
  defaultModel?: string;
  queryTransform?: RAGQueryTransformProviderLike;
  retrievalStrategy?: RAGRetrievalStrategyProviderLike;
  rerank?: RAGRerankerProviderLike;
};

export type CreateRAGRerankerOptions = {
  rerank: RAGReranker;
  defaultModel?: string;
  providerName?: string;
};

export type HeuristicRAGRerankerOptions = {
  defaultModel?: string;
  providerName?: string;
};

export type CreateRAGQueryTransformOptions = {
  transform: RAGQueryTransformer;
  defaultModel?: string;
  providerName?: string;
};

export type HeuristicRAGQueryTransformOptions = {
  defaultModel?: string;
  providerName?: string;
};

export type HeuristicRAGRetrievalStrategyOptions = {
  providerName?: string;
  defaultLabel?: string;
};

export type CreateRAGEmbeddingProviderOptions = {
  embed: RAGEmbeddingFunction;
  dimensions?: number;
  defaultModel?: string;
};
