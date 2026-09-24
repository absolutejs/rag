import { expect, test } from "bun:test";
import {
  createWebsiteReaderClient,
  parseWebsiteServiceResult,
} from "../src/web/remote";
const fake = (fn: (url: unknown, init?: RequestInit) => Promise<Response>) =>
  fn as typeof fetch;
test("service timeout leaves a live reserved fallback signal", async () => {
  let fallback = false;
  const read = createWebsiteReaderClient({
    endpoint: "http://reader/read",
    timeoutMs: 1000,
    fallbackReserveMs: 980,
    fetch: fake(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true },
          );
        }),
    ),
    fallback: async ({ signal }) => {
      fallback = true;
      expect(signal.aborted).toBe(false);
      return { status: "partial", text: "Static evidence" };
    },
  });
  expect((await read({ url: "https://example.com" })).text).toBe(
    "Static evidence",
  );
  expect(fallback).toBe(true);
});
test("caller cancellation never starts fallback; service saturation stays retryable", async () => {
  let fallback = 0;
  const make = (fetch: typeof globalThis.fetch) =>
    createWebsiteReaderClient({
      endpoint: "http://reader/read",
      fetch,
      fallback: async () => {
        fallback++;
        return { status: "ok", text: "x" };
      },
    });
  await expect(
    make(fake(async () => Response.json({})))({
      url: "https://example.com",
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(
    (
      await make(fake(async () => new Response("busy", { status: 503 })))({
        url: "https://example.com",
      })
    ).status,
  ).toBe("error");
  expect(fallback).toBe(0);
  expect(() =>
    parseWebsiteServiceResult({
      status: "ok",
      text: "x",
      sources: [{ url: "javascript:alert(1)" }],
    }),
  ).toThrow("sources");
});

test("isolated reader failures never need an in-process parser", async () => {
  for (const fetch of [
    fake(async () => {
      throw new Error("offline");
    }),
    fake(async () => new Response("failed", { status: 502 })),
    fake(async () => Response.json({ invalid: true })),
  ]) {
    const read = createWebsiteReaderClient({
      endpoint: "http://reader/read",
      fetch,
    });
    expect(await read({ url: "https://example.com" })).toMatchObject({
      status: "error",
      error: { code: "reader_unavailable" },
    });
  }
});
