// Vector-store adapter configuration shapes that stay in the core. The Postgres
// and SQLite store implementations (and their option types) now live in their own
// adapter packages (@absolutejs/rag-postgres, @absolutejs/rag-sqlite); only the
// zero-dependency in-memory default store ships with the core.

import type { RAGEmbeddingFunction } from "@absolutejs/ai";
import type { SyncEngine } from "@absolutejs/sync/engine";

export type InMemoryRAGStoreOptions = {
  dimensions?: number;
  mockEmbedding?: (text: string) => Promise<number[]>;
};

// Options for the sync-backed store (live retrieval via @absolutejs/sync).
export type SyncRAGStoreOptions = {
  /** Live retrieval collection name (subscribe with the query string). Default `ragRetrieval`. */
  collection?: string;
  /** Embedding dimensions for the deterministic fallback. */
  dimensions?: number;
  /** Real embedding provider (e.g. from @absolutejs/rag); falls back to a deterministic vector. */
  embedding?: RAGEmbeddingFunction;
  /** Engine to register on (one is created if omitted). */
  engine?: SyncEngine;
  /** Test/demo embedding by text. */
  mockEmbedding?: (text: string) => Promise<number[]>;
  /** Change-feed table name the live collection reads. Default `ragChunks`. */
  table?: string;
};
