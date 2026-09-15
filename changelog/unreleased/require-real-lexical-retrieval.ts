import type { Change } from "@absolutejs/changelog";
export const change: Change = {
  kind: "breaking",
  summary:
    "Reject unsupported lexical and hybrid retrieval instead of silently omitting keyword results; preserve requested channels for scoped heuristic queries",
  symbols: ["createRAGCollection", "createHeuristicRAGRetrievalStrategy"],
  migration: {
    manual: true,
    instruction:
      "Use a store implementing queryLexical for lexical/hybrid retrieval, or explicitly select vector mode on vector-only stores. Scoped heuristic queries now retain the requested channels; update trace consumers from Scoped direct route to Scoped retrieval route.",
  },
};
