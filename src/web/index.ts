import {
  extractWebEvidence,
  hasIncompleteAppContent,
  type WebEvidence,
} from "./evidence";
import type { WebRedirect } from "./transport";
import { websiteHtmlText } from "./text";
export type { WebEvidence, WebLink, WebImage, WebMedia } from "./evidence";
export type { WebRedirect } from "./transport";
import {
  loadRAGDocumentUpload,
  prepareRAGDocument,
} from "../ingestion/ingestion";
import {
  fetchPublicWebResource,
  validatePublicWebUrl,
  WebReadError,
  type WebFetchResult,
} from "./transport";
export {
  fetchPublicWebResource,
  validatePublicWebUrl,
  isPublicWebAddress,
  WebReadError,
} from "./transport";
export type { WebFetchResult, WebFetchOptions } from "./transport";
export type WebReadAttempt = {
  method: "http" | "browser";
  status: string;
  httpStatus?: number;
  extractedChars?: number;
};
export type WebReadResult = {
  status: "ok" | "partial" | "error";
  url: string;
  finalUrl: string;
  title: string | null;
  text: string;
  method: "http" | "browser";
  truncated: boolean;
  attempts: WebReadAttempt[];
  error?: { code: string; message: string };
  fetchedAt: string;
  redirects: WebRedirect[];
  evidence: WebEvidence;
  limitations: string[];
};
export type WebRenderer = (
  url: string,
  options: { signal: AbortSignal },
) => Promise<{
  html: string;
  text?: string;
  url: string;
  status: number;
  redirects?: WebRedirect[];
  settled?: boolean;
}>;
export type ReadWebpageOptions = {
  url: string;
  render?: WebRenderer;
  signal?: AbortSignal;
  maxChars?: number;
  mode?: "auto" | "browser";
  fetchResource?: typeof fetchPublicWebResource;
};
const messageFor = (error: unknown) =>
  error instanceof Error ? error.message : "Website retrieval failed.";
const codeFor = (error: unknown) =>
  error instanceof WebReadError
    ? error.code
    : error instanceof Error &&
        /^(?:AbortError|TimeoutError)$/u.test(error.name)
      ? "timeout"
      : "fetch_failed";
