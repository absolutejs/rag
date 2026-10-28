import { createAITextSource } from "@absolutejs/ai";
/** Full sources remain stored; reuse AI's exact-passage retrieval to build only
 * the model-facing view. Search covers the entire document, including its tail. */
export const selectResearchExcerpts = (text: string, budget: number, query: string): string[] => {
  if (budget <= 0) return [];
  if (text.length <= budget) return [text];
  const source = createAITextSource([{ role: "user", content: text }]);
  const hits = source.search(query);
  const passages = hits.length ? hits : source.search("");
  let remaining = budget;
  const selected: Array<{ start: number; text: string }> = [];
  for (const passage of passages) {
    if (!remaining) break;
    const excerpt = passage.text.slice(0, remaining);
    selected.push({ start: passage.start, text: excerpt });
    remaining -= excerpt.length;
  }
  return selected.sort((a, b) => a.start - b.start).map(passage => passage.text);
};
