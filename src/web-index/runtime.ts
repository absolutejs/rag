import robotsParser from "robots-parser";
import {
  assertSearchCapabilities,
  type SearchProvider,
  type SearchResult,
} from "@absolutejs/search";
import {
  fetchPublicWebResource,
  validatePublicWebUrl,
  type WebFetchResult,
} from "../web/transport";
import {
  indexHash,
  normalizeIndexUrl,
  parseWebIndexDocument,
} from "./document";
import type {
  WebIndexOptions,
  WebIndexRuntime,
  WebIndexRun,
  WebIndexDocument,
  WebIndexProjection,
} from "./types";
const agent = "AbsoluteJSReader/1.0";
const bounded = (value: number, min: number, max: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${label}`);
  return value;
};
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
const domainChain = (hostname: string) =>
  hostname
    .split(".")
    .map((_, i, all) => all.slice(i).join("."))
    .filter((x) => x.includes("."));
const validDate = (value: string) => {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error("Invalid date filter");
  return new Date(value).toISOString();
};
export const createWebIndex = (options: WebIndexOptions): WebIndexRuntime => {
  if (
    !options.tenant.trim() ||
    !options.index.trim() ||
    !options.generations.length
  )
    throw new Error("Index identity and generations are required");
  const { store } = options,
    scope = indexHash(JSON.stringify([options.tenant, options.index]));
  const origins = new Set(
    options.origins.map((value) => validatePublicWebUrl(value).origin),
  );
  if (!origins.size)
    throw new Error("An explicit crawl origin scope is required");
  const limits = options.limits;
  bounded(limits.maxUrls, 1, 10_000_000, "corpus URL limit");
  bounded(limits.maxPagesPerRun, 1, 1000, "run page limit");
  bounded(limits.maxBytesPerRun, 1, 1_000_000_000, "run byte limit");
  bounded(limits.maxChunksPerPage, 1, 1000, "page passage limit");
  bounded(limits.maxDepth, 0, 100, "crawl depth");
  const timeoutMs = bounded(
    options.timeoutMs ?? 90_000,
    100,
    3_600_000,
    "run timeout",
  );
  const leaseMs = bounded(
    options.leaseMs ?? Math.max(120_000, timeoutMs + 5000),
    timeoutMs + 1000,
    31_536_000_000,
    "worker lease",
  );
  const delayMs = bounded(
    options.originDelayMs ?? 1000,
    0,
    86_400_000,
    "origin delay",
  );
  const recrawlMs = bounded(
    options.recrawlMs ?? 21_600_000,
    1000,
    31_536_000_000,
    "recrawl interval",
  );
  const generations = new Map(options.generations.map((g) => [g.id, g]));
  if (generations.size !== options.generations.length)
    throw new Error("Duplicate index generation");
  for (const g of generations.values()) {
    if (
      !g.id.trim() ||
      !g.embedding.provider.trim() ||
      !g.embedding.model.trim()
    )
      throw new Error("Embedding identity is required");
    bounded(g.embedding.dimensions, 1, 16000, "embedding dimensions");
    if (!g.collection.store.delete)
      throw new Error("Index collections must support scoped chunk deletion");
  }
  const partition = (generation: string) =>
    indexHash(JSON.stringify([scope, generation]));
  let initialization: Promise<void> | undefined;
  const ready = () =>
    (initialization ??= (async () => {
      for (const g of options.generations)
        await store.register(
          scope,
          g.id,
          partition(g.id),
          indexHash(
            JSON.stringify({
              embedding: g.embedding,
              origins: [...origins].sort(),
              representation: 1,
            }),
          ),
        );
    })().catch((error) => {
      initialization = undefined;
      throw error;
    }));
  const resolve = async (id?: string) => {
    await ready();
    const g = generations.get(id ?? (await store.active(scope)) ?? "");
    if (!g)
      throw new Error("Active index generation is not configured on this host");
    return g;
  };
  const allowed = (value: string) => {
    const url = normalizeIndexUrl(value);
    if (!origins.has(new URL(url).origin))
      throw new Error("URL is outside the configured crawl origins");
    return url;
  };
  const metadata = (generation: string, url?: string) => ({
    webIndex: scope,
    webGeneration: generation,
    ...(url ? { webUrl: url } : {}),
  });
  const enqueue = async (urls: string[], generation?: string) => {
    const g = await resolve(generation);
    if (urls.length > 1000)
      throw new Error("Enqueue at most 1000 URLs per call");
    return store.enqueue(
      partition(g.id),
      urls.map((value) => {
        const url = allowed(value);
        return { url, origin: new URL(url).origin, depth: 0, priority: 1 };
      }),
      limits.maxUrls,
    );
  };
  const run: WebIndexRuntime["run"] = async (input = {}) => {
    const g = await resolve(input.generation),
      part = partition(g.id);
    const signal = AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);
    const report: WebIndexRun = {
      pages: 0,
      bytes: 0,
      chunks: 0,
      unchanged: 0,
      deleted: 0,
      failures: 0,
      exhausted: false,
      errors: [],
      providerCostUsd: null,
      infrastructureCostUsd: null,
    };
    const policies = new Map<string, ReturnType<typeof robotsParser>>();
    while (
      report.pages < limits.maxPagesPerRun &&
      report.bytes < limits.maxBytesPerRun &&
      !signal.aborted
    ) {
      const lease = await store.claim(part, leaseMs);
      if (!lease) break;
      report.pages++;
      let effectiveDelay = delayMs;
      const request = async (
        raw: string,
        headers: Record<string, string> = {},
        maxBytes = 5_000_000,
      ): Promise<WebFetchResult> => {
        const url = validatePublicWebUrl(raw);
        signal.throwIfAborted();
        for (;;) {
          const pause = await store.gateOrigin(
            url.origin,
            lease.token,
            leaseMs,
            effectiveDelay,
          );
          if (pause === null)
            throw new Error("Redirect origin is busy; retry scheduled");
          if (!pause) break;
          await wait(pause, signal);
        }
        const remaining = limits.maxBytesPerRun - report.bytes;
        if (remaining <= 0) throw new Error("Run byte budget exhausted");
        const result = await (options.fetchResource ?? fetchPublicWebResource)(
          url.href,
          {
            signal,
            redirect: "manual",
            maxBytes: Math.min(maxBytes, remaining),
            headers: { ...headers, "user-agent": agent },
          },
        );
        report.bytes += result.body.byteLength;
        if (report.bytes > limits.maxBytesPerRun)
          throw new Error("Transport exceeded the run byte budget");
        return result;
      };
      const policy = async (origin: string) => {
        const existing = policies.get(origin);
        if (existing) return existing;
        let url = new URL("/robots.txt", origin).href;
        for (let hop = 0; hop <= 5; hop++) {
          const response = await request(url, {}, 512_000);
          if (
            [301, 302, 303, 307, 308].includes(response.status) &&
            response.headers.location
          ) {
            url = normalizeIndexUrl(
              new URL(response.headers.location, url).href,
            );
            continue;
          }
          if (
            response.status === 429 ||
            response.status >= 500 ||
            response.status < 200 ||
            (response.status >= 300 && response.status < 400)
          )
            throw new Error(`Robots unavailable: HTTP ${response.status}`);
          const parsed = robotsParser(
            new URL("/robots.txt", origin).href,
            response.status >= 400
              ? ""
              : new TextDecoder().decode(response.body),
          );
          const robotsDelay = parsed.getCrawlDelay(agent);
          if (
            robotsDelay !== undefined &&
            Number.isFinite(robotsDelay) &&
            robotsDelay >= 0
          )
            effectiveDelay = Math.max(
              effectiveDelay,
              Math.ceil(robotsDelay * 1000),
            );
          if (effectiveDelay > 86_400_000)
            throw new Error(
              "Robots crawl delay exceeds the configured scheduling range",
            );
          await store.deferOrigin(origin, lease.token, effectiveDelay);
          policies.set(origin, parsed);
          return parsed;
        }
        throw new Error("Robots redirect limit exceeded");
      };
      try {
        let url = allowed(lease.url),
          response: WebFetchResult | undefined;
        let tombstoned = false;
        for (let hop = 0; hop <= 5; hop++) {
          const rules = await policy(new URL(url).origin);
          const robotsDelay = rules.getCrawlDelay(agent);
          if (robotsDelay !== undefined && Number.isFinite(robotsDelay))
            effectiveDelay = Math.max(
              effectiveDelay,
              Math.ceil(robotsDelay * 1000),
            );
          if (rules.isAllowed(url, agent) !== true) {
            if (!(await store.finish(lease, null, recrawlMs, effectiveDelay)))
              throw new Error("Crawl lease was superseded");
            if (lease.document)
              await g.collection.store.delete!({
                filter: {
                  ...metadata(g.id, lease.url),
                  webVersion: lease.document.version,
                },
              });
            report.deleted++;
            tombstoned = true;
            response = undefined;
            break;
          }
          const headers: Record<string, string> = {};
          if (url === lease.document?.finalUrl && lease.document.etag)
            headers["if-none-match"] = lease.document.etag;
          if (url === lease.document?.finalUrl && lease.document.lastModified)
            headers["if-modified-since"] = lease.document.lastModified;
          response = await request(url, headers);
          if (
            [301, 302, 303, 307, 308].includes(response.status) &&
            response.headers.location
          ) {
            url = allowed(new URL(response.headers.location, url).href);
            response = undefined;
            continue;
          }
          break;
        }
        if (!response) {
          if (tombstoned) continue;
          throw new Error("Page redirect limit exceeded");
        }
        if (response.status === 304) {
          if (!lease.document || url !== lease.document.finalUrl)
            throw new Error(
              "Unconditional response returned 304 without an indexed document",
            );
          if (
            !(await store.finish(
              lease,
              { ...lease.document, fetchedAt: new Date().toISOString() },
              recrawlMs,
              effectiveDelay,
            ))
          )
            throw new Error("Crawl lease was superseded");
          report.unchanged++;
          continue;
        }
        if (response.status === 404 || response.status === 410) {
          if (!(await store.finish(lease, null, recrawlMs, effectiveDelay)))
            throw new Error("Crawl lease was superseded");
          if (lease.document)
            await g.collection.store.delete!({
              filter: {
                ...metadata(g.id, lease.url),
                webVersion: lease.document.version,
              },
            });
          report.deleted++;
          continue;
        }
        if (response.status < 200 || response.status >= 300)
          throw new Error(`Page returned HTTP ${response.status}`);
        const document = parseWebIndexDocument({
          url: lease.url,
          finalUrl: url,
          body: new TextDecoder().decode(response.body),
          headers: response.headers,
          status: response.status,
          previous: lease.document,
          maxChunks: limits.maxChunksPerPage,
        });
        if (document && document.version !== lease.document?.version) {
          signal.throwIfAborted();
          await options.admit?.({
            generation: g.id,
            url: lease.url,
            chunks: document.passages.length,
            bytes: response.body.byteLength,
          });
          await g.collection.ingest({
            signal,
            chunks: document.passages.map((p) => ({
              chunkId: indexHash(
                JSON.stringify([part, lease.url, document.version, p.id]),
              ),
              text: p.text,
              title: document.title,
              source: lease.url,
              metadata: {
                ...metadata(g.id, lease.url),
                webVersion: document.version,
                webPassage: p.id,
                webDomains: domainChain(new URL(url).hostname),
                ...(document.publishedAt
                  ? { webPublishedAt: Date.parse(document.publishedAt) }
                  : {}),
                webFetchedAt: document.fetchedAt,
              },
            })),
          });
          report.chunks += document.passages.length;
        } else if (document) report.unchanged++;
        if (!(await store.finish(lease, document, recrawlMs, effectiveDelay)))
          throw new Error("Crawl lease was superseded");
        if (lease.document && lease.document.version !== document?.version)
          await g.collection.store.delete!({
            filter: {
              ...metadata(g.id, lease.url),
              webVersion: lease.document.version,
            },
          });
        if (!document) {
          report.deleted++;
          continue;
        }
        if (lease.depth < limits.maxDepth) {
          const links = document.links
            .filter((link) => origins.has(new URL(link).origin))
            .slice(0, 1000);
          await store.enqueue(
            part,
            links.map((link) => ({
              url: link,
              origin: new URL(link).origin,
              depth: lease.depth + 1,
              priority: 0,
            })),
            limits.maxUrls,
          );
        }
      } catch (error) {
        report.failures++;
        const message = error instanceof Error ? error.message : String(error);
        report.errors.push({ url: lease.url, message });
        await store.fail(
          lease,
          message,
          Math.max(
            effectiveDelay,
            Math.min(3_600_000, 1000 * 2 ** Math.min(lease.attempts, 12)),
          ),
          effectiveDelay,
        );
      } finally {
        await store.releaseOrigins(lease.token, effectiveDelay);
      }
    }
    report.exhausted =
      signal.aborted ||
      report.pages >= limits.maxPagesPerRun ||
      report.bytes >= limits.maxBytesPerRun;
    return report;
  };
  const provider: SearchProvider = {
    name: `absolute-index:${scope}`,
    version: "1",
    capabilities: {
      modes: ["web", "context"],
      filters: [
        "includeDomains",
        "excludeDomains",
        "publishedAfter",
        "publishedBefore",
      ],
      content: ["excerpts", "text"],
    },
    search: async (request) => {
      assertSearchCapabilities(provider, request);
      if (request.goggles?.length || request.threshold)
        throw new Error(
          "Index search does not support goggles or threshold overrides",
        );
      const count = Math.min(
        bounded(request.count ?? 10, 1, 50, "result count"),
        bounded(request.maxUrls ?? 50, 1, 50, "URL count"),
      );
      if (!request.query.trim()) throw new Error("Search query is required");
      const started = Date.now(),
        result: SearchResult = {
          provider: provider.name,
          version: provider.version,
          query: request.query,
          status: "empty",
          sources: [],
          attempts: [],
          limitations: [
            "Results cover this configured corpus; an empty result does not establish that an entity does not exist.",
            "Embedding, reranking and infrastructure costs are metered by the host; they are not assumed to be zero.",
          ],
        };
      try {
        request.signal?.throwIfAborted();
        const g = await resolve(),
          part = partition(g.id),
          filter: Record<string, unknown> = metadata(g.id);
        const domains = (values: string[]) =>
          values.map((value) => {
            const host = new URL(
              value.includes("://") ? value : `https://${value}`,
            ).hostname.toLowerCase();
            if (!host.includes(".")) throw new Error("Invalid domain filter");
            return host;
          });
        if (request.filters?.includeDomains?.length)
          filter.webDomains = {
            $containsAny: domains(request.filters.includeDomains),
          };
        if (request.filters?.excludeDomains?.length)
          filter.$not = {
            webDomains: {
              $containsAny: domains(request.filters.excludeDomains),
            },
          };
        if (request.filters?.publishedAfter || request.filters?.publishedBefore)
          filter.webPublishedAt = {
            ...(request.filters.publishedAfter
              ? { $gte: Date.parse(validDate(request.filters.publishedAfter)) }
              : {}),
            ...(request.filters.publishedBefore
              ? { $lte: Date.parse(validDate(request.filters.publishedBefore)) }
              : {}),
          };
        const candidates = await g.collection.search({
          query: request.query,
          filter,
          topK: Math.min(500, count * 20),
          retrieval: g.retrieval ?? "hybrid",
          signal: request.signal,
        });
        const candidateUrls = [
          ...new Set(
            candidates.flatMap((hit) =>
              typeof hit.metadata?.webUrl === "string"
                ? [hit.metadata.webUrl]
                : [],
            ),
          ),
        ];
        const documents = new Map(
          (await store.lookup(part, candidateUrls)).map((document) => [
            document.url,
            document,
          ]),
        );
        const seen = new Set<string>(),
          seenHashes = new Set<string>();
        let remaining =
          bounded(request.maxTokens ?? 4096, 1, 20000, "token budget") * 4;
        const perUrl =
          bounded(
            request.maxTokensPerUrl ?? 1024,
            1,
            10000,
            "per-URL token budget",
          ) * 4;
        for (const hit of candidates) {
          request.signal?.throwIfAborted();
          const url = hit.metadata?.webUrl;
          if (typeof url !== "string" || seen.has(url)) continue;
          const document = documents.get(url);
          if (
            !document ||
            document.version !== hit.metadata?.webVersion ||
            seenHashes.has(document.contentHash)
          )
            continue;
          seen.add(url);
          seenHashes.add(document.contentHash);
          const passage = document.passages.find(
            (p) => p.id === hit.metadata?.webPassage,
          );
          if (!passage) continue;
          const passages = new Map<string, string>();
          for (const candidate of candidates) {
            if (
              candidate.metadata?.webUrl !== url ||
              candidate.metadata?.webVersion !== document.version
            )
              continue;
            const match = document.passages.find(
              (p) => p.id === candidate.metadata?.webPassage,
            );
            if (match) passages.set(match.id, match.text);
          }
          let allowance = Math.min(remaining, perUrl);
          const excerpts: string[] = [];
          for (const text of passages.values()) {
            if (allowance <= 0) break;
            const excerpt = text.slice(0, allowance);
            excerpts.push(excerpt);
            allowance -= excerpt.length;
            remaining -= excerpt.length;
          }
          if (!excerpts.length) break;
          result.sources.push({
            id: `${indexHash(url).slice(0, 16)}:${document.version.slice(0, 16)}`,
            url: document.finalUrl,
            title: document.title,
            excerpts,
            retrievedAt: new Date().toISOString(),
            contentFetchedAt: document.fetchedAt,
            publishedAt: document.publishedAt,
            metadata: {
              generation: g.id,
              version: document.version,
              changedAt: document.changedAt,
              canonicalHint: document.canonicalHint,
              heading: passage.heading,
            },
          });
          if (result.sources.length >= count || remaining <= 0) break;
        }
        const stats = await store.stats(part);
        result.limitations.push(
          `Corpus: ${stats.documents} documents, ${stats.pending} due URLs, ${stats.failed} failed URLs; oldest fetch ${stats.oldestFetchedAt ?? "none"}.`,
        );
        result.status = result.sources.length ? "ok" : "empty";
        if (
          candidates.length >= Math.min(500, count * 20) &&
          result.sources.length < count
        ) {
          result.status = "partial";
          result.limitations.push(
            "Candidate limit reached while grouping or excluding stale document versions.",
          );
        }
      } catch (error) {
        result.status = request.signal?.aborted ? "cancelled" : "unavailable";
        result.sources = [];
        result.limitations.push(
          error instanceof Error ? error.message : "Index retrieval failed",
        );
      }
      result.attempts.push({
        id: crypto.randomUUID(),
        provider: provider.name,
        endpoint: "owned-index",
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        status: result.status,
        billing: "not_sent",
        costUsd: null,
      });
      return result;
    },
  };
  const validProjection = (
    projection: WebIndexProjection,
    document: WebIndexDocument,
  ) => {
    if (
      !["company", "person", "event"].includes(projection.kind) ||
      !projection.identity.trim() ||
      !projection.fields.length
    )
      throw new Error("Invalid entity projection");
    const ids = new Set(document.passages.map((p) => p.id));
    for (const field of projection.fields) {
      if (
        !field.name.trim() ||
        !field.value.trim() ||
        !field.passageIds.length ||
        field.passageIds.some((id) => !ids.has(id))
      )
        throw new Error("Projection requires exact source passage references");
      if (field.validFrom) validDate(field.validFrom);
      if (field.validUntil) validDate(field.validUntil);
      if (
        field.validFrom &&
        field.validUntil &&
        Date.parse(field.validUntil) < Date.parse(field.validFrom)
      )
        throw new Error("Invalid projection time interval");
    }
  };
  return {
    enqueue,
    run,
    provider,
    search: provider.search,
    stats: async (generation) => {
      const g = await resolve(generation);
      return store.stats(partition(g.id));
    },
    history: async (url, generation) => {
      const g = await resolve(generation);
      return store.history(partition(g.id), allowed(url), 100);
    },
    remove: async (url, generation) => {
      const normalized = allowed(url);
      for (const g of generation
        ? [await resolve(generation)]
        : options.generations) {
        await ready();
        await store.remove(partition(g.id), normalized, true);
        await g.collection.store.delete!({
          filter: metadata(g.id, normalized),
        });
      }
    },
    restore: async (url, generation) => {
      const g = await resolve(generation);
      await store.restore(partition(g.id), allowed(url));
    },
    rebuild: async (from, to, limit, after) => {
      bounded(limit, 1, 1000, "rebuild page size");
      const old = await resolve(from),
        next = await resolve(to);
      if (from === to)
        throw new Error("Rebuild requires a distinct generation");
      const docs = await store.documents(partition(old.id), limit, after);
      const enqueued = await enqueue(
        docs.map((d) => d.url),
        next.id,
      );
      return {
        enqueued,
        ...(docs.length === limit ? { next: docs.at(-1)!.url } : {}),
      };
    },
    activate: async (generation, expected, report) => {
      const g = await resolve(generation);
      const stats = await store.stats(partition(g.id));
      if (!stats.documents || stats.failed || stats.pending)
        throw new Error(
          "Generation must have documents and no pending or failed crawls before activation",
        );
      return store.activate(scope, g.id, expected, report);
    },
    project: async (input) => {
      const g = await resolve(input.generation),
        url = allowed(input.url),
        part = partition(g.id),
        document = await store.document(part, url);
      if (!document)
        throw new Error("No active source document for projection");
      const projections = await input.extract(structuredClone(document));
      let saved = 0;
      for (const projection of projections) {
        validProjection(projection, document);
        if (await store.saveProjection(part, url, document.version, projection))
          saved++;
      }
      return saved;
    },
    projections: async (kind, generation) => {
      const g = await resolve(generation);
      const projections = await store.projections(partition(g.id), kind, 1000),
        now = Date.now();
      return projections
        .map((p) => ({
          ...p,
          fields: p.fields.filter(
            (f) =>
              (!f.validFrom || Date.parse(f.validFrom) <= now) &&
              (!f.validUntil || Date.parse(f.validUntil) > now),
          ),
        }))
        .filter((p) => p.fields.length);
    },
  };
};
