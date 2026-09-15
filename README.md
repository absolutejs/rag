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
copied wholesale into public logs.

Keyword matching uses Unicode word segmentation and canonical normalization.
English suffix rules only apply to ASCII words. This improves multilingual exact
matches; it does not replace evaluation of the selected embedding model.
