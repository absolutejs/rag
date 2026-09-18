import { chromium, type Browser } from "playwright-core";
import {
  fetchPublicWebResource,
  validatePublicWebUrl,
  WebReadError,
} from "./transport";
import type { WebRenderer } from "./index";
/** Fresh contexts share a browser, never cookies; all HTTP traffic uses pinned public DNS. */
export const createPlaywrightWebRenderer = (
  options: { executablePath?: string } = {},
) => {
  let browser: Browser | undefined;
  let launching: Promise<Browser> | undefined;
  const launch = async () => {
    if (browser?.isConnected()) return browser;
    launching ??= chromium.launch({
      headless: true,
      executablePath: options.executablePath,
      args: ["--disable-dev-shm-usage"],
    });
    try {
      browser = await launching;
      return browser;
    } finally {
      launching = undefined;
    }
  };
  const renderOnce: WebRenderer = async (url, { signal }) => {
    validatePublicWebUrl(url);
    signal.throwIfAborted();
    const instance = await launch();
    const context = await instance.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const abort = () => {
      void context.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    let count = 0,
      bytes = 0;
    try {
      await context.routeWebSocket("**/*", (socket) => socket.close());
      await context.route("**/*", async (route) => {
        const request = route.request();
        try {
          if (
            ++count > 80 ||
            bytes > 20_000_000 ||
            ["image", "media", "font"].includes(request.resourceType())
          )
            return await route.abort();
          const body = request.postData() ?? undefined;
          if (body && body.length > 100_000) return await route.abort();
          const original = request.headers();
          const headers: Record<string, string> = {};
          for (const key of ["accept", "content-type", "origin", "user-agent"])
            if (original[key]) headers[key] = original[key];
          const response = await fetchPublicWebResource(request.url(), {
            signal,
            maxBytes: 5_000_000,
            method: request.method(),
            body,
            headers,
            redirect: "manual",
          });
          bytes += response.body.byteLength;
          await route.fulfill({
            status: response.status,
            headers: response.headers,
            body: Buffer.from(response.body),
          });
        } catch {
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 25000,
      });
      await page
        .waitForFunction(
          () => {
            const root = document.querySelector(
              "#root,#app,#__next,app-root,[ng-version]",
            );
            const rootText = root?.textContent?.trim() ?? "";
            return (
              document.body.innerText.trim().length > 100 &&
              (!root ||
                (rootText.length > 20 &&
                  !/^(loading|please wait)/i.test(rootText)))
            );
          },
          undefined,
          { timeout: 8000 },
        )
        .catch(() => {});
      // Allow hydration and async content to settle after the first readable frame.
      await page.waitForTimeout(1200);
      signal.throwIfAborted();
      const html = await page.content();
      if (html.length > 5_000_000)
        throw new WebReadError(
          "too_large",
          "Rendered page exceeded the content limit.",
        );
      return {
        html,
        text: await page.locator("body").innerText(),
        url: page.url(),
        status: response?.status() ?? 200,
      };
    } finally {
      signal.removeEventListener("abort", abort);
      await context.close().catch(() => {});
    }
  };
  const render: WebRenderer = async (url, options) => {
    try {
      return await renderOnce(url, options);
    } catch (error) {
      if (options.signal.aborted || browser?.isConnected()) throw error;
      // A crashed worker may be replaced once; the same total deadline still applies.
      return renderOnce(url, options);
    }
  };
  return {
    render,
    ready: async () => {
      await launch();
    },
    close: async () => {
      await browser?.close();
      browser = undefined;
    },
  };
};
