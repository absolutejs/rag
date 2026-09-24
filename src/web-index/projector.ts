import { t } from "elysia";
import { createResearch } from "../research/runtime";
import type { ResearchConfig, ResearchResult } from "../research/types";
import type { WebIndexDocument, WebIndexProjection } from "./types";

export type WebIndexProjectorOptions = Omit<
  ResearchConfig,
  "search" | "tasks" | "reader" | "render" | "cache"
> & {
  kind: WebIndexProjection["kind"];
  instructions: string;
  onResult?: (result: ResearchResult) => void | Promise<void>;
};
/** Provider-backed extraction and separate review, confined to an immutable source version. */
export const createWebIndexProjector =
  (options: WebIndexProjectorOptions) =>
  async (document: WebIndexDocument): Promise<WebIndexProjection[]> => {
    const text = document.passages.map((passage) => passage.text).join("\n\n");
    const runtime = createResearch({
      ...options,
      limits: { ...options.limits, searches: 1, reads: 0, rounds: 0 },
      search: {
        name: "index-document",
        version: "1",
        search: async (request) => ({
          provider: "index-document",
          version: "1",
          query: request.query,
          status: "ok",
          sources: [
            {
              id: "document",
              url: document.finalUrl,
              title: document.title,
              excerpts: [text],
              retrievedAt: document.fetchedAt,
              contentFetchedAt: document.fetchedAt,
              publishedAt: document.publishedAt,
            },
          ],
          attempts: [],
          limitations: [],
        }),
      },
    });
    const result = await runtime.extract(
      {
        schema: t.Object({
          identity: t.String(),
          facts: t.Array(t.String(), { maxItems: 12 }),
        }),
        instructions: `${options.instructions} Identify the ${options.kind} by its full explicit name and extract directly attributed facts. Each fact must include its subject and all dates, conditions and exceptions. Company domains require explicit source evidence. People require a named person and explicit role evidence; a mention is insufficient. Event dates must be event dates, not publication dates. Do not infer buying intent. Return an empty identity and facts if the entity is not established.`,
      },
      {
        query: `Identify the ${options.kind} described on this page and its supported facts: ${options.instructions}`,
      },
    );
    await options.onResult?.(result);
    const identity = result.fields.find((field) => field.path === "/identity");
    if (
      identity?.verdict !== "supported" ||
      typeof identity.value !== "string" ||
      !identity.value.trim()
    )
      return [];
    const ranges: Array<{ id: string; start: number; end: number }> = [];
    let offset = 0;
    for (const passage of document.passages) {
      ranges.push({
        id: passage.id,
        start: offset,
        end: offset + passage.text.length,
      });
      offset += passage.text.length + 2;
    }
    const fields = result.fields
      .filter(
        (field) =>
          /^\/facts\/\d+$/u.test(field.path) &&
          field.verdict === "supported" &&
          typeof field.value === "string",
      )
      .flatMap((field) => {
        const passageIds = new Set<string>();
        for (const citation of [...identity.citations, ...field.citations]) {
          const start = text.indexOf(citation.quote);
          if (start < 0 || !citation.quote.length) return [];
          for (const range of ranges)
            if (
              range.start < start + citation.quote.length &&
              range.end > start
            )
              passageIds.add(range.id);
        }
        return passageIds.size
          ? [
              {
                name: field.path.slice(1).replace("/", ":"),
                value: field.value as string,
                passageIds: [...passageIds],
              },
            ]
          : [];
      });
    return fields.length
      ? [{ kind: options.kind, identity: identity.value, fields }]
      : [];
  };
