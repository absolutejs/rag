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
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 8, 12));
  const maxChars = Math.max(1000, Math.min(options.maxChars ?? 48000, 100000));
  const pages: WebReadResult[] = [];
  const queue: { url: string; label: string }[] = [
    { url: options.url, label: "Requested page" },
  ];
  const visited = new Set<string>();
  const topicVisits = new Map<number, number>();
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
    const topic = pagePriority(next.url, next.label);
    topicVisits.set(topic, (topicVisits.get(topic) ?? 0) + 1);
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
    // Balance repeated visits too: a large case-study archive must not consume
    // the budget before service detail pages have been read.
    queue.sort((a, b) => {
      const aTopic = pagePriority(a.url, a.label);
      const bTopic = pagePriority(b.url, b.label);
      return (
        (topicVisits.get(aTopic) ?? 0) - (topicVisits.get(bTopic) ?? 0) ||
        bTopic - aTopic
      );
    });
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
  const sources = pages
    .filter((page) => page.status !== "error" && page.text)
    .map((page) => {
      const title = (page.title || new URL(page.finalUrl).hostname)
        .replace(/\s+/gu, " ")
        .trim();
      const label = title.replace(/[\\[\]]/gu, "\\$&");
      const href = page.finalUrl.replace(/[<>]/gu, encodeURIComponent);
      return { title, url: page.finalUrl, citation: `[${label}](<${href}>)` };
    });
  const evidenceText = pages
    .filter((page) => page.status !== "error")
    .map(
      (page) =>
        `SOURCE: ${page.finalUrl}\nCITATION: ${sources.find((source) => source.url === page.finalUrl)?.citation ?? page.finalUrl}\nTITLE: ${page.title ?? "Untitled"}\n${page.text}`,
    )
    .join("\n\n");
  const readable = pages.filter((page) => page.status !== "error" && page.text);
  const incomplete =
    pages.some((page) => page.status !== "ok") || signal.aborted;
  const unvisited = queue.filter(
    (link) => !visited.has(link.url.split("#")[0]!),
  );
  return {
    sources,
    citationRequirements:
      "The final answer must contain clickable Markdown source links, not just source names or bare domain mentions. Reuse sources[].citation beside the factual paragraph, list or table row it supports. Cite the actual supporting page, not the homepage for everything. Every factual section needs its supporting links. Do not invent sources or use unread links as evidence. Before responding, check that company facts, service descriptions, customer examples and numerical claims have supporting links; retrieve or omit unsupported claims. A list of large customers does not prove smaller customers are excluded. Preserve the brands actually named in the evidence; do not append parent companies, ownership relationships, current-account status, market rankings or rebrand history from memory. Label reasoned inferences as such. A verified brand change needs at most one short, cited sentence unless the user asks for its history.",
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
      stopReason: signal.aborted
        ? "deadline"
        : unvisited.length
          ? "page_limit"
          : "links_exhausted",
      incompleteReads: pages
        .filter((page) => page.status !== "ok" || page.truncated)
        .map((page) => ({
          url: page.finalUrl,
          status: page.status,
          truncated: page.truncated,
          error: page.error,
        })),
    },
    citationGuidance:
      "Answer the user's question first, with exact source page URLs. Distinguish retrieved facts from inference. A page limit bounds this call, not the research task: if a material question remains unanswered, read the relevant remaining links in another call, using maxPages 1 for targeted detail pages. Do not stop with a list of next steps when those reads are needed to finish the request. Conversely, unvisited links do not by themselves mean the answer is incomplete. Report only gaps that materially limit the answer, unless a retrieval audit was explicitly requested. Successful browser fallback is a completed read, not an incomplete read. Normally summarize a redirected destination in one brief sentence; omit HTTP codes, hop chains, character counts and rendering mechanics unless explicitly requested for debugging. A redirect alone does not prove a rebrand; verify that claim from a source. Image labels do not establish customer relationships and media URLs are not watched video evidence.",
  };
};
