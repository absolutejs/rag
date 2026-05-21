// Core RAG shapes plus convenience aliases over @absolutejs/ai types.

import type {
  RAGDocumentChunk,
  RAGQueryInput,
  RAGUpsertInput,
} from "@absolutejs/ai";

export type InternalRAGStoredChunk = RAGDocumentChunk & {
  vector: number[];
  sourceId: string;
};

export type RAGDocumentBatch = RAGUpsertInput;
export type RAGQueryParams = RAGQueryInput;
