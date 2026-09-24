import { sourceSupportsQuote, type SearchSource } from "@absolutejs/search";
import { Type } from "@sinclair/typebox";
import type { ResearchField } from "./types";

export const ReviewSchema = Type.Object({
  fields: Type.Array(
    Type.Object({
      path: Type.String(),
      verdict: Type.Union(
        (["supported", "unsupported", "conflicting", "unknown"] as const).map(
          (value) => Type.Literal(value),
        ),
      ),
      citations: Type.Array(
        Type.Object({ sourceId: Type.String(), quote: Type.String() }),
        { maxItems: 8 },
      ),
      reason: Type.String(),
    }),
    { maxItems: 256 },
  ),
});

export const researchLeaves = (value: unknown, maxFields = 128) => {
  const fields: Pick<ResearchField, "path" | "value">[] = [];
  const visit = (item: unknown, path: string, depth: number) => {
    if (depth > 32) throw new Error("Research output nesting limit exceeded");
    if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item))
        visit(
          child,
          `${path}/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`,
          depth + 1,
        );
    } else {
      if (
        item !== null &&
        !["string", "number", "boolean"].includes(typeof item)
      )
        throw new Error("Research output must be JSON");
      fields.push({ path, value: item as ResearchField["value"] });
      if (fields.length > maxFields)
        throw new Error("Research output field limit exceeded");
    }
  };
  visit(value, "", 0);
  return fields;
};

/** A model review is fallible. Citation validation proves provenance, not truth. */
export const bindResearchReview = (
  leaves: ReturnType<typeof researchLeaves>,
  reviews: {
    path: string;
    verdict: ResearchField["verdict"];
    citations: ResearchField["citations"];
    reason: string;
  }[],
  sources: SearchSource[],
): ResearchField[] =>
  leaves.map((leaf) => {
    const candidates = reviews.filter((review) => review.path === leaf.path);
    const review = candidates.length === 1 ? candidates[0] : undefined;
    const citations =
      review?.citations.filter((citation) => {
        const matching = sources.filter(
          (source) => source.id === citation.sourceId,
        );
        return (
          matching.length === 1 &&
          sourceSupportsQuote(matching[0]!, citation.quote)
        );
      }) ?? [];
    const valid = !!review && citations.length === review.citations.length;
    const verdict =
      !valid || leaf.value === null || !citations.length
        ? "unknown"
        : review.verdict;
    return {
      ...leaf,
      verdict,
      citations,
      reason: valid
        ? review.reason
        : "Missing, ambiguous, or invalid source-bound review",
    };
  });
