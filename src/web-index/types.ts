import type { RAGCollection } from "../../types/engine";
import type { SearchProvider } from "@absolutejs/search";
import type { fetchPublicWebResource } from "../web/transport";

export type WebIndexScope = { tenant: string; index: string };
export type WebIndexGeneration = {
  id: string;
  embedding: { provider: string; model: string; dimensions: number };
  collection: RAGCollection;
  retrieval?: "lexical" | "hybrid" | "vector";
};
export type WebIndexPassage = { id: string; heading: string[]; text: string };
export type WebIndexDocument = {
  url: string;
  finalUrl: string;
  canonicalHint?: string;
  title: string;
  version: string;
  contentHash: string;
  fetchedAt: string;
  changedAt: string;
  publishedAt?: string;
  etag?: string;
  lastModified?: string;
  passages: WebIndexPassage[];
  links: string[];
  status: number;
};
export type WebIndexLease = {
  partition: string;
  url: string;
  origin: string;
  token: string;
  depth: number;
  attempts: number;
  document: WebIndexDocument | null;
};
export type WebIndexProjection = {
  kind: "company" | "person" | "event";
  identity: string;
  fields: Array<{
    name: string;
    value: string;
    passageIds: string[];
    validFrom?: string;
    validUntil?: string;
  }>;
};
export type WebIndexStats = {
  urls: number;
  documents: number;
  pending: number;
  failed: number;
  tombstones: number;
  oldestFetchedAt: string | null;
  newestFetchedAt: string | null;
};
export type WebIndexStore = {
  register: (
    scope: string,
    generation: string,
    partition: string,
    fingerprint: string,
  ) => Promise<void>;
  active: (scope: string) => Promise<string | null>;
  activate: (
    scope: string,
    generation: string,
    expected: string,
    report: { passed: true; evidence: string },
  ) => Promise<boolean>;
  enqueue: (
    partition: string,
    items: Array<{
      url: string;
      origin: string;
      depth: number;
      priority: number;
    }>,
    maxUrls: number,
  ) => Promise<number>;
  claim: (partition: string, leaseMs: number) => Promise<WebIndexLease | null>;
  gateOrigin: (
    origin: string,
    token: string,
    leaseMs: number,
    delayMs: number,
  ) => Promise<number | null>;
  deferOrigin: (
    origin: string,
    token: string,
    delayMs: number,
  ) => Promise<void>;
  releaseOrigins: (token: string, delayMs: number) => Promise<void>;
  finish: (
    lease: WebIndexLease,
    document: WebIndexDocument | null,
    nextFetchMs: number,
    delayMs: number,
  ) => Promise<boolean>;
  fail: (
    lease: WebIndexLease,
    error: string,
    retryMs: number,
    delayMs: number,
  ) => Promise<boolean>;
  document: (
    partition: string,
    url: string,
  ) => Promise<WebIndexDocument | null>;
  lookup: (partition: string, urls: string[]) => Promise<WebIndexDocument[]>;
  documents: (
    partition: string,
    limit: number,
    after?: string,
  ) => Promise<WebIndexDocument[]>;
  history: (
    partition: string,
    url: string,
    limit: number,
  ) => Promise<WebIndexDocument[]>;
  remove: (partition: string, url: string, permanent: boolean) => Promise<void>;
  restore: (partition: string, url: string) => Promise<void>;
  stats: (partition: string) => Promise<WebIndexStats>;
  saveProjection: (
    partition: string,
    url: string,
    version: string,
    projection: WebIndexProjection,
  ) => Promise<boolean>;
  projections: (
    partition: string,
    kind: WebIndexProjection["kind"],
    limit: number,
  ) => Promise<
    Array<
      WebIndexProjection & { url: string; version: string; fetchedAt: string }
    >
  >;
};
export type WebIndexOptions = WebIndexScope & {
  store: WebIndexStore;
  generations: WebIndexGeneration[];
  /** Explicit public origins eligible for crawling, including redirect destinations. */
  origins: string[];
  limits: {
    maxUrls: number;
    maxPagesPerRun: number;
    maxBytesPerRun: number;
    maxChunksPerPage: number;
    maxDepth: number;
  };
  recrawlMs?: number;
  originDelayMs?: number;
  timeoutMs?: number;
  leaseMs?: number;
  fetchResource?: typeof fetchPublicWebResource;
  /** Called before each ingestion; throw to deny provider work. Model metering belongs to the supplied collection. */
  admit?: (input: {
    generation: string;
    url: string;
    chunks: number;
    bytes: number;
  }) => Promise<void>;
};
export type WebIndexRun = {
  pages: number;
  bytes: number;
  chunks: number;
  unchanged: number;
  deleted: number;
  failures: number;
  exhausted: boolean;
  errors: Array<{ url: string; message: string }>;
  providerCostUsd: null;
  infrastructureCostUsd: null;
};
export type WebIndexRuntime = {
  enqueue: (urls: string[], generation?: string) => Promise<number>;
  run: (input?: {
    generation?: string;
    signal?: AbortSignal;
  }) => Promise<WebIndexRun>;
  search: SearchProvider["search"];
  provider: SearchProvider;
  stats: (generation?: string) => Promise<WebIndexStats>;
  history: (url: string, generation?: string) => Promise<WebIndexDocument[]>;
  remove: (url: string, generation?: string) => Promise<void>;
  restore: (url: string, generation?: string) => Promise<void>;
  rebuild: (
    from: string,
    to: string,
    limit: number,
    after?: string,
  ) => Promise<{ enqueued: number; next?: string }>;
  activate: (
    generation: string,
    expected: string,
    report: { passed: true; evidence: string },
  ) => Promise<boolean>;
  project: (input: {
    url: string;
    generation?: string;
    extract: (document: WebIndexDocument) => Promise<WebIndexProjection[]>;
  }) => Promise<number>;
  projections: (
    kind: WebIndexProjection["kind"],
    generation?: string,
  ) => Promise<
    Array<
      WebIndexProjection & { url: string; version: string; fetchedAt: string }
    >
  >;
};
