import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { effectScope } from "vue";
import { useResearch as useReactResearch } from "../src/react/useResearch";
import { useResearch as useVueResearch } from "../src/vue/useResearch";
import { createResearchStore } from "../src/svelte/createResearch";
import { ResearchService } from "../src/angular/research.service";
import { Elysia } from "elysia";
import { researchPlugin } from "../src/research/plugin";
import { researchManifest } from "../src/research/manifest";
import { inspectManifestSecurity } from "@absolutejs/manifest";
import {
  researchGroundingCase,
  evaluateResearch,
} from "../src/research/evaluation";
import { evaluateRAGAnswerGrounding } from "../src/quality/quality";
import type { ResearchResult, ResearchRuntime } from "../src/research/types";
const result: ResearchResult = {
  id: "1",
  status: "reviewed",
  data: { name: "Example" },
  fields: [
    {
      path: "/name",
      value: "Example",
      verdict: "supported",
      citations: [
        { sourceId: "s1", quote: "Example company launched in 2026." },
      ],
      reason: "",
    },
  ],
  sources: [
    {
      id: "s1",
      url: "https://example.com",
      title: "Example",
      excerpts: ["Example company launched in 2026."],
      retrievedAt: "",
    },
  ],
  searches: [],
  operations: [],
  limitations: [],
  generatedAt: "",
};
const runtime: ResearchRuntime = {
  run: async () => result,
  extract: async () => result as any,
};
test("React research hook is SSR-safe and starts idle without a request", () => {
  const Component = () =>
    createElement("span", null, useReactResearch().state.status);
  expect(renderToString(createElement(Component))).toBe("<span>idle</span>");
});
test("Vue scope cleanup cancels an active request", async () => {
  const scope = effectScope();
  const client = scope.run(() =>
    useVueResearch("http://127.0.0.1:1/research"),
  )!;
  const pending = client.run({ query: "test" });
  scope.stop();
  await expect(pending).rejects.toThrow();
  expect(client.getSnapshot().status).toBe("cancelled");
});
test("Svelte store updates and stops the request on last unsubscribe", async () => {
  const client = createResearchStore("http://127.0.0.1:1/research");
  const states: string[] = [];
  const off = client.state.subscribe((state) => states.push(state.status));
  const pending = client.run({ query: "test" });
  off();
  await expect(pending).rejects.toThrow();
  expect(states).toContain("running");
  expect(client.getSnapshot().status).toBe("cancelled");
});
test("Angular connection owns independent signals and supports component cleanup", async () => {
  let destroy!: () => void;
  const client = new ResearchService().connect("http://127.0.0.1:1/research", {
    onDestroy: (fn: () => void) => {
      destroy = fn;
      return () => {};
    },
    destroyed: false,
  });
  expect(client.state().status).toBe("idle");
  const pending = client.run({ query: "test" });
  destroy();
  await expect(pending).rejects.toThrow();
  expect(client.getSnapshot().status).toBe("cancelled");
});
test("HTMX accepts actual form-urlencoded requests", async () => {
  const app = new Elysia().use(
    researchPlugin({ runtime, authorize: () => true }),
  );
  const response = await app.handle(
    new Request("http://localhost/research/html", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "hx-request": "true",
      },
      body: "query=Example",
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(await response.text()).toContain("https://example.com");
});
test("research result feeds the existing grounding evaluation", async () => {
  const report = evaluateRAGAnswerGrounding({
    cases: [
      researchGroundingCase("case", "Example", result, ["https://example.com"]),
    ],
  });
  expect(JSON.stringify(report)).toContain('"citationPrecision":1');
  const evaluation = await evaluateResearch({
    runtime,
    cases: [{ id: "case", input: { query: "Example" } }],
  });
  expect(evaluation.independentlyReviewed).toBe(0);
  expect(evaluation.totalCostUsd).toBeNull();
  expect(evaluation.cases[0]!.costPerAcceptedFinding).toBeNull();
});
test("research manifest declares policy and required scopes", () => {
  const report = inspectManifestSecurity(researchManifest);
  expect(
    researchManifest.tools!.research_web!.authorization!.requiredScopes,
  ).toEqual(["research:run"]);
  expect(report).toBeDefined();
});
