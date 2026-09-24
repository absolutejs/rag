import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Elysia, t } from "elysia";
import { Type as ModernType } from "typebox";
import { checkResearchValue } from "../src/research/schema";
import { createResearch } from "../src/research/runtime";
import {
  bindResearchReview,
  researchLeaves,
  researchPassages,
  resolveResearchPassages,
} from "../src/research/evidence";
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
      checks: {
        answersQuestion: true,
        correctEntity: true,
        correctTime: true,
        preservesScope: true,
      },
    },
  ],
};
const modelReview = {
  fields: review.fields.map((field) => ({
    ...field,
    citations: [{ passageId: "s1:0" }],
  })),
};
const plan = { queries: [], urls: [], done: true };

describe("research runtime", () => {
  test("configured schema extraction reviews every field and disables hidden retries", async () => {
    const calls: any[] = [];
    const runtime = createResearch({
      search: search(),
      provider: model([plan, { name: "Example" }, modelReview], calls),
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
        modelReview,
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

for (const [name, schema] of [
  [
    "Elysia 2",
    t.Object(
      { name: t.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
  ],
  [
    "TypeBox 1",
    ModernType.Object(
      { name: ModernType.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
  ],
  [
    "TypeBox 0.34",
    Type.Object(
      { name: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
  ],
] as const) {
  test(`${name} schemas support reviewed extraction and reject invalid model output`, async () => {
    for (const value of [
      { name: "Example" },
      { name: 123 },
      { name: "" },
      {},
      { name: "Example", extra: true },
    ]) {
      const runtime = createResearch({
        search: search(),
        provider: model([plan, value, modelReview]),
        model: "fixture",
      });
      const result = await runtime.extract(
        { schema },
        { query: "Example launch" },
      );
      if (JSON.stringify(value) === JSON.stringify({ name: "Example" })) {
        expect(result.status).toBe("reviewed");
        expect(result.data).toEqual(value);
      } else {
        expect(result.data).toBeNull();
        expect(result.status).not.toBe("reviewed");
      }
    }
  });
}

test("Elysia 2 nested, optional and union schemas retain validation constraints", () => {
  const schema = t.Object({
    findings: t.Array(
      t.Object({
        label: t.String({ minLength: 1 }),
        score: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
      }),
      { maxItems: 2 },
    ),
  });
  expect(checkResearchValue(schema, { findings: [{ label: "Example" }] })).toBe(
    true,
  );
  expect(
    checkResearchValue(schema, {
      findings: [{ label: "Example", score: null }],
    }),
  ).toBe(true);
  expect(
    checkResearchValue(schema, { findings: [{ label: "Example", score: -1 }] }),
  ).toBe(false);
  expect(checkResearchValue(schema, { findings: [{ label: "" }] })).toBe(false);
  expect(
    checkResearchValue(schema, {
      findings: Array(3).fill({ label: "Example" }),
    }),
  ).toBe(false);
});

describe("research quality gates", () => {
  test("a real quote cannot override failed relevance, entity, time or scope checks", () => {
    for (const key of [
      "answersQuestion",
      "correctEntity",
      "correctTime",
      "preservesScope",
    ] as const) {
      const candidate = {
        ...review.fields[0]!,
        checks: { ...review.fields[0]!.checks, [key]: false },
      };
      const [field] = bindResearchReview(
        researchLeaves({ name: "Example" }),
        [candidate],
        [{ ...source, id: "s1" }],
      );
      expect(field!.verdict).toBe("unknown");
      expect(field!.citations).toEqual([citation]);
      expect(field!.checks![key]).toBe(false);
    }
    const { checks: _checks, ...legacy } = review.fields[0]!;
    expect(
      bindResearchReview(
        researchLeaves({ name: "Example" }),
        [legacy],
        [{ ...source, id: "s1" }],
      )[0]!.verdict,
    ).toBe("unknown");
  });
  test("follow-up evidence gets space and a full read replaces snippets at capacity", async () => {
    const calls: any[] = [];
    let searches = 0;
    const runtime = createResearch({
      model: "fixture",
      provider: model(
        [
          { queries: ["official policy"], urls: [source.url], done: false },
          { findings: [] },
        ],
        calls,
      ),
      limits: { rounds: 1, searches: 2, reads: 1, evidenceChars: 300 },
      search: {
        ...search(),
        search: async (input) => ({
          provider: "fixture",
          version: "1",
          query: input.query,
          status: "ok",
          attempts: [],
          limitations: [],
          sources: [
            {
              ...source,
              url: searches++ ? "https://example.com/policy" : source.url,
              excerpts: [
                searches === 1
                  ? "snippet ".repeat(100)
                  : "Official eligibility policy and its qualifying conditions.",
              ],
            },
          ],
        }),
      },
      reader: async (input) => ({
        status: "ok",
        url: input.url,
        finalUrl: input.url,
        text:
          "Trial benefit only\nNo previous subscription.\n" +
          "other ".repeat(100),
        title: "Terms",
        method: "http",
        truncated: false,
        fetchedAt: "2026-09-24T00:00:00Z",
        attempts: [],
        redirects: [],
        limitations: [],
        evidence: { links: [], images: [], media: [], canonicalUrl: null },
      }),
    });
    const result = await runtime.run({ query: "eligibility" });
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]!.excerpts.join("\n")).toStartWith(
      "Trial benefit only\nNo previous subscription.",
    );
    expect(result.sources[0]!.excerpts.join("\n")).not.toContain("snippet");
    expect(result.sources[1]!.excerpts[0]).toBe(
      "Official eligibility policy and its qualifying conditions.",
    );
    expect(
      result.sources.reduce(
        (sum, item) => sum + item.excerpts.join("\n").length,
        0,
      ),
    ).toBeLessThanOrEqual(300);
  });
  test("review receives task criteria and full structured context", async () => {
    const calls: any[] = [];
    const runtime = createResearch({
      search: search(),
      provider: model([plan, { name: "Example" }, modelReview], calls),
      model: "fixture",
    });
    await runtime.extract(
      {
        schema: Type.Object({ name: Type.String() }),
        instructions: "Only the current named leader qualifies.",
      },
      { query: "Who leads Example?" },
    );
    const payload = JSON.parse(calls[2].messages.at(-1).content);
    expect(payload.instructions).toBe(
      "Only the current named leader qualifies.",
    );
    expect(payload.schema.properties.name.type).toBe("string");
    expect(payload.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});

test("separate review model retains host accounting and cannot perform extraction", async () => {
  const extractionCalls: any[] = [];
  const reviewCalls: any[] = [];
  const settled: string[] = [];
  const runtime = createResearch({
    search: search(),
    provider: model([plan, { name: "Example" }], extractionCalls),
    model: "extractor",
    reviewer: {
      provider: model([modelReview], reviewCalls),
      model: "reviewer",
    },
    admit: async ({ kind }) => ({
      settle: async () => {
        settled.push(kind);
      },
    }),
  });
  const result = await runtime.extract(
    { schema: Type.Object({ name: Type.String() }) },
    { query: "Example" },
  );
  expect(result.status).toBe("reviewed");
  expect(extractionCalls).toHaveLength(2);
  expect(extractionCalls.every((call) => call.model === "extractor")).toBe(
    true,
  );
  expect(reviewCalls).toHaveLength(1);
  expect(reviewCalls[0].model).toBe("reviewer");
  expect(settled).toEqual(["search", "plan", "extract", "review"]);
});

test("passage references copy exact evidence and reject invented or ambiguous IDs", () => {
  const passages = researchPassages([
    {
      ...source,
      id: "s1",
      excerpts: [
        "Trial only\n" + "A condition and its exceptions. ".repeat(80),
      ],
    },
  ]);
  expect(passages[0]!.passages.map((p) => p.text).join("")).toBe(
    "Trial only\n" + "A condition and its exceptions. ".repeat(80),
  );
  const copied = resolveResearchPassages([{ passageId: "s1:1" }], passages);
  expect(copied[0]!.quote).toBe(passages[0]!.passages[1]!.text);
  expect(resolveResearchPassages([{ passageId: "made-up" }], passages)).toEqual(
    [{ sourceId: "", quote: "" }],
  );
  expect(
    resolveResearchPassages(
      [{ passageId: "s1:0" }],
      [...passages, ...passages],
    ),
  ).toEqual([{ sourceId: "", quote: "" }]);
});

test("invalid planning preserves retrieved evidence without retrying or bypassing admission", async () => {
  const calls: any[] = [];
  const outcomes: { kind: string; status: string }[] = [];
  const runtime = createResearch({
    search: search(),
    model: "fixture",
    provider: model(
      [{ queries: null }, { name: "Example" }, modelReview],
      calls,
    ),
    admit: async ({ kind }) => ({
      settle: async ({ status }) => {
        outcomes.push({ kind, status });
      },
    }),
  });
  const result = await runtime.extract(
    { schema: Type.Object({ name: Type.String() }) },
    { query: "Example" },
  );
  expect(result.status).toBe("partial");
  expect(result.fields[0]!.verdict).toBe("supported");
  expect(result.limitations).toContain(
    "Invalid planning output; continued with retrieved evidence",
  );
  expect(calls).toHaveLength(3);
  expect(outcomes).toEqual([
    { kind: "search", status: "fulfilled" },
    { kind: "plan", status: "unknown" },
    { kind: "extract", status: "fulfilled" },
    { kind: "review", status: "fulfilled" },
  ]);
});
