import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AIProviderConfig } from "@absolutejs/ai";
import { createResearch } from "../src/research/runtime";
import type { ResearchConfig } from "../src/research/types";
const checks = {
  answersQuestion: true,
  correctEntity: true,
  correctTime: true,
  preservesScope: true,
};
const reviewed = (
  verdict: "supported" | "unknown",
  path = "/name",
  source = "s1:0",
) => ({
  fields: [
    {
      path,
      verdict,
      reason: "Recorded evidence verdict",
      checks,
      citations: verdict === "supported" ? [{ passageId: source }] : [],
    },
  ],
});
const provider = (outputs: unknown[], calls: unknown[]): AIProviderConfig => ({
  name: "fixture",
  async *stream(input) {
    calls.push(input);
    const output = outputs.shift();
    if (!output) throw Error("Unexpected paid call");
    yield {
      type: "tool_use",
      id: "1",
      name: input.tools![0]!.name,
      input: output as Record<string, unknown>,
    };
    yield { type: "done" };
  },
});
const config = (
  outputs: unknown[],
  calls: unknown[] = [],
  searches: string[] = [],
): ResearchConfig => ({
  evidenceRepairs: 1,
  model: "fixture",
  provider: provider(outputs, calls),
  limits: { rounds: 0, reads: 0, searches: 1 },
  search: {
    name: "fixture",
    version: "1",
    search: async (input) => {
      searches.push(input.query);
      return {
        provider: "fixture",
        version: "1",
        query: input.query,
        status: "ok",
        attempts: [],
        limitations: [],
        sources: [
          {
            id: "external",
            url: `https://example.com/${searches.length}`,
            title: "Example",
            excerpts: ["Example provides water treatment."],
            retrievedAt: "2026-11-02",
          },
        ],
      };
    },
  },
});
const task = { schema: Type.Object({ name: Type.String() }) };
test("factual correction reuses evidence, re-reviews the new value and separately settles every call", async () => {
  const calls: unknown[] = [],
    searches: string[] = [],
    settled: string[] = [];
  const result = await createResearch({
    ...config(
      [
        { name: "Invented" },
        reviewed("unknown"),
        { name: "Example" },
        reviewed("supported"),
      ],
      calls,
      searches,
    ),
    admit: async ({ kind }) => ({
      settle: async (outcome) => {
        settled.push(`${kind}:${outcome.status}`);
      },
    }),
  }).extract(task, { query: "water treatment company" });
  expect(result.data).toEqual({ name: "Example" });
  expect(result.reviewPasses?.map((p) => p.fields[0]?.verdict)).toEqual([
    "unknown",
    "supported",
  ]);
  expect(searches).toHaveLength(1);
  expect(calls).toHaveLength(4);
  expect(settled).toEqual([
    "search:fulfilled",
    "extract:fulfilled",
    "review:fulfilled",
    "extract:fulfilled",
    "review:fulfilled",
  ]);
  expect(result.fields[0]?.citations[0]?.quote).toBe(
    "Example provides water treatment.",
  );
});
test("rewriting a rejected value never inherits its prior verdict and correction remains bounded", async () => {
  const calls: unknown[] = [];
  const result = await createResearch(
    config(
      [
        { name: "Invented" },
        reviewed("unknown"),
        { name: "Still invented" },
        reviewed("unknown"),
      ],
      calls,
    ),
  ).extract(task, { query: "company" });
  expect(result.data).toBeNull();
  expect(result.fields[0]?.value).toBe("Still invented");
  expect(result.fields[0]?.verdict).toBe("unknown");
  expect(calls).toHaveLength(4);
});
test("reserved retrieval can only be used after review identifies a gap, within the original search cap", async () => {
  const searches: string[] = [];
  const result = await createResearch({
    ...config(
      [
        { name: "Invented" },
        reviewed("unknown"),
        { queries: ["official", "outside cap"], urls: [], done: false },
        { name: "Example" },
        reviewed("supported", "/name", "s2:0"),
      ],
      [],
      searches,
    ),
    repairSearches: 1,
    limits: { rounds: 0, reads: 0, searches: 2 },
  }).extract(task, { query: "company", queries: ["seed", "premature"] });
  expect(searches).toEqual(["seed", "official"]);
  expect(result.data).toEqual({ name: "Example" });
});
test("budget denial prevents correction and preserves reviewed partial results", async () => {
  const calls: unknown[] = [];
  let admitted = 0;
  const result = await createResearch({
    ...config([{ name: "Invented" }, reviewed("unknown")], calls),
    admit: async () => (++admitted > 3 ? false : { settle: async () => {} }),
  }).extract(task, { query: "company" });
  expect(calls).toHaveLength(2);
  expect(result.data).toBeNull();
  expect(result.fields[0]?.verdict).toBe("unknown");
});
test("collection eligibility can require a supported atomic fact without accepting rejected embellishment", async () => {
  const fields = [
    { ...reviewed("supported", "/candidates/0/name").fields[0]! },
    { ...reviewed("supported", "/candidates/0/facts/0").fields[0]! },
    { ...reviewed("unknown", "/candidates/0/facts/1").fields[0]! },
  ];
  const result = await createResearch(
    config([
      {
        candidates: [
          {
            name: "Example",
            facts: ["Example provides water treatment.", "Invented award"],
          },
        ],
      },
      { fields },
    ]),
  ).extract(
    {
      schema: Type.Object({
        candidates: Type.Array(
          Type.Object({
            name: Type.String(),
            facts: Type.Array(Type.String()),
          }),
        ),
      }),
      collection: {
        path: "/candidates",
        minimum: 1,
        requiredFields: ["name"],
        minimumSupportedFields: { facts: 1 },
      },
    },
    { query: "water treatment company" },
  );
  expect(result.coverage).toEqual({
    requested: 1,
    supported: 1,
    complete: true,
  });
  expect(result.data).toBeNull();
  expect(result.fields[2]?.verdict).toBe("unknown");
});
test("provider failure during correction is never automatically replayed", async () => {
  const calls: unknown[] = [];
  const result = await createResearch(
    config([{ name: "Invented" }, reviewed("unknown")], calls),
  ).extract(task, { query: "company" });
  expect(calls).toHaveLength(3);
  expect(result.operations.at(-1)?.status).toBe("unknown");
  expect(result.data).toBeNull();
  expect(result.fields[0]?.value).toBe("Invented");
});

