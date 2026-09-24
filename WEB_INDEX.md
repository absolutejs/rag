# Owned web indexes

`@absolutejs/rag/web-index` composes protected crawling, PostgreSQL coordination, versioned evidence and a `SearchProvider`. Configure selected public origins, storage and model providers once. The same provider feeds the research runtime, batches, monitoring and framework clients.

## Server

```ts
import { Elysia } from "elysia";
import { createRAGCollection } from "@absolutejs/rag";
import { createPostgresRAGStore } from "@absolutejs/rag-postgres";
import {
  createWebIndex, createPostgresWebIndexStore, webIndexPostgresSchemaSql,
  webIndexPlugin, startWebIndexWorker,
} from "@absolutejs/rag/web-index";

const db = new Bun.SQL(process.env.DATABASE_URL!);
// Run this schema initialization in your deployment's migration phase.
await db.unsafe(webIndexPostgresSchemaSql());
const collection = createRAGCollection({
  store: createPostgresRAGStore({ sql: db, tableName: "public_web_chunks", dimensions: 1536 }),
  embedding: configuredEmbeddingProvider,
});
const index = createWebIndex({
  tenant: "public", index: "partner-sites",
  store: createPostgresWebIndexStore(db),
  origins: ["https://example.com"],
  generations: [{
    id: "v1", collection,
    embedding: { provider: "your-provider", model: "your-model", dimensions: 1536 },
    retrieval: "hybrid",
  }],
  limits: { maxUrls: 1000, maxPagesPerRun: 20, maxBytesPerRun: 20_000_000, maxChunksPerPage: 100, maxDepth: 3 },
  recrawlMs: 6 * 60 * 60 * 1000,
  originDelayMs: 1000,
  admit: async work => reserveEmbeddingWork(work),
});
const app = new Elysia().use(webIndexPlugin({
  runtime: index,
  authorize: async (request, operation) => authorizeIndexOperation(request, operation),
}));
await index.enqueue(["https://example.com/"]);
const worker = startWebIndexWorker({ runtime: index, onError: error => console.error(error) });
// On shutdown, await worker.stop() before closing the database.
const result = await index.search({ query: "partnership eligibility", count: 5 });
```

`configuredEmbeddingProvider`, `reserveEmbeddingWork` and `authorizeIndexOperation` are host implementations, not exports. Use the embedding/reranker adapters already supported by `createRAGCollection`; do not train a model. Meter ingestion, query embeddings and reranking through those configured providers. For lexical-only workloads, set `retrieval: "lexical"`; explicitly identify any deterministic fallback embedding as such in the generation metadata. Provider and infrastructure prices are unknown to the runtime, so it reports `null`, never a fabricated zero.

For private corpora, resolve the authenticated request to a **server-selected** runtime with its own tenant/index. Every route requires authorization. `read`, `crawl` and `admin` are distinct operations. Cross-origin requests are rejected. Never accept tenant identity, arbitrary origins, credentials, budgets or provider configuration from a request body. Trusted service-to-service callers without an Origin header still require authorization.

## Research and entities

```ts
import { createResearch, researchPlugin } from "@absolutejs/rag/research";
import { createWebIndexProjector } from "@absolutejs/rag/web-index";
const research = createResearch({
  provider: configuredAIProvider, model: extractionModel,
  reviewer: { provider: configuredAIProvider, model: reviewModel },
  search: index.provider,
});
app.use(researchPlugin({ runtime: research, authorize: authorizeResearch }));
const result = await research.run({ query: "Which partners meet these requirements?" });
const extract = createWebIndexProjector({
  kind: "company", instructions: "Identify the company and its partner eligibility requirements.",
  provider: configuredAIProvider, model: extractionModel,
  reviewer: { provider: configuredAIProvider, model: reviewModel },
  onResult: result => recordResearchAccounting(result),
});
await index.project({ url: "https://example.com/", extract });
const companies = await index.projections("company");
```

The projector uses one source version, extraction and separate review. It publishes only supported identity/facts with original passage references. Model support remains a fallible judgment. It does not establish buying intent. Custom extractors can attach explicit validity intervals; stale source versions cannot commit projections, and expired fields disappear from reads. `project` is a server function so the host controls model admission and task definitions.

