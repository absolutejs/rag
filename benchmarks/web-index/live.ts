import {
  createWebIndex,
  createPostgresWebIndexStore,
  webIndexPostgresSchemaSql,
} from "../../src/web-index";
import { createRAGCollection } from "../../src/retrieval/collection";
import { createPostgresRAGStore } from "@absolutejs/rag-postgres";
import { createBraveSearch } from "@absolutejs/search/brave";
import { createResearch } from "../../src/research/runtime";
import { anthropic } from "@absolutejs/ai/anthropic";
import { t } from "elysia";
import { appendFile } from "node:fs/promises";
const output = process.argv
  .find((arg) => arg.startsWith("--output="))
  ?.slice(9);
if (
  !process.argv.includes("--live") ||
  !output ||
  (await Bun.file(output).exists()) ||
  (await Bun.file(`${output}.jsonl`).exists())
)
  throw new Error(
    "Use --live --output=NEW_PATH with an explicit disposable WEB_INDEX_TEST_DATABASE_URL",
  );
if (
  !process.env.WEB_INDEX_TEST_DATABASE_URL ||
  !process.env.BRAVE_SEARCH_API_KEY ||
  !process.env.ANTHROPIC_API_KEY
)
  throw new Error(
    "Disposable database, Brave and Anthropic configuration required",
  );
const db = new Bun.SQL(process.env.WEB_INDEX_TEST_DATABASE_URL);
const schemaName = `web_pilot_${Date.now()}`;
const journal = (entry: unknown) =>
  appendFile(`${output}.jsonl`, JSON.stringify(entry) + "\n");
const urls = [
  "https://www.hubspot.com/2026-entry-and-tiers-policy-for-hubspot-solutions-partners",
  "https://legal.hubspot.com/solutions-partner-program-agreement",
  "https://brave.com/about/",
  "https://www.hubspot.com/company-news/fall-26-spotlight",
];
const tasks = [
  {
    id: "company",
    query: "HubSpot solutions partner program eligibility official",
    instructions:
      "Report only program membership eligibility, keeping benefit/trial conditions separate. Preserve approval conditions and exceptions.",
  },
  {
    id: "contact",
    query: "Brave Search API team leadership official",
    instructions:
      "Report a fully named current leader only if their exact role is established. Chief of Search does not establish a more specific API-team title.",
  },
  {
    id: "event",
    query: "HubSpot product launch September 2026 official announcement",
    instructions:
      "Report an explicitly dated event, separate from publication date. Attribute vendor first/best claims; do not infer partnership intent.",
  },
  {
    id: "negative",
    query: '"OnSpark Synthetic Negative 9f846d2e" partnership launch',
    instructions:
      "Require exact entity identity and event evidence. Return no findings when absent.",
  },
];
const collection = () =>
  createRAGCollection({
    store: createPostgresRAGStore({
      sql: db,
      schemaName,
      dimensions: 8,
      indexType: "none",
    }),
  });
await db.unsafe(webIndexPostgresSchemaSql());
const options = {
  tenant: schemaName,
  index: "public-pilot",
  store: createPostgresWebIndexStore(db),
  generations: [
    {
      id: "lexical-v1",
      embedding: {
        provider: "absolutejs",
        model: "local-deterministic-fixture",
        dimensions: 8,
      },
      collection: collection(),
      retrieval: "lexical" as const,
    },
  ],
  origins: [...new Set(urls.map((url) => new URL(url).origin))],
  limits: {
    maxUrls: 4,
    maxPagesPerRun: 4,
    maxBytesPerRun: 4_000_000,
    maxChunksPerPage: 100,
    maxDepth: 0,
  },
  originDelayMs: 1000,
  timeoutMs: 120000,
};
const index = createWebIndex(options);
await index.enqueue(urls);
const crawlStarted = performance.now();
const crawl = await index.run();
for (
  let tick = 0;
  tick < 6 && (await index.stats()).pending > 0 && crawl.pages < 4;
  tick++
) {
  await Bun.sleep(1100);
  const next = await index.run();
  for (const key of [
    "pages",
    "bytes",
    "chunks",
    "unchanged",
    "deleted",
    "failures",
  ] as const)
    crawl[key] += next[key];
  crawl.errors.push(...next.errors);
}
if ((await index.stats()).documents !== 4)
  throw new Error(
    "Declared corpus is incomplete; inspect durable frontier before running paid comparison",
  );
