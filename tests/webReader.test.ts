import { expect, test } from "bun:test";
import {
  readRAGWebpage,
  isPublicWebAddress,
  validatePublicWebUrl,
  fetchPublicWebResource,
  type WebRenderer,
} from "../src/web";
import {
  loadRAGDocumentFromURL,
  loadRAGDocumentsFromURLs,
  prepareRAGDocument,
} from "../src/ingestion/ingestion";
const url = "https://example.com/company/";
const company =
  "Our company builds property management software for apartment operators. ".repeat(
    8,
  );
const response =
  (html: string, status = 200) =>
  async () => ({
    url,
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: new TextEncoder().encode(html),
  });
test("ordinary CMS HTML is prepared before truncation and does not need a browser", async () => {
  const result = await readRAGWebpage({
    url,
    fetchResource: response(
      `<html><head><title>Company</title><script>${"x".repeat(13000)}</script></head><body><main><h1>About</h1><p>${company}</p></main></body></html>`,
    ),
    render: () => {
      throw Error("Must not render");
    },
  });
  expect(result.status).toBe("ok");
  expect(result.method).toBe("http");
  expect(result.text).toContain("property management");
  expect(result.text).not.toContain("<");
  expect(result.text).not.toContain("xxxx");
});
for (const [name, shell] of [
  ["React", '<div id="root"></div>'],
  ["Vue", '<div id="app"></div>'],
  ["Next", '<main id="__next"></main>'],
  ["Angular", "<app-root></app-root>"],
]) {
  test(`${name} shell automatically uses browser evidence`, async () => {
    const result = await readRAGWebpage({
      url,
      fetchResource: response(
        `<html><body>${shell}<noscript>Enable JavaScript</noscript><script src="/app.js"></script></body></html>`,
      ),
      render: async () => ({
        url,
        status: 200,
        html: `<html><main><h1>Company</h1><p>${company}</p></main></html>`,
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.method).toBe("browser");
    expect(result.text).toContain("property management");
    expect(result.attempts).toHaveLength(2);
  });
}
test("no renderer, blocked challenge, timeout and not found remain distinct", async () => {
  const shell = response('<html><body><div id="root"></div></body></html>');
  expect(
    (await readRAGWebpage({ url, fetchResource: shell })).error?.code,
  ).toBe("rendering_required");
  const render: WebRenderer = async () => ({
    url,
    status: 403,
    html: "<html><body>Verify you are human</body></html>",
  });
  expect(
    (await readRAGWebpage({ url, fetchResource: shell, render })).error?.code,
  ).toBe("access_blocked");
  expect(
    (await readRAGWebpage({ url, fetchResource: response("", 404), render }))
      .error?.code,
  ).toBe("http_error");
  expect(
    (
      await readRAGWebpage({
        url,
        fetchResource: shell,
        render: async () => {
          throw new DOMException("Timed out", "TimeoutError");
        },
      })
    ).error?.code,
  ).toBe("timeout");
});
test("literal and encoded internal targets are blocked before fetching or rendering", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    expect(isPublicWebAddress(address)).toBe(false);
  expect(isPublicWebAddress("1.1.1.1")).toBe(true);
  for (const target of [
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://[::ffff:7f00:1]/",
    "http://localhost/",
    "file:///etc/passwd",
    "https://user:password@example.com/",
  ]) {
    expect(() => validatePublicWebUrl(target)).toThrow();
    const result = await readRAGWebpage({
      url: target,
      fetchResource: () => {
        throw Error("Must not fetch");
      },
    });
    expect(result.status).toBe("error");
  }
  await expect(
    fetchPublicWebResource("http://169.254.169.254/"),
  ).rejects.toThrow();
});
test("extensionless URL loaders respect HTML response MIME in single and batch loading", async () => {
  const original = globalThis.fetch;
  // The loader API uses global fetch; restore it for every other test.
  globalThis.fetch = Object.assign(
    async () =>
      new Response(`<html><main>${company}</main></html>`, {
        headers: { "content-type": "text/html" },
      }),
    { preconnect: original.preconnect },
  ) as typeof fetch;
  try {
    const doc = await loadRAGDocumentFromURL({ url });
    expect(doc.format).toBe("html");
    expect(prepareRAGDocument(doc).normalizedText).not.toContain("<");
    const batch = await loadRAGDocumentsFromURLs({ urls: [{ url }] });
    expect(batch.documents[0]?.format).toBe("html");
  } finally {
    globalThis.fetch = original;
  }
});
test("large readable evidence is explicitly truncated", async () => {
  const result = await readRAGWebpage({
    url,
    maxChars: 1000,
    fetchResource: response(`<html><main>${company.repeat(5)}</main></html>`),
  });
  expect(result.status).toBe("ok");
  expect(result.truncated).toBe(true);
  expect(result.text.length).toBe(1000);
});
