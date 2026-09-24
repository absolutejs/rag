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
      citations: Type.Array(Type.Object({ passageId: Type.String() }), {
        maxItems: 8,
      }),
      reason: Type.String(),
      checks: Type.Object({
        answersQuestion: Type.Boolean(),
        correctEntity: Type.Boolean(),
        correctTime: Type.Boolean(),
        preservesScope: Type.Boolean(),
      }),
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
    checks?: ResearchField["checks"];
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
    const checksPass =
      review?.checks &&
      [
        "answersQuestion",
        "correctEntity",
        "correctTime",
        "preservesScope",
      ].every(
        (key) =>
          review.checks?.[key as keyof NonNullable<ResearchField["checks"]>] ===
          true,
      );
    const quoted =
      typeof leaf.value === "string"
        ? [
            ...leaf.value.matchAll(
              /(?:["“]([^"”\n]{12,})["”]|(?:^|\s)'([^'\n]{12,})')/gu,
            ),
          ].map((match) => match[1] ?? match[2]!)
        : [];
    const quotedTextSupported = quoted.every((quote) =>
      sources.some((source) => sourceSupportsQuote(source, quote)),
    );
    const verdict =
      !valid || leaf.value === null || !citations.length || !quotedTextSupported
        ? "unknown"
        : review.verdict === "supported" && !checksPass
          ? "unknown"
          : review.verdict;
    return {
      ...leaf,
      verdict,
      citations,
      checks: review?.checks,
      reason: !quotedTextSupported
        ? "Quoted wording does not occur in the supplied evidence"
        : valid && review.verdict === "supported" && !checksPass
          ? "Task relevance, entity, time, or scope was not established: " +
            review.reason
          : valid
            ? review.reason
            : "Missing, ambiguous, or invalid source-bound review",
    };
  });

/** Stable references let the runtime copy evidence instead of asking a model to transcribe it. */
export const researchPassages = (sources: SearchSource[]) =>
  sources.map((source) => {
    const passages: { id: string; text: string; context: string }[] = [];
    for (const excerpt of source.excerpts) {
      let start = 0;
      while (start < excerpt.length) {
        let end = Math.min(start + 600, excerpt.length);
        if (end < excerpt.length) {
          const boundary = excerpt.lastIndexOf("\n", end);
          if (boundary > start + 300) end = boundary;
          if (excerpt.length - end < 12) end = excerpt.length;
        }
        passages.push({
          id: `${source.id}:${passages.length}`,
          text: excerpt.slice(start, end),
          context: excerpt.slice(
            Math.max(0, start - 600),
            Math.min(excerpt.length, end + 600),
          ),
        });
        start = end;
      }
    }
    const { excerpts: _excerpts, ...metadata } = source;
    return { ...metadata, passages };
  });

export const resolveResearchPassages = (
  citations: { passageId: string }[],
  sources: ReturnType<typeof researchPassages>,
) =>
  citations.map((citation) => {
    const matches = sources.flatMap((source) =>
      source.passages
        .filter((passage) => passage.id === citation.passageId)
        .map((passage) => ({ sourceId: source.id, quote: passage.text })),
    );
    // Keep invalid references present so binding fails closed, never silently drop them.
    return matches.length === 1 ? matches[0]! : { sourceId: "", quote: "" };
  });
