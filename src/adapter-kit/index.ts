// Public surface for building @absolutejs/rag vector-store adapters: the shared
// vector primitives, query helpers, and contract types a store implementation
// needs. Kept on a dedicated `@absolutejs/rag/adapter-kit` sub-path so the root
// API stays app-facing while adapter packages depend on a single specifier.
export { createRAGVector, normalizeVector, querySimilarity } from "../adapters/utils";
export { matchesMetadataFilterRecord } from "../adapters/filtering";
export {
  planNativeCandidateSearchBackfillK,
  planNativeCandidateSearchK,
  resolveAdaptiveNativeCandidateLimit,
  summarizeSQLiteCandidateCoverage,
} from "../adapters/queryPlanning";
export { rankRAGLexicalMatches } from "../retrieval/lexical";
export { createRAGCollection } from "../retrieval/collection";
export { ragChat, ragChat as ragPlugin } from "../chat/chat";
export {
  RAG_NATIVE_QUERY_CANDIDATE_LIMIT,
  RAG_VECTOR_DIMENSIONS_DEFAULT,
} from "../constants";
export type {
  RAGBackendCapabilities,
  RAGCollection,
  RAGEmbeddingInput,
  RAGLexicalQueryInput,
  RAGPostgresNativeDiagnostics,
  RAGQueryInput,
  RAGQueryResult,
  RAGSQLiteNativeDiagnostics,
  RAGUpsertInput,
  RAGVectorCountInput,
  RAGVectorDeleteInput,
  RAGVectorStore,
  RAGVectorStoreStatus,
  SQLiteVecResolution,
} from "@absolutejs/ai";
