import { expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AIProviderConfig } from "@absolutejs/ai";
import type { ResearchReviewCheckpoint } from "../src/research/types";
import { reviewSchemaForPaths } from "../src/research/evidence";
import { checkResearchValue } from "../src/research/schema";
import { createResearch } from "../src/research/runtime";

const task = { schema: Type.Object({ facts: Type.Array(Type.String()) }) };
const draft = { facts: Array.from({ length: 30 }, () => "Example exists") };
const source = {
  id: "s",
  url: "https://example.com",
  title: "Example",
  excerpts: ["Example exists"],
  retrievedAt: "2026-11-03",
};
const calls: string[] = [];
const provider: AIProviderConfig = {
  name: "fixture",
  async *stream(input) {
    const payload = JSON.parse(input.messages.at(-1)!.content as string);
    let output: unknown;
    if (payload.fields) {
      calls.push(`review:${payload.fields[0].path}`);
      expect(payload.fields.length).toBeLessThanOrEqual(8);
      const reviewSchema = input.tools![0]!.input_schema as {
        properties: { fields: { minItems: number; maxItems: number } };
      };
      expect(reviewSchema.properties.fields.minItems).toBe(
        payload.fields.length,
      );
      expect(reviewSchema.properties.fields.maxItems).toBe(
        payload.fields.length,
      );
      output = {
        fields: payload.fields.map((field: { path: string }) => ({
          path: field.path,
          verdict: "supported",
          citations: [{ passageId: "s1:0" }],
          reason: "Source states it",
          checks: {
            answersQuestion: true,
            correctEntity: true,
            correctTime: true,
            preservesScope: true,
          },
        })),
      };
    } else {
      calls.push("extract");
      output = draft;
    }
    yield {
      type: "tool_use",
      id: "1",
      name: input.tools![0]!.name,
      input: output as Record<string, unknown>,
    };
    yield { type: "done" };
  },
};
const search = {
  name: "fixture",
  version: "1",
  search: async () => {
    calls.push("search");
    return {
      provider: "fixture",
      version: "1",
      query: "Example",
      status: "ok" as const,
      sources: [source],
      attempts: [],
      limitations: [],
    };
  },
};

test("30-field extraction survives budget stop and resumes only unfinished batches", async () => {
  calls.length = 0;
  let stored: ResearchReviewCheckpoint | undefined;
  let reviews = 0;
  const runtime = createResearch({
    search,
    provider,
    model: "fixture",
    reviewBatchSize: 8,
    limits: { rounds: 0 },
    admit: async ({ kind }) =>
      kind === "review" && ++reviews === 3 ? false : { settle: async () => {} },
  });
  const first = await runtime.extract(task, {
    query: "Example",
    onReviewCheckpoint: async (checkpoint) => {
      stored = structuredClone(checkpoint);
    },
  });
  expect(first.data).toBeNull();
  expect(first.draft).toEqual(draft);
  expect(first.fields).toHaveLength(16);
  expect(stored?.pending).toBe(false);
  expect(stored?.nextField).toBe(16);
  expect(stored?.result.documents?.[0]?.text).toBe("Example exists");
  const before = calls.length;
  const recovered = await runtime.extract(task, {
    query: "Example",
    resumeReview: stored,
  });
  expect(calls.slice(before)).toEqual(["review:/facts/16", "review:/facts/24"]);
  expect(recovered.data).toEqual(draft);
  expect(recovered.fields).toHaveLength(30);
  expect(recovered.reviewCheckpoint?.finished).toBe(true);
  const done = await runtime.extract(task, {
    query: "Example",
    resumeReview: recovered.reviewCheckpoint,
  });
  expect(done.data).toEqual(draft);
  expect(calls.length).toBe(before + 2);
});

