# @absolutejs/rag

A standalone RAG runtime for Bun and Elysia applications covering document ingestion, chunking, embeddings, hybrid retrieval, reranking, source synchronization, evaluation, client primitives, and framework bindings.

## Installation

```sh
bun add @absolutejs/rag
```

## Quick start

```ts
import {
	createInMemoryRAGStore,
	createRAGCollection,
	ingestRAGDocuments,
	openaiEmbeddings,
	searchDocuments
} from '@absolutejs/rag';

const collection = createRAGCollection({
	embedding: openaiEmbeddings({
		apiKey: process.env.OPENAI_API_KEY ?? '',
		defaultModel: 'text-embedding-3-small'
	}),
	store: createInMemoryRAGStore()
});

await ingestRAGDocuments(collection, {
	documents: [{ id: 'intro', text: 'AbsoluteJS ships typed Bun primitives.' }]
});

const results = await searchDocuments(collection, {
	query: 'What does AbsoluteJS ship?',
	topK: 3
});
```

## Retrieval and storage

The built-in memory store supports development and tests. Published adapters provide PostgreSQL with pgvector, SQLite with optional vec0 acceleration, and Pinecone behind the same `RAGVectorStore` contract. Lexical and vector results can be fused, transformed, and reranked with provider or heuristic rerankers.

### Retrieval channel requirements

Lexical and hybrid retrieval require a store implementing `queryLexical`.
A backend without that capability raises an actionable error before vector
embedding/search instead of silently returning vector-only or empty results.
Explicit vector retrieval remains supported on vector-only backends. Configure
a lexical-capable adapter before requesting hybrid retrieval; a mode flag does
not add a missing backend capability.

The built-in heuristic strategy preserves the requested retrieval mode when a
query is scoped by source or document ID. Scope narrows the searchable corpus;
it does not remove the need for exact keyword matches within that corpus.

## Ingestion and source sync

The ingestion pipeline handles files, directories, uploads, URLs, PDFs, office documents, archives, images, and media transcripts. Scheduled connectors can keep collections synchronized from email, GitHub, sitemaps, feeds, directories, and S3-compatible storage.

## Quality and evaluation

`@absolutejs/rag/quality` evaluates retrieval relevance and answer grounding, compares strategies and rerankers, and records runs against a baseline so retrieval changes can be tested before release.

## Client and framework entry points

- `@absolutejs/rag/client` and `/client/ui` provide browser-side primitives.
- `@absolutejs/rag/react`, `/vue`, `/svelte`, and `/angular` provide framework bindings.
- `@absolutejs/rag/adapter-kit` exposes the contracts used by vector-store adapters.
- `@absolutejs/rag/ui` exposes presentation-neutral UI contracts.

Pair the retrieval runtime with `@absolutejs/ai` when retrieved context should feed a model or streaming assistant.

### Verbatim original text evidence

Use `chunkRAGOriginalText({ sourceId, version, text }, options)` when citations
must resolve against an immutable text original. This opt-in path preserves
whitespace and Unicode instead of normalizing or extracting document formats.
Each chunk includes `metadata.sourceLocator` with the source ID, immutable
version and UTF-16 `start`/`end` offsets. `readRAGOriginalText` validates identity,
version and range before returning the exact original slice. Store and authorize
the original separately; a locator is not an access grant.

`createRAGOriginalTextTools({ collection, filter, loadSource, budget })` provides
`search_text_source` and `read_text_source` AI tools. It requests real hybrid
retrieval with diversity and verifies evidence against originals. `filter` is a
server-owned scope; `loadSource(id, version)` must reauthorize every read and
return `null` for inaccessible/deleted versions. The tools require
`budget: { maxTokens, countTokens }` using the model tokenizer and a budget
reserved by the AI context policy. Whole passages are selected within that
budget; omitted passages are flagged rather than silently truncated. Add the
final tools/instructions before budgeting the model request. Search traces are
available through `onTrace`; they contain retrieval metadata and should not be
copied wholesale into public logs. Servers may set `searchTopK` to an integer
from 1 to 48 (default 12) for a smaller initial evidence lookup. Candidate ranking
still considers up to 48 matches; authorization and token-budget checks are
unchanged. A small initial result set does not establish that other facts are
absent: retain broader search/read tools for missing or ambiguous evidence.

