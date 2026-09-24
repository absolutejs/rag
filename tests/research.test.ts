import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Elysia } from "elysia";
import { createResearch } from "../src/research/runtime";
import { bindResearchReview, researchLeaves } from "../src/research/evidence";
import { researchPlugin, renderResearchResult } from "../src/research/plugin";
import { createResearchClient } from "../src/client/research";
import type { AIProviderConfig } from "@absolutejs/ai";
import type { SearchProvider } from "@absolutejs/search";
import type { ResearchResult, ResearchRuntime } from "../src/research/types";
const source = {
  id: "external-id",
  url: "https://example.com/news",
  title: "Example",
  excerpts: ["Example announced its launch in 2026."],
  retrievedAt: "2026-09-24T00:00:00Z",
};
const search = (calls: string[] = []): SearchProvider => ({
  name: "fixture",
  version: "1",
  search: async (input) => {
    calls.push(input.query);
    return {
      provider: "fixture",
      version: "1",
      query: input.query,
      status: "ok",
      sources: [source],
      attempts: [],
      limitations: [],
    };
  },
});
const model = (
  outputs: unknown[],
  calls: unknown[] = [],
): AIProviderConfig => ({
  name: "fixture",
  async *stream(input) {
    calls.push(input);
    const output = outputs.shift();
    if (!output) throw new Error("Unexpected model call");
    yield {
      type: "tool_use",
      id: "1",
      name: input.tools![0]!.name,
      input: output as Record<string, unknown>,
    };
    yield { type: "done" };
  },
});
const empty: ResearchResult = {
  id: "1",
  status: "empty",
  data: null,
  fields: [],
  sources: [],
  searches: [],
  operations: [],
  generatedAt: "",
  limitations: [],
};
const citation = {
  sourceId: "s1",
  quote: "Example announced its launch in 2026.",
};
const review = {
  fields: [
    {
      path: "/name",
      verdict: "supported",
      citations: [citation],
      reason: "Explicit source statement",
    },
  ],
};
const plan = { queries: [], urls: [], done: true };

