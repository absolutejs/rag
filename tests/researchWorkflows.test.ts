import { test, expect, describe } from "bun:test";
import { SQL } from "bun";
import {
  createMemoryResearchWorkflowStore,
  createPostgresResearchWorkflowStore,
  researchWorkflowPostgresSchemaSql,
  type ResearchWorkflowStore,
} from "../src/research/store";
import { createResearchWorkflows } from "../src/research/workflows";
import type { ResearchResult, ResearchRuntime } from "../src/research/types";
const complete: ResearchResult = {
  id: "1",
  status: "reviewed",
  data: { name: "Example" },
  fields: [
    {
      path: "/name",
      value: "Example",
      verdict: "supported",
      citations: [],
      reason: "",
    },
  ],
  sources: [],
  searches: [],
  operations: [],
  generatedAt: "",
  limitations: [],
};
const conformance = async (store: ResearchWorkflowStore) => {
  const key = crypto.randomUUID();
  const first = await store.claim(key, "inputs", 30000);
  expect(first).not.toBeNull();
  expect(await store.claim(key, "inputs", 30000)).toBeNull();
  await expect(store.claim(key, "other-inputs", 30000)).rejects.toThrow(
    "different inputs",
  );
  expect(
    await store.commit(key, { ...first!, token: "stale" }, { bad: true }),
  ).toBe(false);
  expect(
    await store.commit(key, first!, { good: true }, [
      { id: "e1", key, payload: { message: "new event" } },
    ]),
  ).toBe(true);
  expect(await store.commit(key, first!, { bad: true })).toBe(false);
  const second = await store.claim(key, "inputs", 30000);
  expect(second!.value).toEqual({ good: true });
  expect(second!.revision).toBe(1);
  const pending = await store.deliveries(key, 10);
  expect(pending).toEqual([
    { id: "e1", key, payload: { message: "new event" } },
  ]);
  await store.acknowledge("different-tenant", "e1");
  expect(await store.deliveries(key, 10)).toHaveLength(1);
  await store.acknowledge(key, "e1");
  expect(await store.deliveries(key, 10)).toEqual([]);
  await store.release(key, second!.token);
};
test("memory store fences claims and scopes deliveries", () =>
  conformance(createMemoryResearchWorkflowStore()));
test("expired memory claim cannot overwrite successor", async () => {
  let now = 0;
  const store = createMemoryResearchWorkflowStore(() => now);
  const old = await store.claim("key", "input", 10);
  now = 11;
  const next = await store.claim("key", "input", 10);
  expect(await store.commit("key", old!, "old")).toBe(false);
  expect(await store.commit("key", next!, "new")).toBe(true);
});
test("batch resumes completed items and rejects changed inputs", async () => {
  let calls = 0;
  const store = createMemoryResearchWorkflowStore();
  const runtime: ResearchRuntime = {
    run: async () => {
      calls++;
      return complete;
    },
    extract: async () => complete as any,
  };
  const workflows = createResearchWorkflows({
    runtime,
    store,
    scope: "tenant-a",
    version: "1",
  });
  const input = { id: "batch1", items: [{ id: "one", query: "Example" }] };
  expect((await workflows.batch(input))[0]!.status).toBe("complete");
  await workflows.batch(input);
  expect(calls).toBe(1);
  await expect(
    workflows.batch({ ...input, items: [{ id: "one", query: "different" }] }),
  ).rejects.toThrow("different inputs");
  await createResearchWorkflows({
    runtime,
    store,
    scope: "tenant-b",
    version: "1",
  }).batch(input);
  expect(calls).toBe(2);
});
test("monitor baseline is silent, failed delivery retained, repeats deduplicated", async () => {
  let now = Date.parse("2026-09-24T12:00:00Z");
  let failure = false;
  const store = createMemoryResearchWorkflowStore(() => now);
  const runtime: ResearchRuntime = {
    run: async () =>
      failure ? { ...complete, status: "unavailable" } : complete,
    extract: async () => complete as any,
  };
  const workflows = createResearchWorkflows({
    runtime,
    store,
    scope: "tenant",
    version: "1",
    now: () => now,
  });
  let eventId = "old";
  const input = {
    id: "monitor",
    query: "Example",
    select: () => [
      {
        id: eventId,
        occurredAt: new Date(now).toISOString(),
        fields: ["/name"],
        payload: "event",
      },
    ],
  };
  expect((await workflows.monitor(input)).status).toBe("baseline");
  expect(
    await workflows.deliverMonitor("monitor", async () => {
      throw new Error("unexpected");
    }),
  ).toBe(0);
  now += 1000;
  eventId = "new";
  expect((await workflows.monitor(input)).events).toBe(1);
  await expect(
    workflows.deliverMonitor("monitor", async () => {
      throw new Error("delivery failed");
    }),
  ).rejects.toThrow();
  expect((await workflows.monitor(input)).events).toBe(0);
  let deliveries = 0;
  expect(
    await workflows.deliverMonitor("monitor", async () => {
      deliveries++;
    }),
  ).toBe(1);
  expect(deliveries).toBe(1);
  failure = true;
  expect((await workflows.monitor(input)).status).toBe("incomplete");
  failure = false;
  expect((await workflows.monitor(input)).events).toBe(0);
});
const databaseUrl = process.env.RESEARCH_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("isolated PostgreSQL store", () => {
  test("atomic state, deliveries, and stale claim fencing on real PostgreSQL", async () => {
    const sql = new SQL(databaseUrl!);
    try {
      await sql.unsafe(researchWorkflowPostgresSchemaSql());
      const store = createPostgresResearchWorkflowStore({
        unsafe: (query, parameters) => sql.unsafe(query, parameters as any[]),
      });
      await conformance(store);
      const key = crypto.randomUUID();
      const old = await store.claim(key, "input", 1);
      await sql.unsafe("SELECT pg_sleep(0.01)");
      const next = await store.claim(key, "input", 30000);
      expect(await store.commit(key, old!, "old")).toBe(false);
      expect(await store.commit(key, next!, "new")).toBe(true);
    } finally {
      await sql.close();
    }
  });
});

test("a successful empty monitor check establishes a baseline before the first event", async () => {
  let now = Date.parse("2026-09-24T12:00:00Z");
  let hasEvent = false;
  const runtime: ResearchRuntime = {
    run: async () =>
      hasEvent
        ? complete
        : { ...complete, status: "empty", data: null, fields: [] },
    extract: async () => complete as any,
  };
  const workflows = createResearchWorkflows({
    runtime,
    store: createMemoryResearchWorkflowStore(() => now),
    scope: "tenant-empty",
    version: "1",
    now: () => now,
  });
  const input = {
    id: "monitor",
    query: "Example",
    select: () =>
      hasEvent
        ? [
            {
              id: "launch",
              occurredAt: new Date(now).toISOString(),
              fields: ["/name"],
              payload: "new launch",
            },
          ]
        : [],
  };
  expect((await workflows.monitor(input)).status).toBe("baseline");
  now += 1000;
  hasEvent = true;
  expect((await workflows.monitor(input)).events).toBe(1);
});
