import { describe, expect, it } from "bun:test";
import { createDiscoveryTransport } from "../src/sync/discoveryTransport";
import type { fetchPublicWebResource, WebFetchResult } from "../src/web/transport";
import { createRAGSiteDiscoverySyncSource, createRAGSyncManager } from "../src/sync/sync";
import { createInMemoryRAGStore } from "../src/adapters/inMemory";
import { createRAGCollection } from "../src/retrieval/collection";

const result = (url: string, body = "", status = 200, headers: Record<string, string> = {}): WebFetchResult => ({
  url, status, headers, body: new TextEncoder().encode(body),
});
const fixture = (robots: string, status = 200) => {
  const calls: string[] = [];
  const resource: typeof fetchPublicWebResource = async (url, options) => {
    calls.push(url);
    expect(options?.headers?.["user-agent"]).toBe("AbsoluteJSReader/1.0");
    return result(url, new URL(url).pathname === "/robots.txt" ? robots : "page", new URL(url).pathname === "/robots.txt" ? status : 200);
  };
  return { calls, resource, transport: createDiscoveryTransport(resource, true) };
};

describe("public discovery transport", () => {
  it("honors a site-wide disallow without requesting pages", async () => {
    const f = fixture("User-agent: *\nDisallow: /");
    await expect(f.transport.get("https://example.com/")).rejects.toMatchObject({ code: "robots_denied" });
    expect(f.calls).toEqual(["https://example.com/robots.txt"]);
  });
  it("applies specific agents, merged groups, allow precedence and wildcards", async () => {
    const f = fixture("User-agent: *\nDisallow: /\nUser-agent: AbsoluteJSReader\nDisallow: /private\nAllow: /private/public\nDisallow: /*.pdf$\nUser-agent: absolutejsreader\nDisallow: /members");
    for (const path of ["/", "/private/public", "/guide.pdf?download=1"])
      expect(await f.transport.allowed("https://example.com" + path)).toBe(true);
    for (const path of ["/private/a", "/members", "/guide.pdf"])
      expect(await f.transport.allowed("https://example.com" + path)).toBe(false);
    expect(f.calls.length).toBe(1);
  });
  it("allows equally specific allow rules and matches encoded Unicode", async () => {
    const f = fixture("User-agent: *\nDisallow: /same\nAllow: /same\nDisallow: /café\nDisallow: /query?secret=");
    expect(await f.transport.allowed("https://example.com/same")).toBe(true);
    expect(await f.transport.allowed("https://example.com/caf%C3%A9")).toBe(false);
    expect(await f.transport.allowed("https://example.com/query?secret=yes")).toBe(false);
  });
  it.each([404, 410])("permits crawling when robots is unavailable (%s)", async (status) => {
    const f = fixture("", status);
    expect((await f.transport.get("https://example.com/page")).status).toBe(200);
  });
  it.each([429, 500, 503])("stops on temporary robots failure (%s)", async (status) => {
    const f = fixture("", status);
    await expect(f.transport.get("https://example.com/page")).rejects.toMatchObject({ code: "robots_unreachable" });
    expect(f.calls).toEqual(["https://example.com/robots.txt"]);
  });
  it("propagates network failure and never requests a page", async () => {
    let calls = 0;
    const client = createDiscoveryTransport(async () => { calls++; throw new Error("network failed"); }, true);
    await expect(client.get("https://example.com/page")).rejects.toThrow("network failed");
    expect(calls).toBe(1);
  });
  it("checks the destination's robots before following a cross-origin redirect", async () => {
    const calls: string[] = [];
    const client = createDiscoveryTransport(async (url) => {
      calls.push(url);
      if (url === "https://example.com/robots.txt") return result(url);
      if (url === "https://example.com/start") return result(url, "", 302, { location: "https://other.example/private" });
      if (url === "https://other.example/robots.txt") return result(url, "User-agent: *\nDisallow: /");
      throw new Error("Forbidden page was requested");
    }, true);
    await expect(client.get("https://example.com/start")).rejects.toMatchObject({ code: "robots_denied" });
    expect(calls).toHaveLength(3);
  });
  it("rejects private seeds and redirect destinations before transport", async () => {
    let calls = 0;
    const client = createDiscoveryTransport(async (url) => { calls++; return result(url, "", 302, { location: "http://127.0.0.1/" }); });
    await expect(client.get("http://127.0.0.1/")).rejects.toMatchObject({ code: "blocked_url" });
    expect(calls).toBe(0);
    await expect(client.get("https://example.com/start")).rejects.toMatchObject({ code: "blocked_url" });
    expect(calls).toBe(1);
  });
  it("bounds redirect loops", async () => {
    let calls = 0;
    const client = createDiscoveryTransport(async (url) => { calls++; return result(url, "", 302, { location: url }); });
    await expect(client.get("https://example.com/start")).rejects.toMatchObject({ code: "redirect_limit" });
    expect(calls).toBe(6);
  });
  it("preserves indexed documents when a later robots request fails", async () => {
    let unavailable = false;
    const collection = createRAGCollection({ store: createInMemoryRAGStore({ dimensions: 8 }) });
    const manager = createRAGSyncManager({ collection, sources: [createRAGSiteDiscoverySyncSource({
      id: "site", label: "site", sites: [{ url: "https://example.com/" }],
      autoDiscoverFeeds: false, autoDiscoverSitemaps: false, autoDiscoverLinkedPages: true,
      fetchResource: async (url) => {
        if (url.endsWith("/robots.txt")) return result(url, "", unavailable ? 503 : 404);
        if (url === "https://example.com/") return result(url, '<html><a href="/guide.md">Guide</a></html>', 200, { "content-type": "text/html" });
        return result(url, "# Guide\n\nKeep this indexed research guide.", 200, { "content-type": "text/markdown" });
      },
    })] });
    expect((await manager.syncSource?.("site"))?.ok).toBe(true);
    const before = await collection.search({ query: "indexed research guide", retrieval: "hybrid", topK: 3 });
    expect(before.length).toBeGreaterThan(0);
    unavailable = true;
    expect((await manager.syncSource?.("site"))?.ok).toBe(false);
    expect(await collection.search({ query: "indexed research guide", retrieval: "hybrid", topK: 3 })).toEqual(before);
  });
});