const cleanHtml = websiteHtmlText;
const titleOf = (html: string) => {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1];
  return title
    ? prepareRAGDocument({ text: title, format: "html" }).normalizedText
    : null;
};
const isShell = (html: string, text: string) =>
  text.length < 300 ||
  hasIncompleteAppContent(html) ||
  /(?:enable|requires?|turn on)\s+javascript|javascript\s+(?:is\s+)?(?:disabled|required)/iu.test(
    text,
  ) ||
  /<(?:div|main|section)[^>]*(?:id=["'](?:root|app|__next)["']|class=["']todoapp["'])[^>]*>\s*<\//iu.test(
    html,
  );
const isChallenge = (text: string) =>
  /verify (?:that )?you are human|checking your browser|just a moment|enable javascript and cookies to continue|access denied/iu.test(
    text.slice(0, 1000),
  );
/** Read prepared evidence, escalating thin HTML shells to a host-supplied browser. */
export const readRAGWebpage = async (
  options: ReadWebpageOptions,
): Promise<WebReadResult> => {
  const attempts: WebReadAttempt[] = [];
  const redirects: WebRedirect[] = [];
  const limitations = [
    "A page read is not exhaustive company research. Image labels are evidence supplied by the site, not independently verified customer relationships. Videos are not watched or transcribed unless caption text is returned.",
  ];
  let evidence: WebEvidence = {
    links: [],
    images: [],
    media: [],
    canonicalUrl: null,
  };
  const signal = options.signal ?? AbortSignal.timeout(45000);
  const maxChars = Math.max(1000, Math.min(options.maxChars ?? 24000, 100000));
  let finalUrl = options.url,
    text = "",
    title: string | null = null,
    method: "http" | "browser" = "http";
  const result = (
    status: WebReadResult["status"],
    error?: WebReadResult["error"],
  ): WebReadResult => ({
    status,
    url: options.url,
    finalUrl,
    title,
    text: text.slice(0, maxChars),
    method,
    truncated: text.length > maxChars,
    attempts,
    redirects,
    evidence,
    limitations,
    fetchedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  });
  try {
    validatePublicWebUrl(options.url);
    let response: WebFetchResult | undefined;
    try {
      response = await (options.fetchResource ?? fetchPublicWebResource)(
        options.url,
        { signal, maxBytes: 5_000_000 },
      );
    } catch (error) {
      attempts.push({ method: "http", status: codeFor(error) });
      if (error instanceof WebReadError && error.code === "blocked_url")
        throw error;
      if (!options.render) throw error;
    }
    let needsBrowser = options.mode === "browser" || !response;
    if (response) {
      finalUrl = response.url;
      redirects.push(...(response.redirects ?? []));
      const mime = response.headers["content-type"] ?? "";
      const raw = new TextDecoder().decode(response.body);
      const html =
        /html/iu.test(mime) || /^\s*(?:<!doctype html|<html)/iu.test(raw);
      if (response.status >= 200 && response.status < 300) {
        if (html) {
          evidence = extractWebEvidence(raw, finalUrl);
          text = cleanHtml(raw);
          title = titleOf(raw);
          needsBrowser ||= isShell(raw, text) || isChallenge(text);
        } else {
          const doc = await loadRAGDocumentUpload({
            content: Buffer.from(response.body).toString("base64"),
            encoding: "base64",
            contentType: mime,
            name: new URL(finalUrl).pathname,
            source: finalUrl,
          });
          text = prepareRAGDocument(doc).normalizedText;
          title = doc.title ?? null;
        }
        attempts.push({
          method: "http",
          status: text ? "extracted" : "empty",
          httpStatus: response.status,
          extractedChars: text.length,
        });
      } else {
        attempts.push({
          method: "http",
          status: "http_error",
          httpStatus: response.status,
        });
        if (![401, 403, 429, 503].includes(response.status))
          return result("error", {
            code: "http_error",
            message: `Website returned HTTP ${response.status}.`,
          });
        needsBrowser = true;
      }
    }
    if (needsBrowser) {
      if (!options.render)
        return result(text ? "partial" : "error", {
          code: "rendering_required",
          message:
            "Static HTML was incomplete. Browser rendering is required; this is not evidence that the site has no information.",
        });
      try {
        const rendered = await options.render(finalUrl, { signal });
        method = "browser";
        finalUrl = rendered.url;
        validatePublicWebUrl(finalUrl);
        redirects.push(...(rendered.redirects ?? []));
        evidence = extractWebEvidence(rendered.html, finalUrl);
        if (rendered.settled === false)
          limitations.push(
            "Browser content did not reach the readability threshold before the wait limit.",
          );
        text = rendered.text?.trim() ?? cleanHtml(rendered.html);
        title = titleOf(rendered.html) ?? title;
        attempts.push({
          method: "browser",
          status: text ? "extracted" : "empty",
          httpStatus: rendered.status,
          extractedChars: text.length,
        });
        if (rendered.status === 401)
          return result("error", {
            code: "authentication_required",
            message: "This page requires sign-in.",
          });
        if ([403, 429].includes(rendered.status) || isChallenge(text))
          return result("error", {
            code: "access_blocked",
            message:
              "The website blocked automated access or presented a verification challenge.",
          });
        if (rendered.status >= 400)
          return result("error", {
            code: "http_error",
            message: `Website returned HTTP ${rendered.status}.`,
          });
        if (
          !text ||
          /^(?:loading[.\s]*|please wait[.\s]*)$/iu.test(text) ||
          /(?:enable|requires?)\s+javascript/iu.test(text)
        )
          return result("error", {
            code: "rendering_incomplete",
            message:
              "The page still provided no usable text after browser rendering.",
          });
        if (rendered.settled === false)
          return result("partial", {
            code: "rendering_incomplete",
            message:
              "Some content was extracted, but the application did not reach the readability threshold. Do not treat it as complete.",
          });
      } catch (error) {
        attempts.push({ method: "browser", status: codeFor(error) });
        return result(text ? "partial" : "error", {
          code: codeFor(error),
          message: messageFor(error),
        });
      }
    }
    return text
      ? result("ok")
      : result("error", {
          code: "no_readable_content",
          message: "The page returned no readable text.",
        });
  } catch (error) {
    return result("error", {
      code: codeFor(error),
      message: messageFor(error),
    });
  }
};

export { readRAGWebsite } from "./website";

export {
  createWebsiteReaderClient,
  parseWebsiteServiceResult,
  type WebsiteServiceResult,
} from "./remote";
