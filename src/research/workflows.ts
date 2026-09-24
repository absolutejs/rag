import { Type } from "@sinclair/typebox";
import type { ResearchInput, ResearchResult, ResearchRuntime } from "./types";
import {
  researchKey,
  type ResearchWorkflowStore,
  type ResearchDelivery,
} from "./store";

export type ResearchCriterion = { id: string; description: string };
export type ResearchCandidate = {
  name: string;
  domain: string;
  evidence: ResearchResult;
  criteria: {
    id: string;
    verdict: "matched" | "not_matched" | "unknown";
    evidence: ResearchResult;
  }[];
};

export const discoverResearchCompanies = async (
  runtime: ResearchRuntime,
  input: {
    query: string;
    criteria: ResearchCriterion[];
    limit?: number;
    signal?: AbortSignal;
  },
) => {
  const limit = input.limit ?? 5;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    input.criteria.length > 10 ||
    new Set(input.criteria.map((criterion) => criterion.id)).size !==
      input.criteria.length
  )
    throw new Error("Invalid company discovery bounds or duplicate criteria");
  const discovery = await runtime.extract(
    {
      schema: Type.Object({
        companies: Type.Array(
          Type.Object({ name: Type.String(), domain: Type.String() }),
          { maxItems: limit },
        ),
      }),
      instructions:
        "Find distinct companies relevant to the query. domain must be their official website hostname, verified from sources. Do not invent companies to fill the requested limit.",
    },
    { query: input.query, signal: input.signal },
  );
  const candidates: ResearchCandidate[] = [];
  const domains = new Set<string>();
  // A partially verified list can still contain independently verified companies.
  for (let index = 0; index < limit; index++) {
    const name = discovery.fields.find(
      (field) =>
        field.path === `/companies/${index}/name` &&
        field.verdict === "supported",
    );
    const domain = discovery.fields.find(
      (field) =>
        field.path === `/companies/${index}/domain` &&
        field.verdict === "supported",
    );
    if (typeof name?.value !== "string" || typeof domain?.value !== "string")
      continue;
    let hostname: string;
    try {
      const url = new URL(`https://${domain.value}`);
      if (
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        url.port
      )
        continue;
      hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
    } catch {
      continue;
    }
    if (domains.has(hostname)) continue;
    domains.add(hostname);
    const candidate: ResearchCandidate = {
      name: name.value,
      domain: hostname,
      evidence: discovery,
      criteria: [],
    };
    for (const criterion of input.criteria) {
      input.signal?.throwIfAborted();
      const evidence = await runtime.extract(
        {
          schema: Type.Object({
            matches: Type.Boolean(),
            explanation: Type.String(),
          }),
          instructions:
            "Determine whether evidence establishes the supplied criterion for the exact company. A false value needs affirmative evidence of non-matching, not missing search results.",
        },
        {
          query: `${name.value} official domain ${hostname}. Criterion: ${criterion.description}`,
          signal: input.signal,
        },
      );
      candidate.criteria.push({
        id: criterion.id,
        verdict: evidence.data
          ? evidence.data.matches
            ? "matched"
            : "not_matched"
          : "unknown",
        evidence,
      });
    }
    candidates.push(candidate);
  }
  return {
    discovery,
    candidates,
    accepted: candidates.filter(
      (candidate) =>
        candidate.criteria.length > 0 &&
        candidate.criteria.every(
          (criterion) => criterion.verdict === "matched",
        ),
    ),
  };
};

