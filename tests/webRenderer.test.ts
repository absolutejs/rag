import { expect, test } from "bun:test";
import { createPlaywrightWebRenderer } from "../src/web/playwright";
import { webTransportFailure } from "../src/web";

test("browser preserves main-document transport causes", async () => {
  const reader = createPlaywrightWebRenderer({
    fetchResource: async () => {
      throw webTransportFailure(
        Object.assign(new Error("private token"), { code: "ENOTFOUND" }),
        "dns",
      );
    },
  });
  try {
    await expect(
      reader.render("https://example.com/", {
        signal: AbortSignal.timeout(10000),
      }),
    ).rejects.toMatchObject({
      code: "dns_not_found",
      diagnostics: { failure: { stage: "dns", transportCode: "ENOTFOUND" } },
    });
  } finally {
    await reader.close();
  }
}, 15000);
test("optional subresource failure keeps rendered text and bounded safe diagnostics", async () => {
  const text =
    "This company provides useful verified information about its products and services. ".repeat(
      4,
    );
  const reader = createPlaywrightWebRenderer({
    fetchResource: async (url) => {
      if (url.endsWith("broken.js"))
        throw webTransportFailure(
          Object.assign(new Error("private token"), { code: "ECONNRESET" }),
          "request",
        );
      return {
        url,
        status: 200,
        headers: { "content-type": "text/html" },
        body: new TextEncoder().encode(
          `<html><body><p>${text}</p><script src="/broken.js"></script></body></html>`,
        ),
      };
    },
  });
  try {
    const result = await reader.render("https://example.com/", {
      signal: AbortSignal.timeout(15000),
    });
    expect(result.text).toContain(text.trim());
    expect(result.resourceFailures).toEqual([
      { stage: "request", transportCode: "ECONNRESET" },
    ]);
    expect(JSON.stringify(result)).not.toContain("private token");
  } finally {
    await reader.close();
  }
}, 20000);

test("browser launch failures are actionable without exposing executable paths", async () => {
  const reader = createPlaywrightWebRenderer({
    executablePath: "/nonexistent/private-token/browser",
  });
  try {
    await expect(
      reader.render("https://example.com/", {
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toMatchObject({
      code: "renderer_failed",
      message: "Browser rendering failed (renderer_failed).",
      diagnostics: { failure: { stage: "render" } },
    });
  } finally {
    await reader.close();
  }
});
