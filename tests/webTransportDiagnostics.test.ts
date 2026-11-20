import { expect, test } from "bun:test";
import {
  webTransportFailure,
  webReadDiagnostics,
  WebReadError,
  readRAGWebpage,
} from "../src/web";
const url = "https://example.com/";
test("transport classification retains safe stage/code/limit but never raw secret-bearing errors", () => {
  for (const [cause, code] of [
    ["ENOTFOUND", "dns_not_found"],
    ["EAI_AGAIN", "dns_unavailable"],
    ["HPE_HEADER_OVERFLOW", "response_headers_too_large"],
    ["ERR_RESPONSE_BODY_TOO_LARGE", "response_body_too_large"],
    ["ECONNRESET", "connection_failed"],
    ["CERT_HAS_EXPIRED", "tls_error"],
    ["ETIMEDOUT", "timeout"],
  ]) {
    const error = webTransportFailure(
      new Error("secret", {
        cause: Object.assign(new Error("secret"), { code: cause }),
      }),
      "request",
      65536,
    );
    expect(error.code).toBe(code!);
    expect(error.diagnostics?.failure?.transportCode).toBe(cause!);
    expect(error.message).not.toContain("secret");
  }
  const safe = webReadDiagnostics({
    url: "https://u:secret@example.com/path?token=secret#secret",
    attempts: [
      {
        method: "http",
        status: "fetch_failed",
        failure: {
          stage: "request",
          transportCode: "secret",
          headers: "secret",
          limitBytes: -1,
        },
      },
    ],
  });
  expect(JSON.stringify(safe)).not.toContain("secret");
  expect(safe.url).toBe("https://example.com/path");
});
test("known transport failures do not retry through browser and preserve diagnostics", async () => {
  for (const code of ["ENOTFOUND", "HPE_HEADER_OVERFLOW", "CERT_HAS_EXPIRED"]) {
    let renders = 0;
    const result = await readRAGWebpage({
      url,
      fetchResource: async () => {
        throw webTransportFailure(
          Object.assign(new Error("secret"), { code }),
          "request",
          65536,
        );
      },
      render: async () => {
        renders++;
        throw Error("Must not render");
      },
    });
    expect(renders).toBe(0);
    expect(result.status).toBe("error");
    expect(result.attempts[0]?.failure?.transportCode).toBe(code);
    expect(JSON.stringify(result)).not.toContain("secret");
  }
});
test("failed browser preserves usable HTTP content and identifies the terminal method", async () => {
  const text = "Useful company information retained.";
  const result = await readRAGWebpage({
    url,
    fetchResource: async () => ({
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: new TextEncoder().encode(`<html><body>${text}</body></html>`),
    }),
    render: async () => {
      throw new WebReadError("renderer_timeout", "Timed out", {
        attempts: [],
        failure: { stage: "navigation" },
      });
    },
  });
  expect(result.status).toBe("partial");
  expect(result.text).toContain(text);
  expect(result.method).toBe("browser");
  expect(result.attempts[1]?.failure?.stage).toBe("navigation");
});

test("browser challenge does not overwrite useful static evidence", async () => {
  const text = "Useful company information retained.";
  const result = await readRAGWebpage({
    url,
    fetchResource: async () => ({
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: new TextEncoder().encode(`<html><body>${text}</body></html>`),
    }),
    render: async () => ({
      url,
      status: 403,
      html: "<html><body>Verify you are human</body></html>",
    }),
  });
  expect(result.status).toBe("partial");
  expect(result.text).toContain(text);
  expect(result.error?.code).toBe("access_blocked");
});
