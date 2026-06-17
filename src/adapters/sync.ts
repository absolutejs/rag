import {
  createSyncEngine,
  createTextIndex,
  createVectorIndex,
  defineSearchCollection,
} from "@absolutejs/sync/engine";
import type { SyncEngine } from "@absolutejs/sync/engine";
import type {
  RAGBackendCapabilities,
  RAGEmbeddingInput,
  RAGLexicalQueryInput,
  RAGQueryInput,
  RAGQueryResult,
  RAGUpsertInput,
  RAGVectorCountInput,
  RAGVectorDeleteInput,
  RAGVectorStore,
  RAGVectorStoreStatus,
} from "../../types/engine";
import { RAG_VECTOR_DIMENSIONS_DEFAULT } from "../constants";
import type { SyncRAGStoreOptions } from "../../types/adapters";
import { createRAGVector, normalizeVector, querySimilarity } from "./utils";
import { matchesMetadataFilterRecord } from "./filtering";

// The full record kept server-side; the vector lives here, not on the rows the
// live search collection emits.
type StoredRecord = {
  chunkId: string;
  text: string;
  title?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  vector: number[];
};

// The light row indexed and pushed to live subscribers (no vector on the wire).
type RetrievalChunk = {
  chunkId: string;
  chunkText: string;
  title?: string;
  source?: string;
};

/**
 * A {@link RAGVectorStore} backed by the @absolutejs/sync engine: a drop-in for
 * `createInMemoryRAGStore`, but retrieval is also **live**. Ingested chunks flow
 * through the engine's change feed, so a registered search collection re-ranks as
 * the corpus changes — subscribe to `store.retrievalCollection` over
 * `store.engine`'s `syncSocket` and a query's results update with no refetch.
 *
 * Built on sync's `createVectorIndex` (one-shot semantic `query`) + a shared
 * `createTextIndex` (one-shot `queryLexical` AND the live lexical collection). The
 * vector stays in a server-side map keyed by chunk id, so emitted rows are light.
 */
export type SyncRAGStore = RAGVectorStore & {
  /** The engine to mount with `syncSocket` for live retrieval. */
  engine: SyncEngine;
  /** Collection name to subscribe to (params = the query string) for live retrieval. */
  retrievalCollection: string;
};

