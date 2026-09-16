import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createMemoryStore,
  type AIContextEvent,
  type AIProviderStreamParams,
} from "@absolutejs/ai";
import { ragChat } from "../src/chat/chat";
import { createInMemoryRAGStore } from "../src/adapters/inMemory";
import { createRAGCollection } from "../src/retrieval/collection";

for (const raw of [false, true])
  test(`RAG SSE forwards ${raw ? "explicit raw opt-out" : "working context target after retrieval"}`, async () => {
    const collection = createRAGCollection({
      store: createInMemoryRAGStore({
        dimensions: 2,
        mockEmbedding: async () => [1, 0],
      }),
    });
    await collection.ingest({
      chunks: [
        {
          chunkId: "original",
          text: "Original budget £17,431.29",
          source: "original",
        },
      ],
    });
    const store = createMemoryStore();
    const conversation = await store.getOrCreate("context-test");
    conversation.messages.push({
      id: "question",
      conversationId: "context-test",
      role: "user",
      content: "What is the budget?",
      timestamp: Date.now(),
    });
    await store.set("context-test", conversation);
    const events: AIContextEvent[] = [];
    const counted: AIProviderStreamParams[] = [];
    let requests = 0;
    const app = new Elysia().use(
      ragChat({
        path: "/rag",
        store,
        collection,
        htmx: true,
        model: "test",
        contextPolicy: raw
          ? false
          : {
              workingInputTokens: 100,
              onEvent: (event) => {
                events.push(event);
              },
            },
        provider: () => ({
          inputCapacity: {
            getLimits: async () => ({
              maxInputTokens: 2000,
              maxOutputTokens: 100,
            }),
            countTokens: async (params) => {
              counted.push(params);
              return 800;
            },
          },
          stream: async function* () {
            requests++;
            yield { type: "text", content: "The budget is £17,431.29" };
            yield { type: "done" };
          },
        }),
      }),
    );
    const response = await app.handle(
      new Request("http://localhost/rag/sse/context-test/question"),
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(requests).toBe(raw ? 1 : 0);
    if (raw) expect(body).toContain("The budget is £17,431.29");
    else {
      expect(events[0]).toMatchObject({
        type: "checked",
        capacity: { workingInputTokens: 100 },
      });
      expect(JSON.stringify(counted[0]?.messages)).toContain(
        "Original budget £17,431.29",
      );
      expect(body).toContain("working context budget");
    }
  });