const crawlMs = performance.now() - crawlStarted;
await journal({ kind: "crawl", crawl, crawlMs, stats: await index.stats() });
const restarted = createWebIndex({
  ...options,
  generations: [{ ...options.generations[0]!, collection: collection() }],
});
const queries = [];
for (const task of tasks) {
  const trials = [];
  let result;
  for (let i = 0; i < 21; i++) {
    const start = performance.now();
    result = await restarted.search({
      query: task.query,
      count: 5,
      maxTokens: 4096,
    });
    trials.push(performance.now() - start);
  }
  const sorted = trials.slice(1).sort((a, b) => a - b);
  queries.push({
    task: task.id,
    firstMs: trials[0],
    warmP50Ms: sorted[9],
    warmP95Ms: sorted[18],
    trialsMs: trials,
    result,
  });
}
let searches = 0,
  models = 0;
const modelCalls: unknown[] = [];
const searchCalls: unknown[] = [];
const base = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const provider = {
  ...base,
  async *stream(input: Parameters<typeof base.stream>[0]) {
    if (++models > 16) throw new Error("Model cap reached");
    const started = performance.now();
    let usage: unknown = null;
    try {
      for await (const chunk of base.stream(input)) {
        if (chunk.type === "done") usage = chunk.usage ?? null;
        yield chunk;
      }
    } finally {
      const call = {
        model: input.model,
        usage,
        durationMs: performance.now() - started,
      };
      modelCalls.push(call);
      await journal({ kind: "model", ...call });
    }
  },
};
const brave = createBraveSearch({
  apiKey: process.env.BRAVE_SEARCH_API_KEY,
  observe: async (attempt) => {
    searchCalls.push(attempt);
    await journal({ kind: "brave", attempt });
  },
});
const results = [];
// Fixed extraction/review protocol isolates retrieved evidence. No planner or page reads in either arm.
for (const [arm, search] of [
  ["owned-index", restarted.provider],
  ["brave", brave],
] as const) {
  const runtime = createResearch({
    provider,
    model: "claude-haiku-4-5-20251001",
    reviewer: { provider, model: "claude-sonnet-4-6" },
    search: {
      ...search,
      search: async (request) => {
        if (++searches > 8) throw new Error("Search cap reached");
        return search.search(request);
      },
    },
    limits: {
      rounds: 0,
      reads: 0,
      searches: 1,
      outputTokens: 2500,
      timeoutMs: 90000,
    },
  });
  for (const task of tasks) {
    const started = performance.now();
    const result = await runtime.extract(
      {
        schema: t.Object({ findings: t.Array(t.String(), { maxItems: 4 }) }),
        instructions: task.instructions,
      },
      { query: task.query },
    );
    const row = {
      arm,
      task: task.id,
      durationMs: performance.now() - started,
      result,
    };
    results.push(row);
    await journal({ kind: "research", ...row });
  }
}
const bytes = await db.unsafe(
  "SELECT sum(pg_total_relation_size(c.oid))::bigint AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'",
  [schemaName],
);
await Bun.write(
  output,
  JSON.stringify(
    {
      protocol: "owned-index-2026-09-24-v1",
      urls,
      tasks,
      crawl,
      crawlMs,
      stats: await index.stats(),
      queries,
      results,
      modelCalls,
      searchCalls,
      chunkStorageBytes: Number(bytes[0]?.bytes ?? 0),
      limitations: [
        "Four preselected public pages, not web-wide discovery or held-out relevance.",
        "No external embeddings/reranking: native lexical retrieval with deterministic fixture vectors.",
        "No planning or reads in either research arm; not comparable with multistep baseline.",
        "Model verdicts are not accuracy scores. Hosting and labor not priced.",
      ],
    },
    null,
    2,
  ),
);
await db.close();
console.log(JSON.stringify({ output, crawl, models, searches }));
