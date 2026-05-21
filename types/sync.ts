// Sync-source configuration shapes. The linked-connector option type is used by
// src/rag/sync.ts and re-exported on the package's main entry.

import type {
  RAGChunkingOptions,
  RAGChunkingRegistryLike,
  RAGConnectorRuntime,
  RAGFileExtractor,
  RAGFileExtractorRegistryLike,
  RAGLinkedProviderCredentialResolver,
  RAGLinkedProviderResolutionPurpose,
} from "@absolutejs/ai";

export type RAGLinkedConnectorSyncSourceOptions = {
  id: string;
  label: string;
  runtime: RAGConnectorRuntime;
  resolver: RAGLinkedProviderCredentialResolver;
  ownerRef: string;
  bindingId?: string;
  externalAccountId?: string;
  purpose?: RAGLinkedProviderResolutionPurpose;
  requiredScopes?: string[];
  minValidityMs?: number;
  description?: string;
  maxItemsPerRun?: number;
  baseMetadata?: Record<string, unknown>;
  defaultChunking?: RAGChunkingOptions;
  chunkingRegistry?: RAGChunkingRegistryLike;
  extractors?: RAGFileExtractor[];
  extractorRegistry?: RAGFileExtractorRegistryLike;
  metadata?: Record<string, unknown>;
  retryAttempts?: number;
  retryDelayMs?: number;
};