export const createSyncRAGStore = (
  options: SyncRAGStoreOptions = {},
): SyncRAGStore => {
  const dimensions = options.dimensions ?? RAG_VECTOR_DIMENSIONS_DEFAULT;
  const engine = options.engine ?? createSyncEngine();
  const retrievalCollection = options.collection ?? "ragRetrieval";
  const table = options.table ?? "ragChunks";

  const records = new Map<string, StoredRecord>();
  const toLight = (record: StoredRecord): RetrievalChunk => ({
    chunkId: record.chunkId,
    chunkText: record.text,
    source: record.source,
    title: record.title,
  });

  // One shared text index powers the one-shot lexical query and the live
  // collection; the vector index powers one-shot semantic query.
  const textIndex = createTextIndex<RetrievalChunk>({
    fields: ["chunkText"],
    key: (chunk) => chunk.chunkId,
  });
  const vectorIndex = createVectorIndex<RetrievalChunk>({
    embedding: (chunk) => records.get(chunk.chunkId)?.vector ?? [],
    key: (chunk) => chunk.chunkId,
  });

  // Live lexical retrieval: the subscription's params are the query string; the
  // ranked top-K re-rank as chunks are ingested/removed.
  engine.registerSearch(
    defineSearchCollection<RetrievalChunk>({
      index: () => textIndex,
      key: (chunk) => chunk.chunkId,
      name: retrievalCollection,
      source: () => [...records.values()].map(toLight),
      table,
    }),
  );

  const embed = async (input: RAGEmbeddingInput) => {
    if (options.embedding) {
      return options.embedding(input);
    }
    if (options.mockEmbedding) {
      return options.mockEmbedding(input.text);
    }

    return normalizeVector(createRAGVector(input.text, dimensions));
  };

  const matchesFilter = (
    record: StoredRecord,
    filter?: Record<string, unknown>,
  ) =>
    matchesMetadataFilterRecord(
      {
        chunkId: record.chunkId,
        metadata: record.metadata,
        source: record.source,
        title: record.title,
        ...(record.metadata ?? {}),
      },
      filter,
    );

  const toResult = (record: StoredRecord, score: number): RAGQueryResult => ({
    chunkId: record.chunkId,
    chunkText: record.text,
    embedding: record.vector,
    metadata: record.metadata,
    score,
    source: record.source,
    title: record.title,
  });

  const upsert = async (input: RAGUpsertInput) => {
    for (const chunk of input.chunks) {
      const vector = chunk.embedding
        ? normalizeVector(chunk.embedding)
        : normalizeVector(await embed({ text: chunk.text }));
      const record: StoredRecord = {
        chunkId: chunk.chunkId,
        metadata: chunk.metadata,
        source: chunk.source,
        text: chunk.text,
        title: chunk.title,
        vector,
      };
      records.set(record.chunkId, record);
      const light = toLight(record);
      vectorIndex.add(light);
      textIndex.add(light);
      // Drive the live collection: re-ranks every subscriber for this corpus.
      await engine.applyChange(table, { op: "insert", row: light });
    }
  };

  const query = async (input: RAGQueryInput) => {
    const queryVector = normalizeVector(input.queryVector);
    const results: RAGQueryResult[] = [];
    for (const record of records.values()) {
      if (!matchesFilter(record, input.filter)) {
        continue;
      }
      const score = querySimilarity(
        queryVector,
        normalizeVector(record.vector),
      );
      if (Number.isFinite(score)) {
        results.push(toResult(record, score));
      }
    }
    results.sort((first, second) => second.score - first.score);

    return results.slice(0, input.topK);
  };

  const queryLexical = async (input: RAGLexicalQueryInput) => {
    // Over-fetch so the metadata filter can still fill topK.
    const hits = textIndex.search(input.query, input.topK * 5);
    const results: RAGQueryResult[] = [];
    for (const hit of hits) {
      const record = records.get(hit.row.chunkId);
      if (record && matchesFilter(record, input.filter)) {
        results.push(toResult(record, hit.score));
      }
    }

    return results.slice(0, input.topK);
  };

  const hasFilters = (
    chunkIds: Set<string>,
    filter?: Record<string, unknown>,
  ) => ({
    filtered: Boolean(filter && Object.keys(filter).length > 0),
    ided: chunkIds.size > 0,
  });

  const count = async (input: RAGVectorCountInput = {}) => {
    const chunkIds = new Set(input.chunkIds ?? []);
    const { filtered, ided } = hasFilters(chunkIds, input.filter);
    if (!filtered && !ided) {
      return records.size;
    }

    return [...records.values()].filter(
      (record) =>
        (ided && chunkIds.has(record.chunkId)) ||
        (filtered && matchesFilter(record, input.filter)),
    ).length;
  };

  const remove = async (input: RAGVectorDeleteInput = {}) => {
    const chunkIds = new Set(input.chunkIds ?? []);
    const { filtered, ided } = hasFilters(chunkIds, input.filter);
    if (!filtered && !ided) {
      return 0;
    }
    let removed = 0;
    for (const record of [...records.values()]) {
      const matches =
        (ided && chunkIds.has(record.chunkId)) ||
        (filtered && matchesFilter(record, input.filter));
      if (!matches) {
        continue;
      }
      records.delete(record.chunkId);
      vectorIndex.remove(record.chunkId);
      textIndex.remove(record.chunkId);
      await engine.applyChange(table, {
        op: "delete",
        row: toLight(record),
      });
      removed += 1;
    }

    return removed;
  };

  const clear = async () => {
    for (const record of [...records.values()]) {
      records.delete(record.chunkId);
      vectorIndex.remove(record.chunkId);
      textIndex.remove(record.chunkId);
      await engine.applyChange(table, { op: "delete", row: toLight(record) });
    }
  };

  const status: RAGVectorStoreStatus = {
    backend: "in_memory",
    dimensions,
    vectorMode: "in_memory",
  };
  const capabilities: RAGBackendCapabilities = {
    backend: "in_memory",
    nativeVectorSearch: false,
    persistence: "memory_only",
    serverSideFiltering: false,
    streamingIngestStatus: false,
  };

  return {
    clear,
    count,
    delete: remove,
    embed,
    engine,
    getCapabilities: () => capabilities,
    getStatus: () => status,
    query,
    queryLexical,
    retrievalCollection,
    upsert,
  };
};
