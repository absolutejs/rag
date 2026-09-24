import { parseHTML } from "linkedom";
import { createHash } from "node:crypto";
import { validatePublicWebUrl } from "../web/transport";
import type { WebIndexDocument, WebIndexPassage } from "./types";
export const indexHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const normalizeIndexUrl = (value: string) => {
  const url = validatePublicWebUrl(value);
  url.hash = "";
  return url.href;
};
const textOf = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/gu, " ").trim();
const isoDate = (value: string | null) =>
  value &&
  /^\d{4}-\d{2}-\d{2}(?:T.*)?$/u.test(value) &&
  Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
/** Headings and section lead remain attached to every bounded passage. No global policy is inferred from a section. */
export const parseWebIndexDocument = (input: {
  url: string;
  finalUrl: string;
  body: string;
  headers: Record<string, string>;
  status: number;
  previous: WebIndexDocument | null;
  maxChunks: number;
}): WebIndexDocument | null => {
  const html =
    /html/iu.test(input.headers["content-type"] ?? "") ||
    /^\s*(?:<!doctype|<html)/iu.test(input.body);
  let title = input.finalUrl,
    canonicalHint: string | undefined,
    publishedAt: string | undefined,
    links: string[] = [];
  const sections: Array<{ heading: string[]; blocks: string[] }> = [
    { heading: [], blocks: [] },
  ];
  if (html) {
    const { document } = parseHTML(input.body);
    const robots = [
      input.headers["x-robots-tag"] ?? "",
      ...Array.from(
        document.querySelectorAll(
          'meta[name="robots"],meta[name="AbsoluteJSReader"],meta[name="absolutejsreader"]',
        ),
      ).map((node) => node.getAttribute("content") ?? ""),
    ].join(",");
    if (/\b(?:noindex|none)\b/iu.test(robots)) return null;
    title = textOf(document.querySelector("title")?.textContent) || title;
    publishedAt = isoDate(
      document
        .querySelector('meta[property="article:published_time"]')
        ?.getAttribute("content") ?? null,
    );
    const hint = document
      .querySelector('link[rel="canonical"]')
      ?.getAttribute("href");
    if (hint)
      try {
        canonicalHint = normalizeIndexUrl(new URL(hint, input.finalUrl).href);
      } catch {
        /* Keep invalid hints out of evidence. */
      }
    if (!/\b(?:nofollow|none)\b/iu.test(robots))
      links = Array.from(document.querySelectorAll("a[href]"))
        .filter(
          (node) =>
            !/(?:^|\s)nofollow(?:\s|$)/iu.test(node.getAttribute("rel") ?? ""),
        )
        .flatMap((node) => {
          try {
            return [
              normalizeIndexUrl(
                new URL(node.getAttribute("href")!, input.finalUrl).href,
              ),
            ];
          } catch {
            return [];
          }
        });
    document
      .querySelectorAll(
        'script,style,template,noscript,svg,nav,footer,[hidden],[aria-hidden="true"]',
      )
      .forEach((node) => node.remove());
    const headings: string[] = [];
    const root =
      document.querySelector("main,article") ??
      document.body ??
      document.documentElement;
    const walk = (node: Node) => {
      if (/^H[1-6]$/u.test(node.nodeName)) {
        const level = Number(node.nodeName[1]);
        headings.length = level - 1;
        headings[level - 1] = textOf(node.textContent);
        sections.push({ heading: headings.filter(Boolean), blocks: [] });
        return;
      }
      if (/^(?:P|LI|DT|DD|BLOCKQUOTE|PRE|TR)$/u.test(node.nodeName)) {
        const text = textOf(node.textContent);
        if (text) sections.at(-1)!.blocks.push(text);
        return;
      }
      if (node.nodeType === 3) {
        const text = textOf(node.textContent);
        if (text) sections.at(-1)!.blocks.push(text);
        return;
      }
      node.childNodes.forEach(walk);
    };
    if (root) walk(root);
  } else {
    if (/\b(?:noindex|none)\b/iu.test(input.headers["x-robots-tag"] ?? ""))
      return null;
    if (
      !/^(?:text\/|application\/(?:json|xml))/iu.test(
        input.headers["content-type"] ?? "text/plain",
      )
    )
      throw new Error("Unsupported index content type");
    sections[0]!.blocks = input.body
      .split(/\n\s*\n/u)
      .map(textOf)
      .filter(Boolean);
  }
  const passages: WebIndexPassage[] = [];
  for (const [sectionIndex, section] of sections.entries()) {
    const parents = new Map<number, string>();
    for (const previous of sections.slice(0, sectionIndex)) {
      const depth = previous.heading.length;
      if (
        depth < section.heading.length &&
        previous.heading.every((name, i) => name === section.heading[i]) &&
        previous.blocks[0]
      )
        parents.set(depth, previous.blocks[0].slice(0, 600));
    }
    const parentContext = [...parents.values()].join("\n");
    const lead = section.blocks[0]?.slice(0, 600) ?? "";
    let buffer = "";
    let emitted = false;
    const flush = () => {
      if (buffer.trim()) {
        const context = [title, ...section.heading].filter(Boolean).join(" > ");
        const prefix = emitted && !buffer.startsWith(lead) ? `${lead}\n` : "";
        const text = `${context}\n${parentContext ? parentContext + "\n" : ""}${prefix}${buffer.trim()}`;
        emitted = true;
        passages.push({
          id: String(passages.length),
          heading: section.heading,
          text,
        });
        buffer = "";
      }
    };
    for (const block of section.blocks) {
      if (buffer.length + block.length > 2400) flush();
      if (block.length > 2400) {
        for (let offset = 0; offset < block.length; offset += 1800) {
          buffer = `${offset || passages.length ? lead + "\n" : ""}${block.slice(offset, offset + 1800)}`;
          flush();
        }
      } else buffer += (buffer ? "\n" : "") + block;
      if (passages.length > input.maxChunks)
        throw new Error("Page exceeds the configured passage budget");
    }
    flush();
  }
  if (!passages.length) throw new Error("Page has no indexable content");
  if (passages.length > input.maxChunks)
    throw new Error("Page exceeds the configured passage budget");
  const contentHash = indexHash(JSON.stringify({ title, passages }));
  const version = indexHash(
    JSON.stringify({ contentHash, publishedAt, finalUrl: input.finalUrl }),
  );
  const fetchedAt = new Date().toISOString();
  return {
    url: input.url,
    finalUrl: input.finalUrl,
    canonicalHint,
    title,
    version,
    contentHash,
    fetchedAt,
    changedAt:
      input.previous?.contentHash === contentHash
        ? input.previous.changedAt
        : fetchedAt,
    publishedAt,
    etag: input.headers.etag,
    lastModified: input.headers["last-modified"],
    passages,
    links: [...new Set(links)],
    status: input.status,
  };
};
