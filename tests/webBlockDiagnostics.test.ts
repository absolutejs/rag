import { expect, test } from "bun:test";
import {
  readRAGWebpage,
  webReadDiagnostics,
  WebReadError,
} from "../src/web/index";
import { validatePublicWebUrl } from "../src/web/transport";
test("URL policy reasons survive read results without echoing secrets", async () => {
  for (const [url, reason] of [
    ["http://127.0.0.1/", "ipv4_loopback"],
    ["https://secret:secret@example.com/", "url_credentials"],
    ["https://example.com:1234/", "nonstandard_port"],
    ["http://host.internal/", "local_hostname"],
    ["ftp://example.com/", "unsupported_protocol"],
  ]) {
    const result = await readRAGWebpage({ url: url! });
    expect(result.status).toBe("error");
    expect(webReadDiagnostics(result).failure).toEqual({
      stage: "url",
      blockReason: reason,
      redirectHop: 0,
    });
    expect(JSON.stringify(webReadDiagnostics(result))).not.toContain("secret");
  }
  expect(validatePublicWebUrl("https://192.0.78.24/").hostname).toBe(
    "192.0.78.24",
  );
});
test("DNS policy diagnostics survive attempts and discard untrusted fields", async () => {
  const result = await readRAGWebpage({
    url: "https://example.com/",
    fetchResource: async () => {
      throw new WebReadError("blocked_url", "private details", {
        attempts: [],
        failure: { stage: "dns", blockReason: "ipv4_private", redirectHop: 2 },
      });
    },
  });
  const safe = webReadDiagnostics(result);
  expect(safe.failure).toEqual({
    stage: "dns",
    blockReason: "ipv4_private",
    redirectHop: 2,
  });
  expect(safe.attempts[0]?.failure).toEqual(safe.failure);
  expect(
    webReadDiagnostics({
      failure: {
        stage: "dns",
        blockReason: "secret",
        redirectHop: 500,
        address: "10.0.0.1",
      },
    }).failure,
  ).toEqual({ stage: "dns" });
});