for (const [settled, rounds, expectedPlans] of [
  [true, 2, 2],
  [false, 2, 1],
  [true, 1, 1],
] as const) {
  test(`malformed discovery plan respects settled=${settled} and rounds=${rounds}`, async () => {
    const calls: unknown[] = [];
    const searches: string[] = [];
    const outputs: unknown[] = [{ urls: [], done: false }];
    if (expectedPlans === 2)
      outputs.push({
        queries: ["verified primary evidence"],
        urls: [],
        done: true,
      });
    outputs.push({ name: "Example" }, reviewed("supported"));
    const result = await createResearch({
      ...config(outputs, calls, searches),
      evidenceRepairs: 0,
      limits: { rounds, reads: 0, searches: 2 },
      isReviewFailureSettled: async () => settled,
    }).extract(task, { query: "water treatment companies" });
    expect(result.data).toEqual({ name: "Example" });
    expect(result.sources).toHaveLength(expectedPlans);
    expect(searches).toHaveLength(expectedPlans);
    expect(calls).toHaveLength(expectedPlans + 2);
    expect(
      result.operations.filter((operation) => operation.kind === "plan"),
    ).toHaveLength(expectedPlans);
    expect(result.limitations).toContain(
      "Invalid planning output; continued with retrieved evidence",
    );
    expect(outputs).toEqual([]);
  });
}