Keyword matching uses Unicode word segmentation and canonical normalization.
English suffix rules only apply to ASCII words. This improves multilingual exact
matches; it does not replace evaluation of the selected embedding model.

#### AI context policy compatibility

With the AI 0.1 context-policy release, RAG chat validates the final assembled
retrieval context before every model request. Its `contextPolicy` config is
forwarded to both WebSocket and SSE generation. Use a working token target or a
saved-source recovery callback when appropriate. Providers without capacity
support require an explicit `contextPolicy: false` raw opt-out. Older supported
AI peers retain their previous behavior; upgrading RAG alone does not add the AI
0.1 capacity policy. No model-capacity numbers are defined in RAG.

### Reversible quote references

`createRAGQuoteReferences()` creates a request-scoped registry for compressing
already-verified original-text tool results. `encodeToolResult(json)` replaces
passage text with sentence entries `{ citation, text }`; `resolve(citation)`
restores the exact registered sentence. Repeated sentences reuse a reference,
and unknown references throw. Search and single-range read envelopes are
supported; unrecognized tool results pass through unchanged.

Keep the registry alive across prefetch, lookups and completion, then discard
it. Only encode server-owned original-text tool results. References are not
access controls or durable source IDs: reauthorize and validate restored quotes
against the originals before saving a result. This is opt-in; it does not change
the original-text tools, stored originals or their existing result format.

### Public websites and JavaScript rendering

`loadRAGDocumentFromURL` loads a document; use `prepareRAGDocument(doc).normalizedText`
for readable text. URL loading now honors response MIME types on extensionless URLs.
For public websites, `@absolutejs/rag/web` provides `readRAGWebpage` with bounded
responses, timeouts, prepared text, final URL, title, truncation and per-attempt
retrieval diagnostics. It tries static HTML first and requests a browser for thin
or empty application shells. A missing renderer returns `rendering_required`,
not a claim that the website contains no information.

```ts
import { readRAGWebpage } from '@absolutejs/rag/web';
import { createPlaywrightWebRenderer } from '@absolutejs/rag/web/playwright';

const browser = createPlaywrightWebRenderer();
try {
  const page = await readRAGWebpage({
    url: 'https://example.com',
    render: browser.render,
  });
  // Check page.status and page.error before treating page.text as complete evidence.
} finally {
  await browser.close();
}
```

The browser adapter requires the optional `playwright-core` peer and an installed
Chromium browser (`playwright-core install --with-deps chromium`). Hosts should
run it in a separate unprivileged process, limit concurrency, and apply memory
limits. Contexts do not share cookies; service workers and WebSockets are blocked.
HTTP resources and redirect hops use validated public destinations with the DNS
answer pinned to each connection. Browser resource counts and response sizes are
bounded. The reader does not bypass login, CAPTCHA or access restrictions, and
reports these failures separately from incomplete rendering. A page read is not
a crawl of every page on a domain. Host-supplied renderers/fetch implementations
must enforce equivalent network controls.

### Research related website pages with attributable evidence

`readRAGWebsite` from `@absolutejs/rag/web` reads a supplied URL and up to three
relevant same-origin customer, services and company pages by default. Pass the
optional Playwright renderer as for `readRAGWebpage`. `maxPages: 1` retains a
single-page read; `mode: "browser"` retries content missed by static extraction.
Results attribute text to exact page URLs and retain per-page redirects,
retrieval attempts, semantic image labels, link destinations, media URLs and
available caption text. Coverage includes unvisited relevant links and deadline
limits. HTTP redirects carry their actual status; client navigation is labeled
separately. Empty image labels are not proof of an absent client list, and media
URLs are not proof that a video was watched. Consumers must cite source URLs,
distinguish extracted evidence from inference, and finish the requested research
without treating a successful page fetch as complete company coverage.
