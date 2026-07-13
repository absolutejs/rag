import {
  defineImplementation,
  defineManifest,
  toolFactory,
} from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type {
  CreateRAGCollectionOptions,
  CrossEncoderRerankerConfig,
  GeminiEmbeddingsConfig,
  HeuristicRAGRerankerOptions,
  InMemoryRAGStoreOptions,
  OllamaEmbeddingsConfig,
  OpenAIEmbeddingsConfig,
  RAGCollection,
} from "../types";

const tool = toolFactory<RAGCollection>();

const EXCERPT_LENGTH = 300;
const MAX_TOP_K = 100;
const MAX_DIMENSIONS = 8192;

/* Serializable subset of CreateRAGCollectionOptions: the retrieval defaults.
 * `store`, `embedding`, `rerank`, `queryTransform`, and `retrievalStrategy`
 * are instance-valued → slots (the first three) and wiring concerns. */
export const manifest = defineManifest<
  CreateRAGCollectionOptions,
  RAGCollection
>()({
  contract: 1,
  identity: {
    accent: "#10b981",
    category: "ai",
    description:
      "Retrieval-augmented generation for AbsoluteJS: ingest documents, URLs, and uploads into a pluggable vector store (`rag/vector-store`), embed with any provider (`rag/embedding-provider`), search with hybrid vector + lexical retrieval, optionally rerank (`rag/reranker`), and mount the `ragChat` Elysia plugin for grounded answers with citations. Evaluation suites, sync sources, and admin surfaces included.",
    docsUrl: "https://github.com/absolutejs/rag",
    name: "@absolutejs/rag",
    tagline: "Answer questions from your own content.",
  },
  implements: [
    defineImplementation<InMemoryRAGStoreOptions>()({
      contract: "rag/vector-store",
      factory: "createInMemoryRAGStore",
      from: "@absolutejs/rag",
      settings: Type.Object({
        dimensions: Type.Optional(
          Type.Integer({
            description:
              "Vector size used by the built-in fallback embedding. Match your embedding provider's output size.",
            maximum: MAX_DIMENSIONS,
            minimum: 1,
            title: "Vector dimensions",
          }),
        ),
      }),
      title: "In memory (development only — content is lost on restart)",
      wiring: {
        code: "createInMemoryRAGStore(${settings})",
        imports: [
          { from: "@absolutejs/rag", names: ["createInMemoryRAGStore"] },
        ],
      },
    }),
    defineImplementation<OpenAIEmbeddingsConfig>()({
      contract: "rag/embedding-provider",
      factory: "openaiEmbeddings",
      from: "@absolutejs/rag",
      requires: {
        env: [
          {
            description: "OpenAI API key",
            docsUrl: "https://platform.openai.com/api-keys",
            example: "sk-xxxxxxxxx",
            key: "OPENAI_API_KEY",
            secret: true,
          },
        ],
      },
      settings: Type.Object({
        defaultModel: Type.Optional(
          Type.String({
            description:
              "Embedding model used when a request doesn't name one.",
            examples: ["text-embedding-3-small"],
            title: "Embedding model",
          }),
        ),
        dimensions: Type.Optional(
          Type.Integer({
            description:
              "Vector size to request from the model. Must match your vector store's configured size.",
            maximum: MAX_DIMENSIONS,
            minimum: 1,
            title: "Vector dimensions",
          }),
        ),
      }),
      title: "OpenAI embeddings",
      wiring: {
        code: 'openaiEmbeddings({ apiKey: ${env.OPENAI_API_KEY} ?? "", ...${settings} })',
        imports: [{ from: "@absolutejs/rag", names: ["openaiEmbeddings"] }],
      },
    }),
    defineImplementation<GeminiEmbeddingsConfig>()({
      contract: "rag/embedding-provider",
      factory: "geminiEmbeddings",
      from: "@absolutejs/rag",
      requires: {
        env: [
          {
            description: "Google AI Studio API key for Gemini",
            docsUrl: "https://aistudio.google.com/apikey",
            example: "AIzaXXXXXXXX",
            key: "GEMINI_API_KEY",
            secret: true,
          },
        ],
      },
      settings: Type.Object({
        defaultModel: Type.Optional(
          Type.String({
            description:
              "Embedding model used when a request doesn't name one.",
            examples: ["gemini-embedding-001"],
            title: "Embedding model",
          }),
        ),
        dimensions: Type.Optional(
          Type.Integer({
            description:
              "Vector size to request from the model. Must match your vector store's configured size.",
            maximum: MAX_DIMENSIONS,
            minimum: 1,
            title: "Vector dimensions",
          }),
        ),
      }),
      title: "Gemini embeddings",
      wiring: {
        code: 'geminiEmbeddings({ apiKey: ${env.GEMINI_API_KEY} ?? "", ...${settings} })',
        imports: [{ from: "@absolutejs/rag", names: ["geminiEmbeddings"] }],
      },
    }),
    defineImplementation<OllamaEmbeddingsConfig>()({
      contract: "rag/embedding-provider",
      factory: "ollamaEmbeddings",
      from: "@absolutejs/rag",
      settings: Type.Object({
        baseUrl: Type.Optional(
          Type.String({
            description: "Where your Ollama server is reachable.",
            examples: ["http://localhost:11434"],
            format: "uri",
            title: "Ollama server URL",
          }),
        ),
        defaultModel: Type.Optional(
          Type.String({
            description:
              "Embedding model used when a request doesn't name one.",
            examples: ["nomic-embed-text"],
            title: "Embedding model",
          }),
        ),
      }),
      title: "Ollama (runs on your own machine, no API key)",
      wiring: {
        code: "ollamaEmbeddings(${settings})",
        imports: [{ from: "@absolutejs/rag", names: ["ollamaEmbeddings"] }],
      },
    }),
    defineImplementation<HeuristicRAGRerankerOptions>()({
      contract: "rag/reranker",
      factory: "createHeuristicRAGReranker",
      from: "@absolutejs/rag",
      title: "Built-in heuristic (no API key, keyword overlap scoring)",
      wiring: {
        code: "createHeuristicRAGReranker()",
        imports: [
          { from: "@absolutejs/rag", names: ["createHeuristicRAGReranker"] },
        ],
      },
    }),
    defineImplementation<CrossEncoderRerankerConfig>()({
      contract: "rag/reranker",
      factory: "createCohereRAGReranker",
      from: "@absolutejs/rag",
      requires: {
        env: [
          {
            description: "Cohere API key",
            docsUrl: "https://dashboard.cohere.com/api-keys",
            key: "COHERE_API_KEY",
            secret: true,
          },
        ],
      },
      settings: Type.Object({
        defaultModel: Type.Optional(
          Type.String({
            description: "Rerank model used when a request doesn't name one.",
            examples: ["rerank-v3.5"],
            title: "Rerank model",
          }),
        ),
      }),
      title: "Cohere reranker",
      wiring: {
        code: 'createCohereRAGReranker({ apiKey: ${env.COHERE_API_KEY} ?? "", ...${settings} })',
        imports: [
          { from: "@absolutejs/rag", names: ["createCohereRAGReranker"] },
        ],
      },
    }),
    defineImplementation<CrossEncoderRerankerConfig>()({
      contract: "rag/reranker",
      factory: "createVoyageRAGReranker",
      from: "@absolutejs/rag",
      requires: {
        env: [
          {
            description: "Voyage AI API key",
            docsUrl: "https://dashboard.voyageai.com",
            key: "VOYAGE_API_KEY",
            secret: true,
          },
        ],
      },
      settings: Type.Object({
        defaultModel: Type.Optional(
          Type.String({
            description: "Rerank model used when a request doesn't name one.",
            examples: ["rerank-2"],
            title: "Rerank model",
          }),
        ),
      }),
      title: "Voyage AI reranker",
      wiring: {
        code: 'createVoyageRAGReranker({ apiKey: ${env.VOYAGE_API_KEY} ?? "", ...${settings} })',
        imports: [
          { from: "@absolutejs/rag", names: ["createVoyageRAGReranker"] },
        ],
      },
    }),
    defineImplementation<CrossEncoderRerankerConfig>()({
      contract: "rag/reranker",
      factory: "createJinaRAGReranker",
      from: "@absolutejs/rag",
      requires: {
        env: [
          {
            description: "Jina AI API key",
            docsUrl: "https://jina.ai/api-dashboard",
            key: "JINA_API_KEY",
            secret: true,
          },
        ],
      },
      settings: Type.Object({
        defaultModel: Type.Optional(
          Type.String({
            description: "Rerank model used when a request doesn't name one.",
            examples: ["jina-reranker-v2-base-multilingual"],
            title: "Rerank model",
          }),
        ),
      }),
      title: "Jina AI reranker",
      wiring: {
        code: 'createJinaRAGReranker({ apiKey: ${env.JINA_API_KEY} ?? "", ...${settings} })',
        imports: [
          { from: "@absolutejs/rag", names: ["createJinaRAGReranker"] },
        ],
      },
    }),
  ],
  requires: {
    peers: [
      {
        name: "elysia",
        range: ">= 1.4.18",
        reason: "HTTP host for the ragChat routes",
      },
    ],
  },
  settings: Type.Object({
    defaultCandidateMultiplier: Type.Optional(
      Type.Integer({
        description:
          "How many extra candidates to fetch before reranking narrows them down. Higher finds more but costs more.",
        maximum: 20,
        minimum: 1,
        title: "Candidate multiplier",
      }),
    ),
    defaultModel: Type.Optional(
      Type.String({
        description:
          "Embedding model requested when a search doesn't name one. Leave empty to use the embedding provider's default.",
        title: "Default embedding model",
      }),
    ),
    defaultTopK: Type.Optional(
      Type.Integer({
        description:
          "How many matching passages a search returns by default. Default is 5.",
        maximum: MAX_TOP_K,
        minimum: 1,
        title: "Results per search",
      }),
    ),
  }),
  slots: {
    embedding: {
      configPath: "embedding",
      contract: "rag/embedding-provider",
      description:
        "Which AI service turns your text into search vectors. Without one, a deterministic fallback is used — fine for demos, not for real semantic search.",
      known: [
        "@absolutejs/rag#openai",
        "@absolutejs/rag#gemini",
        "@absolutejs/rag#ollama",
      ],
    },
    rerank: {
      configPath: "rerank",
      contract: "rag/reranker",
      description:
        "Optional second pass that reorders search results by relevance before they are used.",
      known: [
        "@absolutejs/rag#heuristic",
        "@absolutejs/rag#cohere",
        "@absolutejs/rag#voyage",
        "@absolutejs/rag#jina",
      ],
    },
    store: {
      configPath: "store",
      contract: "rag/vector-store",
      description: "Where your content's search index lives",
      known: [
        "@absolutejs/rag#memory",
        "@absolutejs/rag-pinecone",
        "@absolutejs/rag-postgres",
        "@absolutejs/rag-sqlite",
      ],
      required: true,
    },
  },
  tools: {
    ingest_status: tool.runtime({
      annotations: { readOnlyHint: true },
      description:
        "Report the vector store backing this collection: backend, vector mode, dimensions, and capabilities (persistence, native vector search, server-side filtering). Not every store reports status.",
      handler: (_input, collection) => {
        const status = collection.getStatus?.();
        const capabilities = collection.getCapabilities?.();

        if (status === undefined && capabilities === undefined) {
          return "this vector store does not report status";
        }

        return JSON.stringify({ capabilities, status });
      },
      input: Type.Object({}),
    }),
    ingest_text: tool.runtime({
      annotations: { idempotentHint: true },
      description:
        "Add (or replace) one text document in the search index under a stable sourceId. Re-ingesting the same sourceId replaces its previous chunks, so it is safe to repeat.",
      handler: async ({ sourceId, text, title }, collection) => {
        const result = await collection.ingestSource({
          document: { text, title },
          sourceId,
        });

        return `ingested ${result.chunkCount} chunks for ${result.sourceId}`;
      },
      input: Type.Object({
        sourceId: Type.String({
          description:
            "Stable identifier for this document — reuse it to update, pass it to remove_source to delete.",
          minLength: 1,
        }),
        text: Type.String({ minLength: 1 }),
        title: Type.Optional(Type.String()),
      }),
    }),
    remove_source: tool.runtime({
      annotations: { destructiveHint: true, idempotentHint: true },
      description:
        "Delete every indexed chunk previously ingested under a sourceId. Removing an unknown sourceId deletes nothing and succeeds.",
      handler: async ({ chunkCount, sourceId }, collection) => {
        const result = await collection.removeSource({
          chunkCount,
          sourceId,
        });

        return `removed ${result.deleted} chunks for ${result.sourceId}`;
      },
      input: Type.Object({
        chunkCount: Type.Optional(
          Type.Integer({
            description:
              "Chunk count from the original ingest — needed on stores that cannot delete by metadata filter.",
            minimum: 0,
          }),
        ),
        sourceId: Type.String({ minLength: 1 }),
      }),
    }),
    search_content: tool.runtime({
      annotations: { readOnlyHint: true },
      description:
        "Search the indexed content and return the best-matching passages with scores, titles, and sources. Use this to ground answers in the site's own content.",
      handler: async ({ query, scoreThreshold, topK }, collection) => {
        const results = await collection.search({
          query,
          scoreThreshold,
          topK,
        });

        return JSON.stringify(
          results.map(({ chunkId, chunkText, score, source, title }) => ({
            chunkId,
            excerpt:
              chunkText.length > EXCERPT_LENGTH
                ? `${chunkText.slice(0, EXCERPT_LENGTH)}…`
                : chunkText,
            score,
            source,
            title,
          })),
        );
      },
      input: Type.Object({
        query: Type.String({ minLength: 1 }),
        scoreThreshold: Type.Optional(
          Type.Number({
            description: "Drop results scoring below this value.",
            maximum: 1,
            minimum: 0,
          }),
        ),
        topK: Type.Optional(Type.Integer({ maximum: MAX_TOP_K, minimum: 1 })),
      }),
    }),
  },
  wiring: [
    {
      description:
        "Create a searchable collection from a vector store and an embedding provider, then mount the chat routes.",
      id: "default",
      server: {
        code: [
          "const ragCollection = createRAGCollection({",
          "\tembedding: ${slot.embedding},",
          "\tstore: ${slot.store},",
          "\t...${settings}",
          "});",
          "",
          "// Mount grounded chat + admin routes with: app.use(ragChat({ collection: ragCollection }))",
        ].join("\n"),
        imports: [
          {
            from: "@absolutejs/rag",
            names: ["createRAGCollection", "ragChat"],
          },
        ],
        placement: "module-scope",
      },
      title: "Create the RAG collection",
    },
    {
      description:
        "Same as the default recipe plus a reranking pass that reorders results by relevance before use.",
      id: "reranked",
      server: {
        code: [
          "const ragCollection = createRAGCollection({",
          "\tembedding: ${slot.embedding},",
          "\trerank: ${slot.rerank},",
          "\tstore: ${slot.store},",
          "\t...${settings}",
          "});",
        ].join("\n"),
        imports: [{ from: "@absolutejs/rag", names: ["createRAGCollection"] }],
        placement: "module-scope",
      },
      title: "Collection with reranking",
    },
  ],
});
