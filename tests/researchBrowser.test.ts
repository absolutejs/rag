import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { chromium } from "playwright-core";
import { researchPlugin } from "../src/research/plugin";
import type { ResearchResult, ResearchRuntime } from "../src/research/types";
const executablePath = process.env.RESEARCH_TEST_CHROMIUM;
test.skipIf(!executablePath)(
  "HTML binding works in Chromium without executing model markup",
  async () => {
    const built = await Bun.build({
      entrypoints: ["tests/fixtures/researchBrowser.ts"],
      target: "browser",
    });
    expect(built.success).toBe(true);
    const javascript = await built.outputs[0]!.text();
    expect(javascript).not.toContain("BRAVE_SEARCH_API_KEY");
    expect(javascript).not.toContain("generateObjectAI");
    const result: ResearchResult = {
      id: "1",
      status: "partial",
      data: null,
      fields: [],
      sources: [],
      searches: [],
      operations: [],
      limitations: ['<img src=x onerror="window.pwned=true">'],
      generatedAt: "",
    };
    const runtime: ResearchRuntime = {
      run: async () => result,
      extract: async () => result as any,
    };
    const app = new Elysia().use(
      researchPlugin({ runtime, authorize: () => true }),
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/")
          return new Response(
            '<form><input name="query"><button>Research</button></form><pre></pre><script type="module" src="/client.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        if (path === "/client.js")
          return new Response(javascript, {
            headers: { "content-type": "application/javascript" },
          });
        return app.handle(request);
      },
    });
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.port}`);
      await page.waitForFunction(() => "research" in window);
      await page.locator("input").fill("Example");
      await page.locator("button").click();
      await page.waitForFunction(() =>
        document.querySelector("pre")?.textContent?.includes("partial"),
      );
      expect(await page.locator("pre img").count()).toBe(0);
      expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
      expect(await page.locator("pre").getAttribute("aria-busy")).toBe("false");
    } finally {
      await browser.close();
      await server.stop(true);
    }
  },
);
