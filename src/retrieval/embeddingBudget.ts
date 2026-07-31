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
) => {
  const payload = `${model ?? "default"}:${kind ?? "passage"}:${text}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const QUOTA_PATTERN =
  /RESOURCE_EXHAUSTED|token limit|quota|insufficient_quota|billing hard limit/i;

/** Whether a provider error means "you are out of embedding allowance",
 *  as opposed to a transient failure worth retrying. */
export const isEmbeddingQuotaError = (error: unknown) => {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";

  return QUOTA_PATTERN.test(message);
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
};

export type RAGBudgetedEmbedding = RAGEmbeddingProvider & {
  health: () => RAGEmbeddingHealth;
};

export type WithEmbeddingBudgetOptions = {
  cache?: RAGEmbeddingCache;
  /** Notified the first time the allowance is reported spent — wire this to
   *  an alert, because a degraded index is otherwise invisible. */
  onQuotaExhausted?: (error: unknown) => void;
};

/** Wrap an embedding function so repeated text is not re-embedded and quota
 *  exhaustion is observable instead of silent. */
export const withEmbeddingBudget = (
  provider: RAGEmbeddingProvider | RAGEmbeddingFunction,
  options: WithEmbeddingBudgetOptions = {},
): RAGBudgetedEmbedding => {
  const base: RAGEmbeddingProvider =
    typeof provider === "function" ? { embed: provider } : provider;
  const { cache, onQuotaExhausted } = options;
  let lastError: string | null = null;
  let quotaExhaustedAt: Date | null = null;
  let reused = 0;
  let embedded = 0;

  return {
    ...base,
    embed: async (input) => {
      const key = cache
        ? await embeddingCacheKey(input.text, input.model, input.kind)
        : null;
      if (key && cache) {
        const hit = await cache.get(key);
        if (hit && hit.length > 0) {
          reused += 1;

          return hit;
        }
      }
      const vector = await base.embed(input).catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error);
        if (isEmbeddingQuotaError(error)) {
          const first = quotaExhaustedAt === null;
          quotaExhaustedAt = new Date();
          if (first) onQuotaExhausted?.(error);
        }
        throw error;
      });
      lastError = null;
      embedded += 1;
      if (key && cache) await cache.set(key, vector);

      return vector;
    },
    health: () => ({ embedded, lastError, quotaExhaustedAt, reused }),
  };
};
