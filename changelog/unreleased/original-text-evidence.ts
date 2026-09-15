import type { Change } from "@absolutejs/changelog";
export const change: Change = {
  kind: "added",
  summary:
    "Add verbatim versioned text ingestion and authorized hybrid source tools with caller-supplied model token budgets; preserve multilingual keyword matches",
  symbols: [
    "chunkRAGOriginalText",
    "readRAGOriginalText",
    "createRAGOriginalTextTools",
  ],
};
