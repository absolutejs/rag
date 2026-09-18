import { test, expect } from "bun:test";
import { readRAGWebpage } from "../src/web";
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
