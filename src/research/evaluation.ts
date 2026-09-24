import type { RAGAnswerGroundingEvaluationCase } from "../../types/engine";
import type { ResearchInput, ResearchResult, ResearchRuntime } from "./types";

/** Feed research evidence into the existing @absolutejs/rag/quality evaluators. */
export const researchGroundingCase = (
  id: string,
  query: string,
  result: ResearchResult,
  expectedSources?: string[],
): RAGAnswerGroundingEvaluationCase => ({
  id,
  query,
  expectedSources,
  answer: result.fields
    .filter((field) => field.verdict === "supported")
    .map(
      (field) =>
        `${String(field.value)} ${field.citations.map((citation) => `[${result.sources.findIndex((source) => source.id === citation.sourceId) + 1}]`).join(" ")}`,
    )
    .join("\n"),
  sources: result.sources.map((source) => ({
    chunkId: source.id,
    source: source.url,
    title: source.title,
    text: source.excerpts.join("\n"),
    score: 1,
  })),
});
export type ResearchAcceptance = {
  accepted: number;
  rejected: number;
  reviewMs: number;
  reviewer: string;
};
export type ResearchEvaluationCase = {
  id: string;
  input: Pick<ResearchInput, "query" | "task" | "freshness">;
  expectedSources?: string[];
  publishedAfter?: string;
};
export const evaluateResearch = async (options: {
  runtime: ResearchRuntime;
  cases: ResearchEvaluationCase[];
  signal?: AbortSignal;
  /** Supply independent human decisions; absence means unreviewed, never zero errors. */
  review?: (
    test: ResearchEvaluationCase,
    result: ResearchResult,
  ) => Promise<ResearchAcceptance>;
  /** Total cost must include search, reads, planning, extraction, review and failed attempts. */
  cost?: (result: ResearchResult) => Promise<number | null>;
}) => {
  const cases = [];
  for (const test of options.cases) {
    options.signal?.throwIfAborted();
    const started = Date.now();
    const result = await options.runtime.run({
      ...test.input,
      signal: options.signal,
    });
    const durationMs = Date.now() - started;
    const acceptance = (await options.review?.(test, result)) ?? null;
    if (
      acceptance &&
      (!acceptance.reviewer.trim() ||
        !Number.isSafeInteger(acceptance.accepted) ||
        acceptance.accepted < 0 ||
        !Number.isSafeInteger(acceptance.rejected) ||
        acceptance.rejected < 0 ||
        !Number.isFinite(acceptance.reviewMs) ||
        acceptance.reviewMs < 0)
    )
      throw new Error("Invalid independent review");
    const costUsd = (await options.cost?.(result)) ?? null;
    if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0))
      throw new Error("Invalid measured research cost");
    const dates = result.sources.map((source) =>
      source.publishedAt ? Date.parse(source.publishedAt) : NaN,
    );
    const threshold = test.publishedAfter
      ? Date.parse(test.publishedAfter)
      : NaN;
    if (test.publishedAfter && !Number.isFinite(threshold))
      throw new Error("Invalid evaluation date threshold");
    cases.push({
      id: test.id,
      result,
      durationMs,
      acceptance,
      costUsd,
      costPerAcceptedFinding:
        costUsd !== null && acceptance && acceptance.accepted > 0
          ? costUsd / acceptance.accepted
          : null,
      publicationFreshness: Number.isFinite(threshold)
        ? {
            dated: dates.filter(Number.isFinite).length,
            fresh: dates.filter((date) => date >= threshold).length,
            unknown: dates.filter((date) => !Number.isFinite(date)).length,
          }
        : null,
      groundingCase: researchGroundingCase(
        test.id,
        test.input.query,
        result,
        test.expectedSources,
      ),
    });
  }
  return {
    cases,
    independentlyReviewed: cases.filter((test) => test.acceptance !== null)
      .length,
    totalCostUsd: cases.every((test) => test.costUsd !== null)
      ? cases.reduce((sum, test) => sum + test.costUsd!, 0)
      : null,
  };
};
