import { test, expect } from "bun:test";
import { discoverResearchCompanies } from "../src/research/workflows";
import { createResearchBudgetAdmission } from "../src/research/budget";
import { createResearch } from "../src/research/runtime";
import type { ResearchResult, ResearchRuntime } from "../src/research/types";
const base: ResearchResult = {
  id: "1",
  status: "partial",
  data: null,
  fields: [],
  sources: [],
  searches: [],
  operations: [],
  generatedAt: "",
  limitations: [],
};
test("discovery accepts only verified company identities and evidenced criteria", async () => {
  const outputs = [
    {
      ...base,
      fields: [
        {
          path: "/companies/0/name",
          value: "Example",
          verdict: "supported",
          citations: [],
          reason: "",
        },
        {
          path: "/companies/0/domain",
          value: "www.example.com",
          verdict: "supported",
          citations: [],
          reason: "",
        },
        {
          path: "/companies/1/name",
          value: "Invented",
          verdict: "unknown",
          citations: [],
          reason: "",
        },
        {
          path: "/companies/1/domain",
          value: "invented.example",
          verdict: "supported",
          citations: [],
          reason: "",
        },
      ],
    },
    { ...base, data: { matches: true, explanation: "Verified manufacturer" } },
    base,
  ];
  let calls = 0;
  const runtime = {
    run: async () => base,
    extract: async () => {
      calls++;
      return outputs.shift();
    },
  } as ResearchRuntime;
  const result = await discoverResearchCompanies(runtime, {
    query: "Manufacturers",
    criteria: [
      { id: "manufacturer", description: "Manufactures products" },
      { id: "current", description: "Has a current opening" },
    ],
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]!.domain).toBe("example.com");
  expect(result.candidates[0]!.criteria.map((item) => item.verdict)).toEqual([
    "matched",
    "unknown",
  ]);
  expect(result.accepted).toEqual([]);
  expect(calls).toBe(3);
});
test("budget adapter holds unknown cost and detects underestimated ceilings", async () => {
  const settled: unknown[][] = [];
  const admit = createResearchBudgetAdmission({
    scope: "tenant",
    period: () => "today",
    maxMicros: 1000,
    maxRequests: 10,
    reserveMicros: { search: 10, read: 10, plan: 10, extract: 10, review: 10 },
    actualMicros: () => 20,
    ledger: {
      reserve: async () => true,
      settle: async (...args) => {
        settled.push(args);
      },
    },
  });
  const unknown = await admit({
    runId: "1",
    kind: "search",
    signal: new AbortController().signal,
  });
  if (!unknown) throw new Error("Denied");
  await unknown.settle({ status: "unknown" });
  expect(settled[0]!.slice(1)).toEqual(["unknown", null]);
  const known = await admit({
    runId: "1",
    kind: "plan",
    signal: new AbortController().signal,
  });
  if (!known) throw new Error("Denied");
  await expect(known.settle({ status: "fulfilled" })).rejects.toThrow(
    "ceiling",
  );
  expect(settled[1]!.slice(1)).toEqual(["fulfilled", 20]);
});
test("quoted nonexistent entity excludes namesakes before extraction", async () => {
  let models = 0;
  const runtime = createResearch({
    search: {
      name: "fixture",
      version: "1",
      search: async (input) => ({
        provider: "fixture",
        version: "1",
        query: input.query,
        status: "ok",
        sources: [
          {
            id: "1",
            url: "https://example.com",
            title: "Example",
            excerpts: ["Example has launched a product."],
            retrievedAt: "",
          },
        ],
        attempts: [],
        limitations: [],
      }),
    },
    provider: {
      name: "fixture",
      async *stream(input) {
        models++;
        yield {
          type: "tool_use",
          id: "1",
          name: input.tools![0]!.name,
          input: { queries: [], urls: [], done: true },
        };
        yield { type: "done" };
      },
    },
    model: "fixture",
  });
  const result = await runtime.run({ query: 'Research "Nonexistent-ZXQ-123"' });
  expect(result.sources).toEqual([]);
  expect(result.fields).toEqual([]);
  expect(result.status).toBe("empty");
  expect(models).toBe(1);
});
