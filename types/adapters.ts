// Vector-store adapter configuration shapes. The implementations in
// src/adapters/* import these. Private row/wire shapes and the distance/
// index unions stay colocated with the adapter code that uses them; the small
// unions are inlined here so this file has no dependency on adapter internals.

import type { Database } from "bun:sqlite";

export type InMemoryRAGStoreOptions = {
  dimensions?: number;
  mockEmbedding?: (text: string) => Promise<number[]>;
};

export type PostgresRAGStoreOptions = {
  connectionString?: string;
  sql?: InstanceType<typeof Bun.SQL>;
  dimensions?: number;
  mockEmbedding?: (text: string) => Promise<number[]>;
  tableName?: string;
  schemaName?: string;
  distanceMetric?: "cosine" | "l2" | "inner_product";
  queryMultiplier?: number;
  indexType?: "none" | "hnsw" | "ivfflat";
  indexLists?: number;
  hnswM?: number;
  hnswEfConstruction?: number;
};

export type NativeSQLiteRAGStoreOptions = {
  mode: "vec0";
  extensionPath?: string;
  extensionInitSql?: string | string[];
  distanceMetric?: "cosine" | "l2";
  tableName?: string;
  queryMultiplier?: number;
  requireAvailable?: boolean;
  resolveFromAbsolutePackages?: boolean;
};

export type SQLiteRAGStoreOptions = {
  db?: Database;
  path?: string;
  dimensions?: number;
  mockEmbedding?: (text: string) => Promise<number[]>;
  tableName?: string;
  native?: NativeSQLiteRAGStoreOptions;
};
