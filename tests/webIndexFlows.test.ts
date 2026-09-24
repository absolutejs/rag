import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  webIndexPlugin,
  renderWebIndexStats,
  startWebIndexWorker,
  createWebIndexProjector,
} from "../src/web-index";
import { createWebIndexClient } from "../src/client/web-index";
import type { WebIndexRuntime } from "../src/web-index/types";
import { parseWebIndexDocument } from "../src/web-index/document";
import {
  researchPassages,
  resolveResearchPassages,
} from "../src/research/evidence";
import { createWebpageReaderClient } from "../src/web/remote";
const stats = {
  urls: 1,
  documents: 1,
  pending: 0,
  failed: 0,
  tombstones: 0,
  oldestFetchedAt: null,
  newestFetchedAt: null,
};
test("index routes authorize the operation before tenant selection and prevent cross-origin mutations", async () => {
  const calls: string[] = [];
  const runtime = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "then"
          ? undefined
          : async () => {
              calls.push(String(name));
              return stats;
            },
    },
  ) as WebIndexRuntime;
  const app = new Elysia().use(
    webIndexPlugin({
      runtime: () => {
        calls.push("resolve");
        return runtime;
      },
      authorize: (request, operation) =>
        request.headers.get("authorization") === operation,
    }),
  );
  const request = (
    path: string,
    data: unknown,
    auth?: string,
    origin?: string,
  ) =>
    app.handle(
      new Request(`http://localhost/web-index/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: auth } : {}),
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(data),
      }),
    );
  for (const [path, data] of [
    ["stats", {}],
    ["history", { url: "https://example.com" }],
    ["search", { query: "policy" }],
    ["projections", { kind: "company" }],
    ["enqueue", { urls: ["https://example.com"] }],
    ["run", {}],
    ["remove", { url: "https://example.com" }],
    ["restore", { url: "https://example.com" }],
    ["rebuild", { from: "a", to: "b", limit: 10 }],
    ["activate", { generation: "b", expected: "a", evidence: "report" }],
  ] as const)
    expect((await request(path, data)).status).toBe(403);
  expect(calls).toEqual([]);
  expect((await request("run", {}, "read")).status).toBe(403);
  expect(
    (
      await request(
        "remove",
        { url: "https://example.com" },
        "admin",
        "https://evil.example",
      )
    ).status,
  ).toBe(403);
  expect(calls).toEqual([]);
  expect((await request("stats", {}, "read")).status).toBe(200);
  expect(calls).toEqual(["resolve", "stats"]);
  const client = createWebIndexClient({
    path: "http://localhost/web-index",
    headers: () => ({ authorization: "read" }),
    fetch: ((url, init) => app.handle(new Request(url, init))) as typeof fetch,
  });
  expect(await client.call("stats", {})).toEqual(stats);
  expect(client.getSnapshot().status).toBe("complete");
  client.dispose();
  expect(
    renderWebIndexStats({ ...stats, oldestFetchedAt: "<script>" }),
  ).not.toContain("<script>");
});
test("worker stop aborts and waits for its active run without overlap", async () => {
  let calls = 0,
    complete = false;
  const worker = startWebIndexWorker({
    runtime: {
      run: async ({ signal }: any) => {
        calls++;
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        complete = true;
        return {} as any;
      },
    } as WebIndexRuntime,
    intervalMs: 100,
    onError: () => {
      throw new Error("Unexpected worker failure");
    },
  });
  await worker.stop();
  expect(calls).toBe(1);
  expect(complete).toBe(true);
  expect(worker.stopped).toBe(true);
});
test("context accompanies exact citations and parent section qualifiers survive chunking", () => {
  const text =
    "Eligible trial customers only. " +
    "Policy details. ".repeat(80) +
    " Written approval is required.";
  const sources = researchPassages([
    {
      id: "s",
      url: "https://example.com",
      title: "Policy",
      excerpts: [text],
      retrievedAt: "",
    },
  ]);
  expect(sources[0]!.passages[1]!.context.length).toBeGreaterThan(
    sources[0]!.passages[1]!.text.length,
  );
  expect(
    resolveResearchPassages([{ passageId: "s:1" }], sources)[0]!.quote,
  ).toBe(sources[0]!.passages[1]!.text);
  const document = parseWebIndexDocument({
    url: "https://example.com/policy",
    finalUrl: "https://example.com/policy",
    body: `<html><body><main><h1>Trials</h1><p>Only approved customers qualify.</p><h2>Benefits</h2><p>${text.repeat(5)}</p></main></body></html>`,
    headers: { "content-type": "text/html" },
    previous: null,
    status: 200,
    maxChunks: 20,
  })!;
  expect(document.passages.length).toBeGreaterThan(2);
  for (const passage of document.passages.slice(1))
    expect(passage.text).toContain("Only approved customers qualify.");
});
test("isolated page adapter rejects mixed sources and preserves exact page attribution", async () => {
  let mixed = false;
  const read = createWebpageReaderClient({
    endpoint: "http://reader/read",
    fallback: async () => {
      throw new Error("Unexpected fallback");
    },
    fetch: (async (_url, init) => {
      expect(JSON.parse(String(init?.body)).maxPages).toBe(1);
      return Response.json({
        status: "ok",
        text: "Combined envelope",
        url: "https://example.com",
        finalUrl: "https://example.com/page",
        title: "Page",
        fetchedAt: "2026-09-24T12:00:00Z",
        method: "browser",
        attempts: [],
        redirects: [],
        evidence: { links: [], images: [], media: [], canonicalUrl: null },
        sources: [
          { id: "one", url: "https://example.com/page" },
          ...(mixed ? [{ id: "two", url: "https://example.com/other" }] : []),
        ],
        documents: [{ sourceId: "one", text: "Exact page evidence" }],
      });
    }) as typeof fetch,
  });
  const result = await read({ url: "https://example.com" });
  expect(result.text).toBe("Exact page evidence");
  expect(result.method).toBe("browser");
  expect(result.finalUrl).toBe("https://example.com/page");
  mixed = true;
  await expect(read({ url: "https://example.com" })).rejects.toThrow(
    "attributable",
  );
});
test("entity projection publishes only separately supported facts with original passage references", async () => {
  const document = parseWebIndexDocument({
    url: "https://example.com",
    finalUrl: "https://example.com",
    body: "Example Inc offers approved customers a trial.",
    headers: { "content-type": "text/plain" },
    status: 200,
    previous: null,
    maxChunks: 10,
  })!;
  const checks = {
    answersQuestion: true,
    correctEntity: true,
    correctTime: true,
    preservesScope: true,
  };
  const outputs = [
    {
      identity: "Example Inc",
      facts: [
        "Example Inc offers approved customers a trial.",
        "Everyone gets a trial.",
      ],
    },
    {
      fields: [
        {
          path: "/identity",
          verdict: "supported",
          citations: [{ passageId: "s1:0" }],
          reason: "Named",
          checks,
        },
        {
          path: "/facts/0",
          verdict: "supported",
          citations: [{ passageId: "s1:0" }],
          reason: "Explicit",
          checks,
        },
        {
          path: "/facts/1",
          verdict: "unsupported",
          citations: [{ passageId: "s1:0" }],
          reason: "Approval required",
          checks: { ...checks, preservesScope: false },
        },
      ],
    },
  ];
  const extract = createWebIndexProjector({
    kind: "company",
    instructions: "Trial policy",
    model: "fixture",
    provider: {
      name: "fixture",
      async *stream(input) {
        yield {
          type: "tool_use",
          id: "one",
          name: input.tools![0]!.name,
          input: outputs.shift()!,
        };
        yield { type: "done" };
      },
    },
  });
  const result = await extract(document);
  expect(result).toHaveLength(1);
  expect(result[0]!.fields).toHaveLength(1);
  expect(result[0]!.fields[0]!.passageIds).toEqual(["0"]);
});

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { effectScope } from "vue";
import { useWebIndex as useReactWebIndex } from "../src/react/useWebIndex";
import { useWebIndex as useVueWebIndex } from "../src/vue/useWebIndex";
import { createWebIndexStore } from "../src/svelte/createWebIndex";
import { WebIndexService } from "../src/angular/web-index.service";
import { bindResearchReview } from "../src/research/evidence";
test("framework index bindings are SSR-safe and cancel on component teardown", async () => {
  const Component = () =>
    createElement("span", null, useReactWebIndex().state.status);
  expect(renderToString(createElement(Component))).toBe("<span>idle</span>");
  const scope = effectScope();
  const vue = scope.run(() => useVueWebIndex("http://127.0.0.1:1/web-index"))!;
  const vueCall = vue.call("stats", {});
  scope.stop();
  await expect(vueCall).rejects.toThrow();
  expect(vue.getSnapshot().status).toBe("cancelled");
  const svelte = createWebIndexStore("http://127.0.0.1:1/web-index");
  const off = svelte.state.subscribe(() => {});
  const svelteCall = svelte.call("stats", {});
  off();
  await expect(svelteCall).rejects.toThrow();
  expect(svelte.getSnapshot().status).toBe("cancelled");
  let destroy!: () => void;
  const angular = new WebIndexService().connect(
    "http://127.0.0.1:1/web-index",
    {
      destroyed: false,
      onDestroy: (fn) => {
        destroy = fn;
        return () => {};
      },
    },
  );
  const angularCall = angular.call("stats", {});
  destroy();
  await expect(angularCall).rejects.toThrow();
  expect(angular.state().status).toBe("cancelled");
});
test("a supported review cannot promote fabricated quoted wording", () => {
  const source = {
    id: "s1",
    url: "https://example.com",
    title: "Release",
    excerpts: ["We announced our most significant product release."],
    retrievedAt: "",
  };
  const review = [
    {
      path: "/fact",
      verdict: "supported" as const,
      citations: [{ sourceId: "s1", quote: source.excerpts[0]! }],
      reason: "Claimed match",
      checks: {
        answersQuestion: true,
        correctEntity: true,
        correctTime: true,
        preservesScope: true,
      },
    },
  ];
  expect(
    bindResearchReview(
      [
        {
          path: "/fact",
          value: "The vendor calls it 'most foundational product release'.",
        },
      ],
      review,
      [source],
    )[0]!.verdict,
  ).toBe("unknown");
  expect(
    bindResearchReview(
      [
        {
          path: "/fact",
          value: "The vendor calls it 'most significant product release'.",
        },
      ],
      review,
      [source],
    )[0]!.verdict,
  ).toBe("supported");
});
