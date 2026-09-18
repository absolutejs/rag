import { expect, test } from "bun:test";
import { extractWebEvidence } from "../src/web/evidence";
import { readRAGWebsite, readRAGWebpage } from "../src/web";
const body =
  "Our services help advertisers measure campaign results and plan media investments. ".repeat(
    8,
  );
const response = (url: string, html: string, status = 200) => ({
  url,
  status,
  headers: { "content-type": "text/html" },
  body: new TextEncoder().encode(html),
});
test("semantic evidence preserves image/SVG labels, linked logos and caption URLs without downloading images", () => {
  const result = extractWebEvidence(
    `<section><h2>Clients</h2><a href='/clients/acme'> <img src='/acme.png' alt='Acme'></a><svg role='img'><title>Bravo</title></svg></section><video src='/film.mp4'><track kind='captions' src='/film.vtt' label='English'></video><a href='javascript:alert(1)'>bad</a><a href='http://127.0.0.1/admin'>private</a>`,
    "https://example.com/",
  );
  expect(result.images).toContainEqual({
    url: "https://example.com/acme.png",
    label: "Acme",
    context: "Clients",
  });
  expect(result.images.some((image) => image.label === "Bravo")).toBe(true);
  expect(result.links).toEqual([
    { url: "https://example.com/clients/acme", label: "Acme" },
  ]);
  expect(
    result.media.some(
      (media) => media.kind === "captions" && media.url.endsWith("film.vtt"),
    ),
  ).toBe(true);
});
test("website research follows customer/service links, cites each page, reads captions and reports bounded coverage", async () => {
  const visited: string[] = [];
  const result = await readRAGWebsite({
    url: "https://example.com/",
    maxPages: 3,
    fetchResource: async (url) => {
      visited.push(url);
      if (url.endsWith(".vtt"))
        return {
          ...response(
            url,
            "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nWe serve Acme.",
          ),
          headers: { "content-type": "text/vtt" },
        };
      return response(
        url,
        `<main>${body}${url.endsWith("/clients") ? "Acme case study" : ""}</main><a href='/clients'>Clients</a><a href='/services'>Services</a><a href='/about'>About</a><a href='https://other.example/clients'>Offsite</a><video><track src='/film.vtt'></video>`,
      );
    },
  });
  expect(visited.slice(0, 3)).toEqual([
    "https://example.com/",
    "https://example.com/clients",
    "https://example.com/services",
  ]);
  expect(result.text).toContain("SOURCE: https://example.com/clients");
  expect(result.text).toContain("Acme case study");
  expect(result.captionEvidence[0]?.text).toBe("We serve Acme.");
  expect(result.coverage.remainingRelevantLinks).toContain(
    "https://example.com/about",
  );
  expect(result.coverage.exhaustive).toBe(false);
  expect(visited).not.toContain("https://other.example/clients");
});
test("large navigation does not hide an empty JavaScript app and redirect types remain factual", async () => {
  const result = await readRAGWebpage({
    url: "https://example.com/",
    fetchResource: async (url) => ({
      ...response(
        url,
        `<nav>${body}</nav><main>Loading...</main><script src='/app.js'></script>`,
      ),
      redirects: [
        { from: "https://old.example/", to: url, kind: "http", status: 302 },
      ],
    }),
    render: async () => ({
      html: `<main>${body}</main>`,
      text: body,
      url: "https://example.com/company",
      status: 200,
      redirects: [
        {
          from: "https://example.com/",
          to: "https://example.com/company",
          kind: "client",
        },
      ],
    }),
  });
  expect(result.method).toBe("browser");
  expect(result.redirects.map((hop) => hop.kind)).toEqual(["http", "client"]);
  expect(result.redirects[1]?.status).toBeUndefined();
});
test("a blocked required follow-up stays partial rather than appearing complete", async () => {
  const result = await readRAGWebsite({
    url: "https://example.com/",
    fetchResource: async (url) =>
      response(
        url,
        `<main>${body}</main><a href='/clients'>Clients</a>`,
        url.endsWith("/clients") ? 404 : 200,
      ),
  });
  expect(result.status).toBe("partial");
  expect(result.pages[1]?.error?.code).toBe("http_error");
  expect(result.text).not.toContain("SOURCE: https://example.com/clients");
});
