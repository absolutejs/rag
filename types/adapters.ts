// Vector-store adapter configuration shapes that stay in the core. The Postgres
// and SQLite store implementations (and their option types) now live in their own
// adapter packages (@absolutejs/rag-postgres, @absolutejs/rag-sqlite); only the
// zero-dependency in-memory default store ships with the core.

export type InMemoryRAGStoreOptions = {
  dimensions?: number;
  mockEmbedding?: (text: string) => Promise<number[]>;
};
