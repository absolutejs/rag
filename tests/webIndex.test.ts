import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  createWebIndex,
  createPostgresWebIndexStore,
  webIndexPostgresSchemaSql,
} from "../src/web-index";
import { parseWebIndexDocument } from "../src/web-index/document";
import { createInMemoryRAGStore } from "../src/adapters/inMemory";
import { createPostgresRAGStore } from "@absolutejs/rag-postgres";
import { createRAGCollection } from "../src/retrieval/collection";
import type { WebIndexOptions } from "../src/web-index/types";
import type { fetchPublicWebResource } from "../src/web/transport";

const databaseUrl = process.env.WEB_INDEX_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const response = (
  url: string,
  body: string,
  status = 200,
  headers: Record<string, string> = { "content-type": "text/html" },
) => ({ url, status, headers, body: new TextEncoder().encode(body) });
const html = (text: string) =>
  `<html><head><title>Partner policy</title></head><body><main><h1>Trial program</h1><p>${text}</p></main></body></html>`;
const collection = () =>
  createRAGCollection({ store: createInMemoryRAGStore({ dimensions: 8 }) });
suite("durable web index", () => {
  const db = new Bun.SQL(databaseUrl!);
  const store = createPostgresWebIndexStore(db);
  beforeAll(async () => {
    await db.unsafe(webIndexPostgresSchemaSql());
  });
  beforeEach(async () => {
    await db.unsafe(
      "TRUNCATE absolute_web_indexes,absolute_web_generations,absolute_web_origins,absolute_web_frontier,absolute_web_documents,absolute_web_versions,absolute_web_projections,absolute_web_takedowns CASCADE",
    );
  });
  afterAll(async () => {
    await db.close();
  });
  const setup = (
    fetchResource: typeof fetchPublicWebResource,
    overrides: Partial<WebIndexOptions> = {},
  ) => {
    const options: WebIndexOptions = {
      tenant: "tenant-a",
      index: "public-sites",
      store,
      generations: [
        {
          id: "one",
          embedding: { provider: "fixture", model: "lexical", dimensions: 8 },
          collection: collection(),
          retrieval: "lexical",
        },
      ],
      origins: ["https://example.com"],
      limits: {
        maxUrls: 20,
        maxPagesPerRun: 5,
        maxBytesPerRun: 100000,
        maxChunksPerPage: 20,
        maxDepth: 1,
      },
      originDelayMs: 0,
      recrawlMs: 1000,
      fetchResource,
      ...overrides,
    };
    return { options, index: createWebIndex(options) };
  };
  const fixture =
    (
      body = html(
        "Approved customers receive a trial benefit, subject to approval.",
      ),
    ): typeof fetchPublicWebResource =>
    async (url) =>
      url.endsWith("/robots.txt")
        ? response(url, "", 404)
        : response(url, body);
  const due = async () => {
    await db.unsafe(
      "UPDATE absolute_web_frontier SET next_at=clock_timestamp();UPDATE absolute_web_origins SET next_at=clock_timestamp()",
    );
  };
  test("native lexical storage survives a complete runtime restart and applies domain/date filters", async () => {
    const schemaName = `owned_${Date.now()}`;
    const makeCollection = () =>
      createRAGCollection({
        store: createPostgresRAGStore({
          sql: db,
          schemaName,
          dimensions: 8,
          indexType: "none",
        }),
      });
    try {
      const body = html("Approved partnership trial").replace(
        "<head>",
        '<head><meta property="article:published_time" content="2026-09-01T00:00:00Z">',
      );
      const { index, options } = setup(fixture(body), {
        generations: [
          {
            id: "native",
            embedding: { provider: "fixture", model: "lexical", dimensions: 8 },
            collection: makeCollection(),
            retrieval: "lexical",
          },
        ],
      });
      await index.enqueue(["https://example.com/policy"]);
      expect((await index.run()).failures).toBe(0);
      const restarted = createWebIndex({
        ...options,
        generations: [
          { ...options.generations[0]!, collection: makeCollection() },
        ],
      });
      expect(
        (
          await restarted.search({
            query: "trial",
            filters: {
              includeDomains: ["example.com"],
              publishedAfter: "2026-08-01",
            },
          })
        ).sources,
      ).toHaveLength(1);
      expect(
        (
          await restarted.search({
            query: "trial",
            filters: { excludeDomains: ["example.com"] },
          })
        ).sources,
      ).toHaveLength(0);
      expect(
        (
          await restarted.search({
            query: "trial",
            filters: { publishedAfter: "2026-09-20" },
          })
        ).sources,
      ).toHaveLength(0);
      await restarted.remove("https://example.com/policy");
      expect((await index.search({ query: "trial" })).sources).toHaveLength(0);
    } finally {
      await db.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
  });
  test("redirect destinations require configured scope and budget denial publishes no chunks", async () => {
    let admitted = 0;
    const { index } = setup(
      async (url) =>
        url.endsWith("/robots.txt")
          ? response(url, "", 404)
          : response(url, "", 302, {
              location: "https://other.example/private",
            }),
      {
        admit: async () => {
          admitted++;
        },
      },
    );
    await index.enqueue(["https://example.com/policy"]);
    expect((await index.run()).failures).toBe(1);
    expect(admitted).toBe(0);
    const denied = setup(fixture(), {
      tenant: "denied",
      admit: async () => {
        throw new Error("Budget denied");
      },
    }).index;
    await denied.enqueue(["https://example.com/policy"]);
    expect((await denied.run()).failures).toBe(1);
    expect((await denied.stats()).documents).toBe(0);
  });
  test("retries initialization after a transient database outage without restarting the worker", async () => {
    let attempts = 0;
    const recoveringStore = {
      ...store,
      register: async (...args: Parameters<typeof store.register>) => {
        if (++attempts === 1) throw new Error("Temporary database outage");
        await store.register(...args);
      },
    };
    const { index } = setup(fixture(), { store: recoveringStore });
    await expect(index.stats()).rejects.toThrow("Temporary database outage");
    expect((await index.stats()).documents).toBe(0);
    await index.enqueue(["https://example.com/policy"]);
    expect((await index.run()).failures).toBe(0);
  });
  test("indexes scoped passages and exposes corpus coverage without crossing tenants", async () => {
    const { index, options } = setup(fixture());
    await index.enqueue(["https://example.com/policy"]);
    expect((await index.run()).chunks).toBe(1);
    const result = await index.search({ query: "trial", count: 3 });
    expect(result.status).toBe("ok");
    expect(result.sources[0]?.excerpts[0]).toContain("Trial program");
    expect(result.sources[0]?.contentFetchedAt).toBeDefined();
    expect(result.sources[0]?.publishedAt).toBeUndefined();
    const other = createWebIndex({ ...options, tenant: "tenant-b" });
    expect((await other.search({ query: "trial" })).sources).toEqual([]);
  });
  test("restarts from persisted frontier and skips unsupported/private destinations", async () => {
    const { index, options } = setup(fixture());
    await index.enqueue(["https://example.com/policy"]);
    const restarted = createWebIndex(options);
    expect((await restarted.run()).pages).toBe(1);
    await expect(index.enqueue(["http://127.0.0.1/private"])).rejects.toThrow();
    await expect(
      index.enqueue(["https://other.example/policy"]),
    ).rejects.toThrow("outside");
    await expect(
      index.search({ query: "trial", country: "US" }),
    ).rejects.toThrow("country");
  });
  test("enforces the corpus cap under concurrent enqueue", async () => {
    await store.register("scope", "one", "part", "fingerprint");
    const items = (prefix: string) =>
      Array.from({ length: 20 }, (_, i) => ({
        url: `https://example.com/${prefix}${i}`,
        origin: "https://example.com",
        depth: 0,
        priority: 0,
      }));
    await Promise.all([
      store.enqueue("part", items("a"), 7),
      store.enqueue("part", items("b"), 7),
    ]);
    expect((await store.stats("part")).urls).toBe(7);
  });
  test("permits one worker per origin and fences a crashed worker after takeover", async () => {
    await store.register("scope", "one", "part", "fingerprint");
    await store.enqueue(
      "part",
      [
        {
          url: "https://example.com/a",
          origin: "https://example.com",
          depth: 0,
          priority: 1,
        },
        {
          url: "https://example.com/b",
          origin: "https://example.com",
          depth: 0,
          priority: 0,
        },
      ],
      10,
    );
    const claims = await Promise.all([
      store.claim("part", 10000),
      store.claim("part", 10000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const old = claims.find(Boolean)!;
    await db.unsafe(
      "UPDATE absolute_web_frontier SET expires=clock_timestamp()-interval '1 second';UPDATE absolute_web_origins SET expires=clock_timestamp()-interval '1 second'",
    );
    const current = await store.claim("part", 10000);
    expect(current?.url).toBe(old.url);
    expect(await store.finish(old, null, 1000, 0)).toBe(false);
    expect(await store.finish(current!, null, 1000, 0)).toBe(true);
  });
  test("honors durable origin delay across workers", async () => {
    await store.register("scope", "one", "part", "fingerprint");
    await store.enqueue(
      "part",
      [
        {
          url: "https://example.com/a",
          origin: "https://example.com",
          depth: 0,
          priority: 1,
        },
        {
          url: "https://example.com/b",
          origin: "https://example.com",
          depth: 0,
          priority: 0,
        },
      ],
      10,
    );
    const lease = (await store.claim("part", 10000))!;
    expect(await store.finish(lease, null, 1000, 60000)).toBe(true);
    expect(await store.claim("part", 10000)).toBeNull();
  });
  test("uses validators without inventing publication time and skips repeated embedding", async () => {
    let reads = 0,
      admitted = 0;
    const { index } = setup(
      async (url, options) => {
        if (url.endsWith("/robots.txt")) return response(url, "", 404);
        reads++;
        if (reads === 1)
          return response(url, html("Trial policy"), 200, {
            "content-type": "text/html",
            etag: '"one"',
            "last-modified": "Wed, 23 Sep 2026 12:00:00 GMT",
          });
        expect(options?.headers?.["if-none-match"]).toBe('"one"');
        return response(url, "", 304);
      },
      {
        admit: async () => {
          admitted++;
        },
      },
    );
    await index.enqueue(["https://example.com/policy"]);
    await index.run();
    await due();
    expect((await index.run()).unchanged).toBe(1);
    expect(admitted).toBe(1);
    const result = await index.search({ query: "trial" });
    expect(result.sources[0]?.publishedAt).toBeUndefined();
    expect(await index.history("https://example.com/policy")).toHaveLength(1);
  });
  test("retains source history and invalidates projections after content changes", async () => {
    let body = html("Trial policy initial");
    const { index } = setup(async (url) =>
      url.endsWith("/robots.txt")
        ? response(url, "", 404)
        : response(url, body),
    );
    await index.enqueue(["https://example.com/policy"]);
    await index.run();
    await index.project({
      url: "https://example.com/policy",
      extract: async (document) => [
        {
          kind: "company",
          identity: "example.com",
          fields: [
            {
              name: "policy",
              value: "Trial policy initial",
              passageIds: [document.passages[0]!.id],
            },
          ],
        },
      ],
    });
    expect(await index.projections("company")).toHaveLength(1);
    body = html("Replacement policy revised");
    await due();
    await index.run();
    expect(await index.history("https://example.com/policy")).toHaveLength(2);
    expect(await index.projections("company")).toHaveLength(0);
    expect((await index.search({ query: "initial" })).sources).toHaveLength(0);
    expect((await index.search({ query: "revised" })).sources).toHaveLength(1);
  });
  test("a robots outage preserves the last published document and reports failure", async () => {
    let outage = false;
    const { index } = setup(async (url) =>
      url.endsWith("/robots.txt")
        ? response(url, "", outage ? 503 : 404)
        : response(url, html("Stable policy")),
    );
    await index.enqueue(["https://example.com/policy"]);
    await index.run();
    outage = true;
    await due();
    expect((await index.run()).failures).toBe(1);
    expect((await index.search({ query: "stable" })).sources).toHaveLength(1);
  });
  test.each([404, 410])("tombstones disappeared pages (%s)", async (status) => {
    let gone = false;
    const { index } = setup(async (url) =>
      url.endsWith("/robots.txt")
        ? response(url, "", 404)
        : response(url, html("Visible policy"), gone ? status : 200),
    );
    await index.enqueue(["https://example.com/policy"]);
    await index.run();
    gone = true;
    await due();
    expect((await index.run()).deleted).toBe(1);
    expect((await index.search({ query: "visible" })).sources).toHaveLength(0);
  });
  test("noindex and takedowns remove search results; takedowns survive new generations", async () => {
    let body = html("Visible policy");
    const { index, options } = setup(async (url) =>
      url.endsWith("/robots.txt")
        ? response(url, "", 404)
        : response(url, body),
    );
    await index.enqueue(["https://example.com/policy"]);
    await index.run();
    body = body.replace(
      "<head>",
      '<head><meta name="robots" content="noindex">',
    );
    await due();
    await index.run();
    expect((await index.search({ query: "visible" })).sources).toEqual([]);
    await index.remove("https://example.com/policy");
    expect(await index.history("https://example.com/policy")).toEqual([]);
    const next = createWebIndex({
      ...options,
      generations: [
        { ...options.generations[0]!, id: "two", collection: collection() },
      ],
    });
    expect(await next.enqueue(["https://example.com/policy"], "two")).toBe(0);
  });
  test("keeps rebuilds isolated until evaluated activation and rejects embedding identity reuse", async () => {
    const first = {
      id: "one",
      embedding: { provider: "fixture", model: "one", dimensions: 8 },
      collection: collection(),
      retrieval: "lexical" as const,
    };
    const second = {
      ...first,
      id: "two",
      embedding: { ...first.embedding, model: "two" },
      collection: collection(),
    };
    const { index, options } = setup(fixture(html("Generation evidence")), {
      generations: [first, second],
    });
    await index.enqueue(["https://example.com/policy"]);
    await index.run();
    expect(await index.rebuild("one", "two", 10)).toEqual({ enqueued: 1 });
    await index.run({ generation: "two" });
    expect(
      (await index.search({ query: "generation" })).sources[0]?.metadata
        ?.generation,
    ).toBe("one");
    expect(
      await index.activate("two", "one", {
        passed: true,
        evidence: "fixture recall and isolation passed",
      }),
    ).toBe(true);
    expect(
      (await index.search({ query: "generation" })).sources[0]?.metadata
        ?.generation,
    ).toBe("two");
    expect(
      await index.activate("one", "one", {
        passed: true,
        evidence: "stale compare-and-swap",
      }),
    ).toBe(false);
    const wrong = createWebIndex({
      ...options,
      generations: [
        { ...first, embedding: { ...first.embedding, model: "different" } },
      ],
    });
    await expect(wrong.stats()).rejects.toThrow("incompatible");
  });
  test("does not publish content exceeding the page passage budget", async () => {
    const { index } = setup(fixture(html("long policy ".repeat(1000))), {
      limits: {
        maxUrls: 2,
        maxPagesPerRun: 1,
        maxBytesPerRun: 100000,
        maxChunksPerPage: 1,
        maxDepth: 0,
      },
    });
    await index.enqueue(["https://example.com/policy"]);
    expect((await index.run()).failures).toBe(1);
    expect((await index.stats()).documents).toBe(0);
  });
});

describe("index document evidence", () => {
  test("preserves section headings and treats canonical links as hints", () => {
    const doc = parseWebIndexDocument({
      url: "https://example.com/a",
      finalUrl: "https://example.com/a",
      body: '<html><head><link rel="canonical" href="https://other.example/a"></head><body><main><h1>Trial program</h1><p>Benefits apply only to approved trials.</p><h2>Requirements</h2><p>Waivers require written approval.</p></main></body></html>',
      headers: { "content-type": "text/html" },
      status: 200,
      previous: null,
      maxChunks: 10,
    })!;
    expect(doc.passages[1]?.heading).toEqual(["Trial program", "Requirements"]);
    expect(doc.url).toBe("https://example.com/a");
    expect(doc.canonicalHint).toBe("https://other.example/a");
  });
});
