# Web research workflows

`@absolutejs/rag/research` composes Search, the RAG web reader, AI structured generation, field evidence review, and optional billing admission. The runtime lives on the server. React, Vue, Svelte, Angular, HTML and HTMX share the same authorized endpoints.

## Configure once

```ts
import { Elysia } from "elysia";
import { Type } from "@sinclair/typebox";
import { anthropic } from "@absolutejs/ai/anthropic";
import { createBraveSearch } from "@absolutejs/search/brave";
import {
  createResearch,
  researchPlugin,
  researchMonitorTask,
} from "@absolutejs/rag/research";

const research = createResearch({
  search: createBraveSearch({ apiKey: process.env.BRAVE_SEARCH_API_KEY! }),
  provider: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  model: process.env.RESEARCH_MODEL!,
  tasks: {
    company: {
      schema: Type.Object({ name: Type.String(), description: Type.String() }),
    },
    signals: researchMonitorTask,
  },
  limits: { searches: 4, reads: 4, rounds: 2, timeoutMs: 90_000 },
  // Optional: explicitly scoped public evidence, never implicit tenant sharing.
  cache: { scope: "public-company-evidence", ttlMs: 300_000 },
});

// In an existing app, use its actual session/agent authorization here.
const plugin = researchPlugin({
  runtime: research,
  authorize: authorizeResearchRequest,
});
const app = new Elysia().use(plugin);

const result = await research.run({
  query: "Example company",
  task: "company",
});
```

`authorizeResearchRequest` is your application's authorization function, not an export of this package. It is required. For multiple tenants, pass `runtime: request => runtimeForAuthorizedTenant(request)`; authorization runs first. Scope tenant caches, workflows and budget ledgers to the same resolved identity. The plugin rejects cross-origin browser POSTs and sends `Cache-Control: no-store`. Do not treat a caller-supplied tenant header as identity.

`run` selects server-registered schemas; browsers cannot override models, limits, schemas or credentials. `extract({schema, instructions}, input)` accepts a typed TypeBox schema directly for trusted server code. The same configured AI provider handles planning, extraction and independent review, with transport retries and schema repair retries disabled.

Default limits are four searches, four page reads, two planning rounds, 90 seconds, 32,000 evidence characters, 4,096 output tokens per model call and 128 primitive output fields. Limits are per research call, not per entire batch. Page reading uses the existing hardened public web transport; optional `render` enables your existing browser service. A browser process is not provisioned automatically. Cancellation must also be honored by custom providers and readers.

Quoted entity phrases are required in accepted source text by default. Trusted server callers may supply `requiredPhrases` explicitly. This conservative check can miss legitimate aliases; semantic matching and recall still require evaluation.

## Read the result

- `data` contains the schema-shaped result only when all primitive fields pass review; otherwise it is `null`.
- `fields` always preserves reviewed JSON-pointer paths, values, verdicts, reasons and source-bound quotations. Inspect verdicts before consuming individual values from a partial result.
- Verdicts are `supported`, `unsupported`, `conflicting`, or `unknown`. Null values, missing reviews, duplicate review paths, and invalid quotations cannot become supported facts.
- `sources`, `searches`, `operations`, and `limitations` retain provenance and execution information. Search/page/model failures are not successful empty results.
- `reviewed` describes a model review with deterministic citation checks. It does not establish independent truth, exhaustive recall, current employment, email deliverability or buying intent.

## Framework flows

All bindings call the same streaming endpoint, expose progress and cancellation, and fence late results from an earlier request. Use `state.result.fields` for citations and field verdicts.

### React

```tsx
import { useResearch } from "@absolutejs/rag/react";
function ResearchButton() {
  const { run, cancel, state } = useResearch("/research");
  return (
    <>
      <button
        onClick={() =>
          void run({ query: "Example company", task: "company" }).catch(
            () => {},
          )
        }
      >
        Research
      </button>
      <button onClick={cancel}>Cancel</button>
      <pre>{JSON.stringify(state.result ?? state.progress ?? state.error)}</pre>
    </>
  );
}
```