## Six presentation frameworks

All operations use the authenticated server plugin. Clients start idle, cancel superseded requests and dispose on framework teardown. Cancellation cannot undo already committed work.

| Framework | Entry point | Usage |
| --- | --- | --- |
| React | `@absolutejs/rag/react` | `const index = useWebIndex(); await index.call("stats", {});` |
| Vue | `@absolutejs/rag/vue` | `const index = useWebIndex();` with reactive `state` |
| Svelte | `@absolutejs/rag/svelte` | `const index = createWebIndexStore();` with readable `state` |
| Angular | `@absolutejs/rag/angular` | `WebIndexService.connect("/web-index", destroyRef)` |
| HTML | `@absolutejs/rag/web-index/client` | `bindWebIndexSearchForm(form, output)`; dispose the returned binding |
| HTMX | `GET /web-index/html` | `<section hx-get="/web-index/html" hx-trigger="load, every 30s" hx-swap="innerHTML"></section>` |

`createWebIndexClient({ path, headers, fetch })` supplies typed `call(operation, input)`, subscriptions and cancellation. Operations: `stats`, `history`, `search`, `projections`, `enqueue`, `run`, `remove`, `restore`, `rebuild`, `activate`. HTML output is escaped; the HTML form binding uses textContent. Existing research hooks and HTMX research output work with `index.provider` without changes.

## Crawl, versions and changes

- Robots rules, redirect validation, per-origin leases and crawl delays apply to public reads. Network/429/5xx failures retain the prior version and schedule retry. Origin leases are shared across tenants in this store to avoid multiplying load on one site.
- Runs bound pages, decoded bytes, depth, passages and time. A run may stop with pending work because the origin is not yet eligible; the worker polls later. It is not an exhaustive crawl.
- ETag and Last-Modified support conditional requests. A 304 refreshes fetch time without embedding again. Publication dates come only from explicit article publication metadata; fetch time never becomes publication time.
- Canonical links are hints, not identity merges. Exact content hashes suppress duplicate results. Heading, parent-section and section-lead context accompany passages.
- Search filters declared by this provider are domain inclusion/exclusion and publication date bounds. Unsupported filters fail explicitly. Publication date predicates are applied before SQL top-K. Queries use active committed versions, including after a worker crashes mid-ingestion.
- 404/410/noindex remove active evidence; failures do not. `remove` creates a scope-wide takedown, removes history/projections and deletes chunks from configured generations. `restore` explicitly permits future crawling. Do not add a search-result cache without a host invalidation policy. The built-in index provider does not cache responses.
- A generation fixes provider/model/dimensions, origins and representation. Configure a new generation for a model or corpus-scope change, `rebuild(from, to, limit, after)` in pages, run its frontier, evaluate it, then `activate(newId, expectedOldId, { passed: true, evidence: reportReference })`. Activation checks readiness and uses compare-and-swap. The evidence report is a host assessment, not automatic proof of quality.

Schedule retention of obsolete generations in the host database/storage lifecycle. Crashed ingestion can leave unreferenced chunks; active-version checks exclude them from results. Storage reclamation must be coordinated with workers, and all retained generations must be configured when permanently purging their chunks. Do not share the disposable test database with running applications or benchmarks.

## Verification

`WEB_INDEX_TEST_DATABASE_URL=... bun test tests/webIndex.test.ts tests/webIndexFlows.test.ts` uses an explicit disposable PostgreSQL database with pgvector. Tests clear the owned-index tables in that database. They cover restart, native retrieval filters, worker fencing, tenant isolation, bounded admission, robots failure, conditional requests, deletion, model-generation isolation, authorization and evidence attribution.

`benchmarks/web-index/live.ts --live --output=NEW_PATH` declares four public pages and compares native lexical retrieval with Brave using identical extraction/review settings. It caps the run at eight research searches and sixteen model calls, preserves raw journals and reports cold/first and warm latency samples separately. It requires its own disposable database. Those pages were selected in advance; results are not web-wide or held-out discovery claims. No Exa parity is implied.
