import type { AIProviderConfig, AIUsage } from "@absolutejs/ai";
import type {
  SearchProvider,
  SearchResult,
  SearchSource,
  SearchCacheStore,
} from "@absolutejs/search";
import type { ResearchSchema, ResearchStatic } from "./schema";
export type { ResearchSchema, ResearchStatic } from "./schema";
import type { ReadWebpageOptions, WebReadResult } from "../web";

export type ResearchOperation =
  | "search"
  | "read"
  | "plan"
  | "extract"
  | "review";
export type ResearchProgress = {
  phase: ResearchOperation | "complete";
  completed: number;
  limit: number;
};
export type ResearchField = {
  /** RFC 6901 JSON pointer, including array indices. */
  path: string;
  value: string | number | boolean | null;
  verdict: "supported" | "unsupported" | "conflicting" | "unknown";
  citations: { sourceId: string; quote: string }[];
  reason: string;
  /** Model judgments, not independent verification; all must pass for support. */
  checks?: {
    answersQuestion: boolean;
    correctEntity: boolean;
    correctTime: boolean;
    preservesScope: boolean;
  };
};
/** Host-owned private checkpoint. Never accept this from an untrusted client. */
export type ResearchReviewCheckpoint = {
  version: 1;
  fingerprint: string;
  pass: number;
  stage?: "extract" | "review";
  nextField: number;
  /** Reduced after a settled failed batch; never increases the configured maximum. */
  nextBatchSize?: number;
  pending: boolean;
  finished?: boolean;
  draft: unknown;
  searched?: string[];
  read?: string[];
  links?: Array<{ url: string; label: string; discoveredOn: string }>;
  result: ResearchResult;
};
export type ResearchResult<T = unknown> = {
  /** Unreviewed extraction is retained for recovery, never an endorsed answer. */
  draft?: unknown;
  reviewCheckpoint?: ResearchReviewCheckpoint;

  /** Complete fetched text retained separately from model-facing excerpts. */
  documents?: Array<{
    sourceId: string;
    url: string;
    text: string;
    originalChars: number;
  }>;
  sourceFailures?: Array<{ url: string; code: string; message: string }>;
  coverage?: { requested: number; supported: number; complete: boolean };
  /** Reviewed drafts, including rejected fields, retained for audit. */
  reviewPasses?: Array<{
    fields: ResearchField[];
    coverage?: { requested: number; supported: number; complete: boolean };
  }>;
  id: string;
  status: "reviewed" | "partial" | "empty" | "unavailable";
  /** Only populated when every primitive field passed evidence review. */
  data: T | null;
  fields: ResearchField[];
  sources: SearchSource[];
  searches: SearchResult[];
  limitations: string[];
  generatedAt: string;
  operations: {
    kind: ResearchOperation;
    status: "fulfilled" | "unknown";
    usage?: AIUsage;
    durationMs: number;
  }[];
};
export type ResearchTask<S extends ResearchSchema = ResearchSchema> = {
  schema: S;
  /** Count only items whose required fields passed evidence review. JSON pointer to an array. */
  collection?: {
    path: string;
    minimum: number;
    requiredFields: string[];
    minimumSupportedFields?: Record<string, number>;
  };
  instructions?: string;
};
export type ResearchInput = {
  /** Tasks may contain instructions/JSON; quotes are not literal search filters. */
  queryMode?: "search" | "task";
  queries?: string[];
  requiredPhrases?: string[];
  query: string;
  task?: string;
  freshness?: string;
  signal?: AbortSignal;
  onProgress?: (event: ResearchProgress) => void;
  /** Trusted, tenant-bound host storage only; pending calls require reconciliation. */
  resumeReview?: ResearchReviewCheckpoint;
  /** Awaited before review and after each batch. Persistence failure stops work. */
  onReviewCheckpoint?: (checkpoint: ResearchReviewCheckpoint) => Promise<void>;
};
export type ResearchLimits = {
  searches: number;
  reads: number;
  rounds: number;
  timeoutMs: number;
  evidenceChars: number;
  outputTokens: number;
  fields: number;
};
export type ResearchConfig = {
  /** Trusted host opt-in: retain blocked destination failures, exclude their source evidence, and continue other sources. The reader still enforces all URL/DNS protections. Default false; never recovers accounting failures. */
  excludeBlockedSources?: boolean;
  /** Bounded factual correction passes after review. Default 0, maximum 2. Every correction is extracted and independently reviewed again. */
  evidenceRepairs?: number;
  /** Capacity reserved within the existing limits for review-identified gaps. */
  repairSearches?: number;
  repairReads?: number;
  /** Extra schema-validation attempts per extract/review, each separately admitted. Default 1; 0 disables repair. Provider/network failures are never retried. */
  validationRepairs?: number;
  /** Maximum fields in one review call. Default 12, additionally bounded by outputTokens. */
  reviewBatchSize?: number;
  /** Per-batch output ceiling, independent of extraction size. */
  reviewOutputTokens?: number;
  /** Host must confirm completed response AND durable accounting. Allows a malformed plan to consume another already-configured discovery round; review retry still requires explicit continuation. Unused with package admission. */
  isReviewFailureSettled?: (error: unknown) => Promise<boolean>;
  /** Server-side diagnostics only. Errors are never serialized into public research results. */
  onError?: (event: {
    runId: string;
    phase: ResearchOperation;
    error: unknown;
  }) => void;

  /** Optional host accounting adapter; defaults to the standard AI generator. */
  generateObject?: typeof import("@absolutejs/ai").generateObjectAI;
  budget?: import("./budget").ResearchBudgetConfig;
  search: SearchProvider;
  provider: AIProviderConfig;
  model: string;
  /** Optional separate reviewer. Host reservations must price this model too. */
  reviewer?: { provider: AIProviderConfig; model: string };
  tasks?: Record<string, ResearchTask>;
  limits?: Partial<ResearchLimits>;
  /** Explicit shared-public or tenant scope. Omit to disable search caching. */
  cache?: {
    scope: string;
    store?: SearchCacheStore;
    ttlMs?: number;
    capacity?: number;
  };
  reader?: (options: ReadWebpageOptions) => Promise<WebReadResult>;
  render?: ReadWebpageOptions["render"];
  /** Called before each operation. May atomically reserve tenant budget or deny. */
  admit?: (operation: {
    runId: string;
    kind: ResearchOperation;
    signal: AbortSignal;
  }) => Promise<
    | false
    | {
        settle: (outcome: {
          status: "fulfilled" | "unknown";
          usage?: AIUsage;
          search?: SearchResult;
        }) => Promise<void>;
      }
  >;
};
export type ResearchRuntime = {
  run: (input: ResearchInput) => Promise<ResearchResult>;
  extract: <S extends ResearchSchema>(
    task: ResearchTask<S>,
    input: ResearchInput,
  ) => Promise<ResearchResult<ResearchStatic<S>>>;
};
