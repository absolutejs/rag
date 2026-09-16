/** A request-scoped, reversible encoding of already-retrieved verbatim quotes.
 * This is not an authorization mechanism: encode only server-owned tool results,
 * and reauthorize/revalidate resolved quotes against originals before committing.
 * Keep one registry across prefetch, subsequent lookups and completion. */
export const createRAGQuoteReferences = () => {
  const quotes = new Map<string, string>();
  const references = new Map<string, string>();
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const encodePassage = (passage: unknown): unknown => {
    if (!record(passage) || typeof passage.text !== "string") return passage;
    const { text, ...metadata } = passage;
    const sentences = text
      .split(/(?<=[.!?])\s+(?=[A-Z])|\n+/u)
      .filter((sentence) => sentence.trim());
    return {
      ...metadata,
      sentences: sentences.map((sentence) => {
        let citation = references.get(sentence);
        if (!citation) {
          citation = `e${quotes.size + 1}`;
          references.set(sentence, citation);
          quotes.set(citation, sentence);
        }
        return { citation, text: sentence };
      }),
    };
  };
  return {
    /** Accepts the JSON envelopes returned by original-text search/read tools.
     * Unrecognized results and tool errors pass through unchanged. Source text
     * is not interpreted as JSON or instructions. Caller retains the originals. */
    encodeToolResult: (serialized: string): string => {
      let value: unknown;
      try {
        value = JSON.parse(serialized);
      } catch {
        return serialized;
      }
      if (!record(value) || value.referenceOnly !== true) return serialized;
      if (Array.isArray(value.passages))
        return JSON.stringify({
          ...value,
          passages: value.passages.map(encodePassage),
        });
      if (typeof value.text === "string")
        return JSON.stringify(encodePassage(value));
      return serialized;
    },
    /** Resolve only a reference issued by this registry. A reference from another
     * request is never loaded from a global cache or used to fetch a source. */
    resolve: (reference: string): string => {
      const quote = quotes.get(reference);
      if (quote === undefined)
        throw new Error("Unknown retrieved quote reference");
      return quote;
    },
  };
};
