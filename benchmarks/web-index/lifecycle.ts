import {
  createWebIndex,
  createPostgresWebIndexStore,
  webIndexPostgresSchemaSql,
} from "../../src/web-index";
import { createRAGCollection } from "../../src/retrieval/collection";
import { createPostgresRAGStore } from "@absolutejs/rag-postgres";
const output = process.argv
  .find((arg) => arg.startsWith("--output="))
  ?.slice(9);
if (
  !process.env.WEB_INDEX_TEST_DATABASE_URL ||
  !output ||
  (await Bun.file(output).exists())
)
  throw new Error(
    "Provide a disposable WEB_INDEX_TEST_DATABASE_URL and --output=NEW_PATH",
  );
const db = new Bun.SQL(process.env.WEB_INDEX_TEST_DATABASE_URL);
const schemaName = `lifecycle_${Date.now()}`;
let revision = 1;
const collection = () =>
  createRAGCollection({
    store: createPostgresRAGStore({
      sql: db,
      schemaName,
      dimensions: 8,
      indexType: "none",
    }),
  });
const options = {
  tenant: schemaName,
  index: "fixture",
  store: createPostgresWebIndexStore(db),
  generations: [
    {
      id: "v1",
      embedding: { provider: "fixture", model: "deterministic", dimensions: 8 },
      collection: collection(),
      retrieval: "lexical" as const,
    },
  ],
  origins: ["https://example.com"],
  limits: {
    maxUrls: 100,
    maxPagesPerRun: 100,
    maxBytesPerRun: 1000000,
    maxChunksPerPage: 10,
    maxDepth: 0,
  },
  originDelayMs: 0,
  timeoutMs: 120000,
  fetchResource: async (url: string) => ({
    url,
    status: url.endsWith("robots.txt") ? 404 : 200,
    headers: { "content-type": "text/html" },
    body: new TextEncoder().encode(
      `<html><head><title>Partner ${url.split("/").at(-1)}</title></head><body><main><h1>Trial policy</h1><p>Partner ${url.split("/").at(-1)} offers quasar${url.endsWith("/42") ? "focus" : "general"} revision${revision}, available only to approved trial customers.</p></main></body></html>`,
    ),
  }),
};
await db.unsafe(webIndexPostgresSchemaSql());
const runtime = createWebIndex(options);
await runtime.enqueue(
  Array.from({ length: 100 }, (_, i) => `https://example.com/${i}`),
);
let start = performance.now();
const crawl = await runtime.run();
const crawlMs = performance.now() - start;
const restarted = createWebIndex({
  ...options,
  generations: [{ ...options.generations[0]!, collection: collection() }],
});
start = performance.now();
const first = await restarted.search({ query: "quasarfocus", count: 5 });
const restartFirstMs = performance.now() - start;
const trials = [];
for (let i = 0; i < 50; i++) {
  start = performance.now();
  const result = await restarted.search({ query: "quasarfocus", count: 5 });
  if (result.sources[0]?.url !== "https://example.com/42")
    throw new Error("Retrieval failed");
  trials.push(performance.now() - start);
}
revision = 2;
// Select the exact runtime partition through the scoped source metadata, not unrelated corpus rows.
const chunks = await db.unsafe(
  `SELECT metadata->>'webIndex' AS scope FROM "${schemaName}".rag_chunks LIMIT 1`,
);
await db.unsafe(
  "UPDATE absolute_web_frontier SET next_at=clock_timestamp() WHERE url=$1 AND partition IN(SELECT partition FROM absolute_web_generations WHERE scope=$2)",
  ["https://example.com/42", chunks[0]!.scope],
);
start = performance.now();
const update = await restarted.run();
const updated = await restarted.search({ query: "quasarfocus", count: 5 });
const updateToSearchMs = performance.now() - start;
if (!updated.sources[0]?.excerpts.some((text) => text.includes("revision2")))
  throw new Error("Update failed");
start = performance.now();
await restarted.remove("https://example.com/42");
const deleted = await restarted.search({ query: "quasarfocus", count: 5 });
const deleteToSearchMs = performance.now() - start;
if (deleted.sources.length) throw new Error("Deletion failed");
const sorted = [...trials].sort((a, b) => a - b);
const report = {
  protocol: "controlled-index-lifecycle-v1",
  pages: 100,
  crawl,
  crawlMs,
  pagesPerSecond: 100 / (crawlMs / 1000),
  restartFirstMs,
  firstMatched: first.sources[0]?.url,
  warmP50Ms: sorted[24],
  warmP95Ms: sorted[47],
  trialsMs: trials,
  update,
  updateToSearchMs,
  deleteToSearchMs,
  externalProviderCalls: 0,
  hostingCostUsd: null,
};
await Bun.write(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
await db.close();
