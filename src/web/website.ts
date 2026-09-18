import {
  readRAGWebpage,
  type ReadWebpageOptions,
  type WebReadResult,
} from "./index";
import { fetchPublicWebResource } from "./transport";
const pagePriority = (url: string, label: string) => {
  const path = new URL(url).pathname;
  if (/\/(?:news|thought-leadership|careers|contact)(?:\/|$)/iu.test(path))
    return 0;
  if (/client|customer|case.?stud|success/iu.test(path)) return 3;
  if (/service|capabilit|solution|what.we.do/iu.test(path)) return 2;
  if (/about|who.we.are|company/iu.test(path)) return 1;
  if (
    /^(?:our )?(?:clients|customers|client successes|case studies)\b/iu.test(
      label,
    )
  )
    return 3;
  if (
    /^(?:our )?(?:services|capabilities|solutions|what we do)\b/iu.test(label)
  )
    return 2;
  if (/^(?:about|who we are|company info)\b/iu.test(label)) return 1;
  return 0;
};
/** Bounded company research: preserve citations and follow relevant same-origin links. */
export const readRAGWebsite = async (
  options: ReadWebpageOptions & { maxPages?: number },
) => {
  const signal = options.signal ?? AbortSignal.timeout(75000);
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 4, 5));
  const maxChars = Math.max(1000, Math.min(options.maxChars ?? 24000, 100000));
  const pages: WebReadResult[] = [];
  const queue: { url: string; label: string }[] = [
    { url: options.url, label: "Requested page" },
  ];
  const visited = new Set<string>();
  const coveredTopics = new Set<number>();
  let origin: string | undefined;
  while (queue.length && pages.length < maxPages && !signal.aborted) {
    const next = queue.shift()!;
    let key: URL;
    try {
      key = new URL(next.url);
    } catch {
      pages.push(await readRAGWebpage({ ...options, signal }));
      break;
    }
    key.hash = "";
    if (visited.has(key.href)) continue;
    visited.add(key.href);
    coveredTopics.add(pagePriority(next.url, next.label));
    const page = await readRAGWebpage({
      ...options,
      url: next.url,
      maxChars: Math.min(maxChars, 12000),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    pages.push(page);
    visited.add(page.finalUrl.split("#")[0]!);
    origin ??= new URL(page.finalUrl).origin;
    if (page.status === "error") continue;
    const links = page.evidence.links.filter(
      (link) =>
        new URL(link.url).origin === origin &&
        pagePriority(link.url, link.label) > 0 &&
        !visited.has(link.url.split("#")[0]!),
    );
    queue.push(...links);
    queue.sort(
      (a, b) =>
        pagePriority(b.url, b.label) +
        (coveredTopics.has(pagePriority(b.url, b.label)) ? 0 : 10) -
        (pagePriority(a.url, a.label) +
          (coveredTopics.has(pagePriority(a.url, a.label)) ? 0 : 10)),
    );
  }
  const first = pages[0] ?? (await readRAGWebpage({ ...options, signal }));
  const captionEvidence: { url: string; text: string; error?: string }[] = [];
  const tracks = [
    ...new Set(
      pages.flatMap((page) =>
        page.evidence.media
          .filter((media) => media.kind === "captions")
          .map((media) => media.url),
      ),
    ),
  ].slice(0, 2);
  for (const url of tracks) {
    if (signal.aborted) break;
    try {
      const response = await (options.fetchResource ?? fetchPublicWebResource)(
        url,
        {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          maxBytes: 250000,
        },
      );
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const text = new TextDecoder()
        .decode(response.body)
        .replace(/^WEBVTT.*$/gmu, "")
        .replace(/^.*-->.*$/gmu, "")
        .replace(/^\d+$/gmu, "")
        .replace(/<[^>]*>/gu, "")
        .trim()
        .slice(0, 6000);
      captionEvidence.push({ url: response.url, text });
    } catch (error) {
      captionEvidence.push({
        url,
        text: "",
        error:
          error instanceof Error ? error.message : "Caption retrieval failed",
      });
    }
  }
  const evidenceText = pages
    .filter((page) => page.status !== "error")
    .map(
      (page) =>
        `SOURCE: ${page.finalUrl}\nTITLE: ${page.title ?? "Untitled"}\n${page.text}`,
    )
    .join("\n\n");
  const readable = pages.filter((page) => page.status !== "error" && page.text);
  const incomplete =
    pages.some((page) => page.status !== "ok") || signal.aborted;
  const unvisited = queue.filter(
    (link) => !visited.has(link.url.split("#")[0]!),
  );
  return {
    ...first,
    status: (readable.length
      ? incomplete
        ? "partial"
        : "ok"
      : "error") as WebReadResult["status"],
    text: evidenceText.slice(0, maxChars),
    truncated:
      evidenceText.length > maxChars || pages.some((page) => page.truncated),
    pages: pages.map(({ text: _text, ...page }) => page),
    captionEvidence,
    coverage: {
      pagesRead: pages.length,
      pageLimit: maxPages,
      remainingRelevantLinks: [
        ...new Set(unvisited.map((link) => link.url)),
      ].slice(0, 20),
      deadlineReached: signal.aborted,
      exhaustive: false,
    },
    citationGuidance:
      "Cite the exact source page URL for each factual claim. Distinguish page text, image labels, caption text and inference. A successful fetch is not proof that every requested topic was answered. Follow remaining relevant links if the question is still unanswered; do not ask permission merely to finish already-requested research. Describe an empty HTTP extraction followed by browser success as successful fallback, not silent failure. Only identify HTTP redirect status codes actually present in redirects. Media URLs alone are not watched video evidence.",
  };
};