test("pending review, changed task, and failed persistence never trigger paid replay", async () => {
  let saved: ResearchReviewCheckpoint | undefined;
  const runtime = createResearch({
    search,
    provider,
    model: "fixture",
    reviewBatchSize: 8,
    limits: { rounds: 0 },
  });
  await expect(
    runtime.extract(task, {
      query: "Example",
      onReviewCheckpoint: async (checkpoint) => {
        saved = structuredClone(checkpoint);
        if (checkpoint.pending) throw Error("disk unavailable");
      },
    }),
  ).rejects.toThrow("checkpoint persistence failed");
  const before = calls.length;
  await expect(
    runtime.extract(task, { query: "Example", resumeReview: saved }),
  ).rejects.toThrow("reconciliation");
  await expect(
    runtime.extract(task, {
      query: "Changed",
      resumeReview: { ...saved!, pending: false },
    }),
  ).rejects.toThrow("does not match");
  expect(calls.length).toBe(before);
});

test("field allowance pauses without discarding a larger extracted draft", async () => {
  const runtime = createResearch({
    search,
    provider,
    model: "fixture",
    reviewBatchSize: 8,
    limits: { rounds: 0, fields: 16 },
  });
  const first = await runtime.extract(task, { query: "Example" });
  expect(first.draft).toEqual(draft);
  expect(first.fields).toHaveLength(16);
  expect(first.reviewCheckpoint?.pending).toBe(false);
  const recovered = await runtime.extract(task, {
    query: "Example",
    resumeReview: first.reviewCheckpoint,
  });
  expect(recovered.fields).toHaveLength(30);
  expect(recovered.data).toEqual(draft);
});

test("a settled malformed review preserves the draft without an automatic retry", async () => {
  const failure = Error("confirmed malformed output");
  let attempts = 0;
  const broken: AIProviderConfig = {
    ...provider,
    async *stream(input) {
      const payload = JSON.parse(input.messages.at(-1)!.content as string);
      if (payload.fields) {
        attempts++;
        throw failure;
      }
      yield* provider.stream(input);
    },
  };
  const runtime = createResearch({
    search,
    provider: broken,
    model: "fixture",
    limits: { rounds: 0 },
    isReviewFailureSettled: async () => true,
  });
  const result = await runtime.extract(task, { query: "Example" });
  expect(result.draft).toEqual(draft);
  expect(result.data).toBeNull();
  expect(attempts).toBe(1);
  expect(result.reviewCheckpoint?.pending).toBe(false);
  // Unknown failures stay quarantined unless the host proves settlement.
  const unknown = await createResearch({
    search,
    provider: broken,
    model: "fixture",
    limits: { rounds: 0 },
  }).extract(task, { query: "Example" });
  expect(unknown.reviewCheckpoint?.pending).toBe(true);
});

test("empty extraction is finished and reopening it performs no generation", async () => {
  let count = 0;
  const emptyProvider: AIProviderConfig = {
    name: "fixture",
    async *stream(input) {
      count++;
      yield {
        type: "tool_use",
        id: "empty",
        name: input.tools![0]!.name,
        input: { facts: [] },
      };
      yield { type: "done" };
    },
  };
  const runtime = createResearch({
    search,
    provider: emptyProvider,
    model: "fixture",
    limits: { rounds: 0 },
  });
  const result = await runtime.extract(task, { query: "Example" });
  expect(result.reviewCheckpoint?.finished).toBe(true);
  expect(result.reviewCheckpoint?.searched).toEqual(["Example"]);
  await runtime.extract(task, {
    query: "Example",
    resumeReview: result.reviewCheckpoint,
  });
  expect(count).toBe(1);
});