### Vue

```ts
import { useResearch } from "@absolutejs/rag/vue";
// Within setup/effect scope; state is a shallow ref. Scope disposal cancels work.
const { run, cancel, state } = useResearch("/research");
await run({ query: "Example company", task: "company" });
console.log(state.value.result);
```

### Svelte

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { createResearchStore } from '@absolutejs/rag/svelte';
  const research = createResearchStore('/research');
  const { state } = research;
  onDestroy(research.dispose);
</script>
<button onclick={() => research.run({ query: 'Example company' }).catch(() => {})}>Research</button>
<button onclick={research.cancel}>Cancel</button>
<pre>{JSON.stringify($state.result ?? $state.progress ?? $state.error)}</pre>
```

### Angular

```ts
import { DestroyRef, inject } from "@angular/core";
import { ResearchService } from "@absolutejs/rag/angular";
// Component field initializers; DestroyRef binds cancellation to this component.
research = inject(ResearchService).connect("/research", inject(DestroyRef));
// this.research.run({ query: 'Example company', task: 'company' });
// this.research.state().result; this.research.cancel();
```

### HTML

```html
<form id="research">
  <input name="query" required /><button>Research</button>
</form>
<pre id="result" aria-live="polite"></pre>
```

```ts
import { bindResearchForm } from "@absolutejs/rag/research/client";
const research = bindResearchForm(
  document.querySelector<HTMLFormElement>("#research")!,
  document.querySelector<HTMLElement>("#result")!,
);
// research.cancel(); research.dispose() when removing the form.
```

For custom UI use `createResearchClient({path, fetch, headers})`. HTML output uses `textContent`. HTTP credentials are same-origin; framework hooks work with your existing session cookies.

### HTMX

```html
<form
  hx-post="/research/html"
  hx-target="#result"
  hx-indicator="#researching"
  hx-sync="this:replace"
>
  <input name="query" required />
  <button>Research</button>
</form>
<span id="researching" class="htmx-indicator">Researching…</span>
<section id="result" aria-live="polite"></section>
```

This path accepts form-urlencoded input and returns an escaped HTML fragment with verdicts and source links. Request aborts propagate through the runtime. HTMX and client JavaScript assets are installed/served by your application as usual.

## Company discovery

```ts
import { discoverResearchCompanies } from "@absolutejs/rag/research";
const found = await discoverResearchCompanies(research, {
  query: "Companies manufacturing grid-scale battery storage in Germany",
  criteria: [
    {
      id: "manufactures",
      description: "Manufactures grid-scale battery storage equipment",
    },
  ],
  limit: 5,
});
// found.candidates includes evidence per criterion; found.accepted requires all to match.
```

Discovery verifies candidate name/domain fields, deduplicates exact hostnames, and researches each criterion separately. Missing evidence produces `unknown`, not a negative claim. Corporate aliases and subsidiaries are not silently merged. Contact discovery remains available through `@absolutejs/discover`.

## Durable batches and monitoring

```ts
import { SQL } from "bun";
import {
  createPostgresResearchWorkflowStore,
  researchWorkflowPostgresSchemaSql,
  createResearchWorkflows,
  selectResearchMonitorEvents,
} from "@absolutejs/rag/research";

const sql = new SQL(process.env.DATABASE_URL!);
// Apply researchWorkflowPostgresSchemaSql() using your normal migration system.
const store = createPostgresResearchWorkflowStore({
  unsafe: (query, parameters) => sql.unsafe(query, parameters),
});
const workflows = createResearchWorkflows({
  runtime: research,
  store,
  scope: "tenant:resolved-id",
  version: "company-research-v1",
  leaseMs: 120_000, // must exceed the configured runtime deadline
});

