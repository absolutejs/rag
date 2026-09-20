import { test, expect } from "bun:test";
import { readRAGWebpage } from "../src/web";
import { readRAGWebsite } from "../src/web";
test("browser evidence preserves visible hero text rather than treating it as boilerplate", async () => {
  const url = "https://example.com";
  const result = await readRAGWebpage({
    url,
    fetchResource: async () => ({
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: new TextEncoder().encode('<div id="root"></div>'),
    }),
    render: async () => ({
      url,
      status: 200,
      html: "<header><h1>Our company</h1></header>",
      text: "Our company\nPartnership software for property managers.",
    }),
  });
  expect(result.status).toBe("ok");
  expect(result.text).toContain("Our company");
  expect(result.text).toContain("property managers");
});

test("multi-section marketing pages preserve siblings outside article-like class names", async () => {
  const url = "https://example.com/";
  const html = `<html><head><title>Experience Studio</title><script>secret-script-content</script></head><body>
    <header><h1>Intentional gatherings</h1></header>
    <section><h2>ATTUNE</h2><div><p>We learn about your audience.</p></div></section>
    <section><h2>COMPOSE</h2><div class="content"><p>${"We design meaningful experiences. ".repeat(20)}</p></div></section>
    <section><h2>RESONATE</h2><p>We measure lasting impact.</p></section>
    <section><h2>TEAM</h2><div><div><p>Alex leads our event production team.</p></div><p>Sam leads experience design.</p></div></section>
    <section><h2>They trust us</h2><img alt="Example Foundation logo" src="/logo.png"></section>
    <div hidden>hidden-secret</div><div aria-hidden="true">decorative-copy</div></body></html>`;
  const result = await readRAGWebsite({
    url,
    maxPages: 1,
    fetchResource: async () => ({
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: new TextEncoder().encode(html),
    }),
  });
  const text = result.documents[0]!.text;
  for (const expected of [
    "ATTUNE",
    "COMPOSE",
    "RESONATE",
    "Alex leads",
    "Sam leads",
    "Example Foundation logo",
    "not independently verified",
  ])
    expect(text).toContain(expected);
  for (const excluded of [
    "secret-script-content",
    "hidden-secret",
    "decorative-copy",
  ])
    expect(text).not.toContain(excluded);
});