export type ResearchBatchItem = {
  id: string;
  query: string;
  task?: string;
  freshness?: string;
};
export type ResearchMonitorEvent = {
  id: string;
  occurredAt: string;
  fields: string[];
  payload: unknown;
};
type MonitorState = {
  initializedAt: string;
  seen: string[];
  checkedAt: string;
};
export const createResearchWorkflows = (options: {
  runtime: ResearchRuntime;
  store: ResearchWorkflowStore;
  scope: string;
  version: string;
  leaseMs?: number;
  now?: () => number;
}) => {
  if (!options.scope.trim() || !options.version.trim())
    throw new Error("Workflow scope and task version are required");
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? 120000;
  const keyFor = (kind: string, id: unknown) =>
    researchKey([options.scope, kind, id]);
  return {
    async batch(input: {
      id: string;
      items: ResearchBatchItem[];
      signal?: AbortSignal;
    }) {
      if (
        input.items.length > 100 ||
        new Set(input.items.map((item) => item.id)).size !== input.items.length
      )
        throw new Error("Batch requires at most 100 uniquely identified items");
      const results: {
        id: string;
        status: "complete" | "busy" | "lease_lost";
        result?: ResearchResult;
      }[] = [];
      for (const item of input.items) {
        input.signal?.throwIfAborted();
        const key = await keyFor("batch", [input.id, item.id]);
        const fingerprint = await researchKey([options.version, item]);
        const claim = await options.store.claim(key, fingerprint, leaseMs);
        if (!claim) {
          results.push({ id: item.id, status: "busy" });
          continue;
        }
        try {
          if (claim.value) {
            results.push({
              id: item.id,
              status: "complete",
              result: claim.value as ResearchResult,
            });
            continue;
          }
          const result = await options.runtime.run({
            ...item,
            signal: input.signal,
          });
          const committed = await options.store.commit(key, claim, result);
          results.push({
            id: item.id,
            status: committed ? "complete" : "lease_lost",
            ...(committed ? { result } : {}),
          });
        } finally {
          await options.store.release(key, claim.token);
        }
      }
      return results;
    },
    /** Schedule this function using the existing Queue/cron infrastructure. It owns no timer. */
    async monitor(input: {
      id: string;
      query: string;
      task?: string;
      freshness?: string;
      signal?: AbortSignal;
      select: (result: ResearchResult) => ResearchMonitorEvent[];
    }) {
      const key = await keyFor("monitor", input.id);
      const fingerprint = await researchKey([
        options.version,
        input.query,
        input.task,
        input.freshness,
      ]);
      const claim = await options.store.claim(key, fingerprint, leaseMs);
      if (!claim) return { status: "busy" as const, events: 0 };
      try {
        const result = await options.runtime.run(input);
        if (result.status !== "reviewed" && result.status !== "empty")
          return { status: "incomplete" as const, events: 0, result };
        const previous = claim.value as MonitorState | null;
        const checkedAt = new Date(now()).toISOString();
        const events = input
          .select(result)
          .filter(
            (event) =>
              event.id &&
              event.fields.length > 0 &&
              event.fields.every((path) =>
                result.fields.some(
                  (field) =>
                    field.path === path && field.verdict === "supported",
                ),
              ) &&
              Number.isFinite(Date.parse(event.occurredAt)) &&
              Date.parse(event.occurredAt) <= now(),
          );
        const seen = new Set(previous?.seen ?? []);
        const deliveries: ResearchDelivery[] = [];
        for (const event of events) {
          const id = await researchKey([event.id, event.occurredAt]);
          if (seen.has(id)) continue;
          seen.add(id);
          if (
            previous &&
            Date.parse(event.occurredAt) >= Date.parse(previous.initializedAt)
          )
            deliveries.push({ id, key, payload: event.payload });
        }
        // Never silently evict deduplication history and resend old events.
        if (seen.size > 10000)
          throw new Error(
            "Monitor history capacity reached; archive and rotate the monitor explicitly",
          );
        const committed = await options.store.commit(
          key,
          claim,
          {
            initializedAt: previous?.initializedAt ?? checkedAt,
            checkedAt,
            seen: [...seen],
          },
          deliveries,
        );
        return {
          status: committed
            ? previous
              ? ("updated" as const)
              : ("baseline" as const)
            : ("lease_lost" as const),
          events: committed ? deliveries.length : 0,
          result,
        };
      } finally {
        await options.store.release(key, claim.token);
      }
    },
    /** Delivery is at-least-once: the receiver MUST deduplicate using event.id. */
    async deliverMonitor(
      id: string,
      deliver: (event: ResearchDelivery) => Promise<void>,
    ) {
      const key = await keyFor("monitor", id);
      const events = await options.store.deliveries(key, 100);
      for (const event of events) {
        await deliver(event);
        await options.store.acknowledge(key, event.id);
      }
      return events.length;
    },
  };
};

export const researchMonitorTask = {
  schema: Type.Object({
    events: Type.Array(
      Type.Object({
        entity: Type.String(),
        type: Type.String(),
        occurredAt: Type.String(),
        summary: Type.String(),
      }),
      { maxItems: 20 },
    ),
  }),
  instructions:
    "Find newly announced events about the exact requested entity. occurredAt must be the explicit event date in ISO 8601, not a crawl/publication date or a guessed timestamp. type should be a stable category. Return an empty list if no supported events exist.",
};
export const selectResearchMonitorEvents = (
  result: ResearchResult,
): ResearchMonitorEvent[] => {
  const data = result.data as {
    events?: {
      entity: string;
      type: string;
      occurredAt: string;
      summary: string;
    }[];
  } | null;
  if (!Array.isArray(data?.events)) return [];
  return data.events.map((event, index) => ({
    id: JSON.stringify([
      event.entity.normalize("NFKC").toLowerCase(),
      event.type.normalize("NFKC").toLowerCase(),
      event.summary.normalize("NFKC").toLowerCase(),
    ]),
    occurredAt: event.occurredAt,
    fields: ["entity", "type", "occurredAt", "summary"].map(
      (key) => `/events/${index}/${key}`,
    ),
    payload: event,
  }));
};
