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