await workflows.batch({
  id: "import-2026-09",
  items: [{ id: "example", query: "Example company", task: "company" }],
});
await workflows.monitor({
  id: "example-signals",
  query: "New events at Example company",
  task: "signals",
  select: selectResearchMonitorEvents,
});
await workflows.deliverMonitor("example-signals", async (event) => {
  // Deliver through your existing Dispatch/Execution adapter.
  // Receiver MUST deduplicate with event.id: delivery is at-least-once.
  await deliverYourNotification(event.id, event.payload);
});
```

These are background worker functions. Register them with the existing `@absolutejs/queue` job registry and use your established cron/control-plane trigger; no new scheduler or process is installed. Job payloads should contain authorized tenant/workflow IDs, with the worker resolving runtime and configuration server-side. Large batches should be enqueued, not held in an HTTP request.

A batch retains each completed research result (including partial/unavailable outcomes); repeating the same item reuses it. Use a new batch/item ID for an intentional rerun. Reusing an ID with changed input or task version fails. The first successful monitor run, including a successful empty result, establishes a silent baseline. Incomplete research retains the previous baseline. Verified new events update state and durable delivery records in one fenced database statement. Expired workers cannot commit over successors.

The event helper deduplicates normalized entity/type/summary/date. It does not semantically cluster differently worded reports of the same event. For stable domain event IDs, configure your own `select`. At 10,000 seen IDs a monitor stops rather than silently forgetting and resending history. Persisted research contains source excerpts; apply your normal tenant data retention policy.

`createMemoryResearchWorkflowStore()` is for tests and local demos only. PostgreSQL is the durable implementation. Scheduled cadence, subscriptions, recipient selection, retention and delivery policy belong to the host.

## Spending policy

Operation limits work without billing configuration. For a shared monetary allowance, configure `budget` using the existing `createProviderBudget` ledger from `@absolutejs/billing/provider-budget`:

```ts
const budget = {
  ledger: createProviderBudget(creditSqlClient),
  scope: "tenant:resolved-id:research",
  period: () => new Date().toISOString().slice(0, 10),
  maxMicros: dailyAllowanceMicros,
  maxRequests: dailyOperationAllowance,
  reserveMicros: configuredOperationPriceCeilings, // search/read/plan/extract/review
  actualMicros: priceObservedOperation, // returns integer micros or null if unknown
};
// createResearch({ ...providerConfiguration, budget });
```

The price policy must match the configured models, token ceilings and reader/search services. Unknown outcomes retain the reservation. A measured cost exceeding its configured ceiling stops the research after settlement. No model prices are hardcoded, and unknown costs are never treated as zero. The billing table is installed through the billing package's existing migration contract. `admit` remains available for custom policy, such as combining this ledger with existing rate-limit admission; do not supply both `budget` and `admit`.

## Agent tools and configuration recipe

```ts
import { researchManifest } from "@absolutejs/rag/research";
import { toAIToolMap, toMcpToolRegistry } from "@absolutejs/manifest";
const aiTools = toAIToolMap(researchManifest, { runtime: research, enforce });
const mcpTools = toMcpToolRegistry(researchManifest, {
  runtime: research,
  enforce,
});
```

`enforce` is the host's existing policy/Agency binding. Tools require `research:run`; unguarded bridges omit them. The manifest's Brave/Anthropic recipe configures credentials from environment references and a user-selected model. Direct runtime configuration supports any compatible search/model provider. The search package supplies its own `search_web` tool and Brave recipe.

## Evaluate before claiming equivalence

Use `evaluateResearch` to run representative cases with optional independent human review and total measured cost. Unreviewed acceptance, unknown cost, and cost per accepted finding without accepted findings remain `null`. Publication freshness measures source publication dates; it is not event freshness.

Each result includes `groundingCase`, accepted by the existing `evaluateRAGAnswerGrounding({cases})` function from `@absolutejs/rag/quality`. Citation resolution metrics do not establish factual correctness or discovery recall. Keep approved ground truth and reviewer identity with comparisons, and hold task/model/budget policy constant when switching search providers.
