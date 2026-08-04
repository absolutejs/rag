import type {
  RAGEmbeddingFunction,
  RAGEmbeddingProvider,
} from "../../types/engine";

// Embedding is metered per token by every hosted provider, and two failure
// modes bite real deployments:
//
//  1. Re-embedding text that has not changed. Re-ingesting a record, or
//     running a backfill, produces identical vectors at full token cost —
//     "idempotent" without being free. A single full pass over a mature
//     dataset can exceed a monthly quota several times over.
//  2. Running out of quota silently. Providers answer 429 RESOURCE_EXHAUSTED,
//     hosts catch and log it, and retrieval quietly stops learning while
//     everything still looks healthy.
//
// Both are provider-agnostic, so they belong here rather than in each app.

/** Persistence for embedding reuse. The host owns storage (Postgres, Redis,
 *  an LRU) — this package only decides WHAT to remember and when to skip. */
export type RAGEmbeddingCache = {
  /** Previously embedded vector for this exact text, if any. */
  get: (key: string) => Promise<number[] | null> | number[] | null;
  set: (key: string, embedding: number[]) => Promise<void> | void;
};

/** Stable cache key for a piece of text under one model + input type. A
 *  passage and a query embed differently, so they must not share an entry. */
export const embeddingCacheKey = async (
  text: string,
  model?: string,
  kind?: string,
  identity?: string,
) => {
  const payload = `${identity ?? "provider-default"}:${model ?? "default"}:${kind ?? "passage"}:${text}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export type RAGEmbeddingErrorKind =
  | "allowance"
  | "rate_limit"
  | "input"
  | "transient"
  | "unknown";

export type RAGEmbeddingError = Error & {
  embeddingErrorKind: RAGEmbeddingErrorKind;
  retryAfterMs?: number;
  status?: number;
};

export const createRAGEmbeddingError = (input: {
  message: string;
  kind?: RAGEmbeddingErrorKind;
  retryAfterMs?: number;
  status?: number;
}): RAGEmbeddingError => {
  const error = new Error(input.message) as RAGEmbeddingError;
  error.embeddingErrorKind = input.kind ?? "unknown";
  if (input.retryAfterMs !== undefined) error.retryAfterMs = input.retryAfterMs;
  if (input.status !== undefined) error.status = input.status;
  return error;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "";

export const classifyEmbeddingError = (
  error: unknown,
): RAGEmbeddingErrorKind => {
  if (
    error &&
    typeof error === "object" &&
    "embeddingErrorKind" in error
  ) {
    return (error as RAGEmbeddingError).embeddingErrorKind;
  }
  const message = errorMessage(error);
  if (/insufficient_quota|billing hard limit|monthly|allowance|credit balance/i.test(message)) {
    return "allowance";
  }
  if (/rate.?limit|requests? per minute|tokens? per minute|\bTPM\b|\bRPM\b/i.test(message)) {
    return "rate_limit";
  }
  if (/RESOURCE_EXHAUSTED.*(?:quota|token limit)|(?:quota|token limit).*RESOURCE_EXHAUSTED/i.test(message)) {
    return "allowance";
  }
  if (/invalid|too long|maximum context|dimension|malformed/i.test(message)) {
    return "input";
  }
  if (/timeout|timed out|connection|socket|reset|unavailable|5\d\d/i.test(message)) {
    return "transient";
  }
  return "unknown";
};

/** Whether a provider error means "you are out of embedding allowance",
 *  as opposed to a transient failure worth retrying. */
export const isEmbeddingQuotaError = (error: unknown) => {
  return classifyEmbeddingError(error) === "allowance";
};

export const isRetryableEmbeddingError = (error: unknown) => {
  const kind = classifyEmbeddingError(error);
  return kind === "rate_limit" || kind === "transient" || kind === "unknown";
};

export type RAGEmbeddingHealth = {
  /** Last error message seen, cleared by the next success. */
  lastError: string | null;
  /** When the provider last said the allowance is spent. */
  quotaExhaustedAt: Date | null;
  /** Embeddings served from cache since process start. */
  reused: number;
  /** Embeddings actually paid for since process start. */
  embedded: number;
  attempted: number;
  failed: number;
  inFlight: number;
  cacheFailures: number;
  rateLimitedAt: Date | null;
  recoveredAt: Date | null;
};

export type RAGBudgetedEmbedding = RAGEmbeddingProvider & {
  health: () => RAGEmbeddingHealth;
};

export type WithEmbeddingBudgetOptions = {
  cache?: RAGEmbeddingCache;
  /** Notified the first time the allowance is reported spent — wire this to
   *  an alert, because a degraded index is otherwise invisible. */
  onQuotaExhausted?: (error: unknown) => void;
  onCacheError?: (error: unknown, operation: "get" | "set") => void;
  /** Additional provider/revision identity included in every cache key. */
  cacheNamespace?: string;
  /** Admission hook for host-owned token budgets. Throw to reject the call. */
  beforeEmbed?: (input: Parameters<RAGEmbeddingFunction>[0]) => Promise<void> | void;
};

/** Wrap an embedding function so repeated text is not re-embedded and quota
 *  exhaustion is observable instead of silent. */
export const withEmbeddingBudget = (
  provider: RAGEmbeddingProvider | RAGEmbeddingFunction,
  options: WithEmbeddingBudgetOptions = {},
): RAGBudgetedEmbedding => {
  const base: RAGEmbeddingProvider =
    typeof provider === "function" ? { embed: provider } : provider;
  const { cache, onCacheError, onQuotaExhausted } = options;
  let lastError: string | null = null;
  let quotaExhaustedAt: Date | null = null;
  let rateLimitedAt: Date | null = null;
  let recoveredAt: Date | null = null;
  let reused = 0;
  let embedded = 0;
  let attempted = 0;
  let failed = 0;
  let inFlight = 0;
  let cacheFailures = 0;
  const pending = new Map<string, Promise<number[]>>();
  const hotCache = new Map<string, number[]>();
  const cacheIdentity = [
    options.cacheNamespace ?? base.cacheNamespace ?? "provider-default",
    base.dimensions ?? "dimensions-default",
  ].join(":");

  return {
    ...base,
    embed: async (input) => {
      const resolvedModel = input.model ?? base.defaultModel;
      const key = cache
        ? await embeddingCacheKey(input.text, resolvedModel, input.kind, cacheIdentity)
        : null;
      if (key && cache) {
        const localHit = hotCache.get(key);
        if (localHit) {
          reused += 1;
          return localHit;
        }
        let hit: number[] | null = null;
        try {
          hit = await cache.get(key);
        } catch (error) {
          cacheFailures += 1;
          onCacheError?.(error, "get");
        }
        if (hit && hit.length > 0) {
          reused += 1;
          hotCache.set(key, hit);

          return hit;
        }
        const existing = pending.get(key);
        if (existing) {
          reused += 1;
          return existing;
        }
      }
      const execute = async () => {
        await options.beforeEmbed?.({ ...input, model: resolvedModel });
        attempted += 1;
        inFlight += 1;
        try {
          const vector = await base.embed({ ...input, model: resolvedModel });
          lastError = null;
          embedded += 1;
          if (quotaExhaustedAt || rateLimitedAt) recoveredAt = new Date();
          if (key && cache) {
            hotCache.set(key, vector);
            if (hotCache.size > 1_000) hotCache.delete(hotCache.keys().next().value!);
            try {
              await cache.set(key, vector);
            } catch (error) {
              cacheFailures += 1;
              onCacheError?.(error, "set");
            }
          }
          return vector;
        } catch (error) {
          failed += 1;
          lastError = errorMessage(error) || String(error);
          const kind = classifyEmbeddingError(error);
          if (kind === "allowance") {
            const first = quotaExhaustedAt === null;
            quotaExhaustedAt = new Date();
            if (first) onQuotaExhausted?.(error);
          } else if (kind === "rate_limit") {
            rateLimitedAt = new Date();
          }
          throw error;
        } finally {
          inFlight -= 1;
        }
      };
      const operation = execute();
      if (key) pending.set(key, operation);
      try {
        return await operation;
      } finally {
        if (key && pending.get(key) === operation) pending.delete(key);
      }
    },
    health: () => ({
      attempted,
      cacheFailures,
      embedded,
      failed,
      inFlight,
      lastError,
      quotaExhaustedAt,
      rateLimitedAt,
      recoveredAt,
      reused,
    }),
  };
};