describe("research runtime", () => {
  test("configured schema extraction reviews every field and disables hidden retries", async () => {
    const calls: any[] = [];
    const runtime = createResearch({
      search: search(),
      provider: model([plan, { name: "Example" }, review], calls),
      model: "fixture",
    });
    const result = await runtime.extract(
      { schema: Type.Object({ name: Type.String() }) },
      { query: "Example launch" },
    );
    expect(result.status).toBe("reviewed");
    expect(result.data).toEqual({ name: "Example" });
    expect(result.fields[0]!.citations).toEqual([citation]);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.maxRetries === 0)).toBe(true);
  });
  test("follows up and reads only retrieved URLs within limits", async () => {
    const calls: string[] = [];
    const reads: string[] = [];
    const runtime = createResearch({
      search: search(calls),
      provider: model([
        {
          queries: ["followup", "extra"],
          urls: [source.url, "http://localhost/secret"],
          done: false,
        },
        { name: "Example" },
        review,
      ]),
      model: "fixture",
      limits: { rounds: 1, searches: 2, reads: 1 },
      reader: async (options) => {
        reads.push(options.url);
        return {
          status: "ok",
          url: options.url,
          finalUrl: options.url,
          text: source.excerpts[0]!,
          title: "Example",
          method: "http",
          truncated: false,
          fetchedAt: "",
          attempts: [],
          redirects: [],
          limitations: [],
          evidence: { links: [], images: [], media: [], canonicalUrl: null },
        };
      },
    });
    const result = await runtime.extract(
      { schema: Type.Object({ name: Type.String() }) },
      { query: "initial" },
    );
    expect(calls).toEqual(["initial", "followup"]);
    expect(reads).toEqual([source.url]);
    expect(result.status).toBe("partial");
  });
  test("invalid and duplicate reviews cannot promote unsupported facts", () => {
    const leaves = researchLeaves({ "a/b": true, count: 3, nil: null });
    expect(leaves.map((leaf) => leaf.path)).toEqual([
      "/a~1b",
      "/count",
      "/nil",
    ]);
    const fields = bindResearchReview(
      leaves,
      [
        {
          path: "/count",
          verdict: "supported",
          citations: [{ sourceId: "s1", quote: "made up citation" }],
          reason: "",
        },
      ],
      [{ ...source, id: "s1" }],
    );
    expect(fields.every((field) => field.verdict === "unknown")).toBe(true);
  });
  test("denied budget makes no provider call", async () => {
    const calls: string[] = [];
    const runtime = createResearch({
      search: search(calls),
      provider: model([]),
      model: "fixture",
      admit: async () => false,
    });
    const result = await runtime.run({ query: "test" });
    expect(result.status).toBe("unavailable");
    expect(calls).toEqual([]);
  });
  test("failed operation settles unknown and does not retry", async () => {
    const outcomes: string[] = [];
    const runtime = createResearch({
      search: {
        ...search(),
        search: async () => {
          throw new Error("network");
        },
      },
      provider: model([]),
      model: "fixture",
      admit: async () => ({
        settle: async (outcome) => {
          outcomes.push(outcome.status);
        },
      }),
    });
    expect((await runtime.run({ query: "test" })).status).toBe("unavailable");
    expect(outcomes).toEqual(["unknown"]);
  });
  test("caller cancellation propagates", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = createResearch({
      search: search(),
      provider: model([]),
      model: "fixture",
    });
    await expect(
      runtime.run({ query: "test", signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("plugin and clients", () => {
  test("JSON, HTML, and streaming routes authorize before any paid work", async () => {
    let calls = 0;
    const runtime: ResearchRuntime = {
      run: async () => {
        calls++;
        return empty;
      },
      extract: async () => empty as any,
    };
    const app = new Elysia().use(
      researchPlugin({
        runtime,
        authorize: (request) =>
          request.headers.get("authorization") === "fixture",
      }),
    );
    for (const suffix of ["", "/html", "/stream"]) {
      const request = (auth?: string) =>
        new Request(`http://localhost/research${suffix}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(auth ? { authorization: auth } : {}),
          },
          body: JSON.stringify({ query: "test" }),
        });
      expect((await app.handle(request())).status).toBe(403);
      const response = await app.handle(request("fixture"));
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(calls).toBe(3);
    const response = await app.handle(
      new Request("http://localhost/research", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "fixture",
          origin: "https://attacker.example",
        },
        body: JSON.stringify({ query: "test" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(calls).toBe(3);
  });
  test("HTMX output escapes model content", () => {
    const html = renderResearchResult({
      ...empty,
      fields: [
        {
          path: "/x",
          value: "<script>alert(1)</script>",
          verdict: "unknown",
          citations: [],
          reason: "",
        },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  test("browser streams progress and completes through real plugin", async () => {
    const runtime: ResearchRuntime = {
      run: async (input) => {
        input.onProgress?.({ phase: "search", completed: 0, limit: 1 });
        return empty;
      },
      extract: async () => empty as any,
    };
    const app = new Elysia().use(
      researchPlugin({ runtime, authorize: () => true }),
    );
    const client = createResearchClient({
      path: "http://localhost/research",
      fetch: ((url: string, init: RequestInit) =>
        app.handle(new Request(url, init))) as typeof fetch,
    });
    const statuses: string[] = [];
    client.subscribe(() => statuses.push(client.getSnapshot().status));
    expect((await client.run({ query: "test" })).status).toBe("empty");
    expect(client.getSnapshot().status).toBe("complete");
    expect(statuses).toContain("running");
    client.dispose();
  });
  test("reset fences a late response from a cancelled request", async () => {
    let release!: (response: Response) => void;
    const client = createResearchClient({
      fetch: (() =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })) as typeof fetch,
    });
    const pending = client.run({ query: "test" });
    client.reset();
    release(
      new Response(JSON.stringify({ type: "result", result: empty }) + "\n"),
    );
    await expect(pending).rejects.toThrow();
    expect(client.getSnapshot().status).toBe("idle");
    expect(client.getSnapshot().result).toBeNull();
  });
});
