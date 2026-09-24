import type { AIProviderConfig, AIUsage } from "@absolutejs/ai";
import type {
  SearchProvider,
  SearchResult,
  SearchSource,
  SearchCacheStore,
} from "@absolutejs/search";
import type { TSchema, Static } from "@sinclair/typebox";
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
};
export type ResearchResult<T = unknown> = {
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
export type ResearchTask<S extends TSchema = TSchema> = {
  schema: S;
  instructions?: string;
};
export type ResearchInput = {
  queries?: string[];
  requiredPhrases?: string[];
  query: string;
  task?: string;
  freshness?: string;
  signal?: AbortSignal;
  onProgress?: (event: ResearchProgress) => void;
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
  /** Optional host accounting adapter; defaults to the standard AI generator. */
  generateObject?: typeof import("@absolutejs/ai").generateObjectAI;
  budget?: import("./budget").ResearchBudgetConfig;
  search: SearchProvider;
  provider: AIProviderConfig;
  model: string;
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
  extract: <S extends TSchema>(
    task: ResearchTask<S>,
    input: ResearchInput,
  ) => Promise<ResearchResult<Static<S>>>;
};