test("settled oversized batches shrink on explicit resume without repeating reviewed fields", async () => {
  const sizes: number[] = [];
  const pointers: string[] = [];
  let fail = true;
  const adaptive: AIProviderConfig = {
    ...provider,
    async *stream(input) {
      const payload = JSON.parse(input.messages.at(-1)!.content as string);
      if (payload.fields) {
        sizes.push(payload.fields.length);
        pointers.push(payload.fields[0].path);
        if (payload.fields[0].path === "/facts/8" && fail) {
          fail = false;
          throw Error("settled output exhaustion");
        }
      }
      yield* provider.stream(input);
    },
  };
  const runtime = createResearch({
    search,
    provider: adaptive,
    model: "fixture",
    limits: { rounds: 0 },
    isReviewFailureSettled: async () => true,
  });
  const first = await runtime.extract(task, { query: "Example" });
  expect(sizes).toEqual([8, 8]);
  expect(first.fields).toHaveLength(8);
  expect(first.reviewCheckpoint).toMatchObject({
    nextField: 8,
    nextBatchSize: 4,
    pending: false,
  });
  const legacy = structuredClone(first.reviewCheckpoint!);
  delete legacy.nextBatchSize;
  const recovered = await runtime.extract(task, {
    query: "Example",
    resumeReview: legacy,
  });
  expect(pointers.slice(2)).toEqual([
    "/facts/8",
    "/facts/12",
    "/facts/16",
    "/facts/20",
    "/facts/24",
    "/facts/28",
  ]);
  expect(sizes.slice(2)).toEqual([4, 4, 4, 4, 4, 2]);
  expect(recovered.data).toEqual(draft);
  await expect(
    runtime.extract(task, {
      query: "Example",
      resumeReview: { ...legacy, nextBatchSize: 99 },
    }),
  ).rejects.toThrow("reconciliation");
});

test("JSON storage key reordering resumes by pointer without losing or repeating verdicts", async () => {
  const objectTask = {
    schema: Type.Object({
      name: Type.String(),
      website: Type.String(),
      qualificationFacts: Type.Array(Type.String()),
      proposedPartnershipType: Type.String(),
    }),
  };
  const objectDraft = {
    name: "Example",
    proposedPartnershipType: "Channel",
    qualificationFacts: ["Example exists"],
    website: "https://example.com",
  };
  const seen: string[] = [];
  const objectProvider: AIProviderConfig = {
    name: "fixture",
    async *stream(input) {
      const payload = JSON.parse(input.messages.at(-1)!.content as string);
      if (payload.fields) {
        seen.push(...payload.fields.map((f: { path: string }) => f.path));
        yield* provider.stream(input);
      } else {
        yield {
          type: "tool_use",
          id: "draft",
          name: input.tools![0]!.name,
          input: objectDraft,
        };
        yield { type: "done" };
      }
    },
  };
  const runtime = createResearch({
    search,
    provider: objectProvider,
    model: "fixture",
    limits: { rounds: 0, fields: 2 },
    reviewBatchSize: 2,
  });
  const first = await runtime.extract(objectTask, { query: "Example" });
  const checkpoint = structuredClone(first.reviewCheckpoint!);
  checkpoint.draft = {
    name: objectDraft.name,
    website: objectDraft.website,
    qualificationFacts: objectDraft.qualificationFacts,
    proposedPartnershipType: objectDraft.proposedPartnershipType,
  };
  const recovered = await runtime.extract(objectTask, {
    query: "Example",
    resumeReview: checkpoint,
  });
  expect(seen).toEqual([
    "/name",
    "/proposedPartnershipType",
    "/website",
    "/qualificationFacts/0",
  ]);
  expect(recovered.data).toEqual(objectDraft);
  expect(recovered.reviewCheckpoint?.finished).toBe(true);
  const changed = structuredClone(checkpoint);
  changed.draft = { ...objectDraft, name: "Changed identity" };
  const rejected = await runtime.extract(objectTask, {
    query: "Example",
    resumeReview: changed,
  });
  expect(rejected.data).toBeNull();
  expect(seen).toHaveLength(4);
});

test("batch response schema rejects extra pointers but retains complete review explanations", () => {
  const schema = reviewSchemaForPaths(["/name"]);
  const field = {
    path: "/name",
    verdict: "unknown",
    citations: [],
    reason: "Missing identity evidence",
    checks: {
      answersQuestion: true,
      correctEntity: false,
      correctTime: true,
      preservesScope: true,
    },
  };
  expect(checkResearchValue(schema, { fields: [field] })).toBe(true);
  expect(
    checkResearchValue(schema, {
      fields: [field, { ...field, path: "/website" }],
    }),
  ).toBe(false);
  expect(
    checkResearchValue(schema, { fields: [{ ...field, path: "/website" }] }),
  ).toBe(false);
  expect(
    checkResearchValue(schema, {
      fields: [
        { ...field, reason: "Useful detailed explanation. ".repeat(20) },
      ],
    }),
  ).toBe(true);
});
