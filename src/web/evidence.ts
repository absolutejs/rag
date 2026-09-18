import { parseHTML } from "linkedom";
import { validatePublicWebUrl } from "./transport";
export type WebLink = { url: string; label: string };
export type WebImage = { url: string | null; label: string; context: string };
export type WebMedia = {
  kind: "video" | "audio" | "embed" | "captions";
  url: string;
  label: string;
};
export type WebEvidence = {
  links: WebLink[];
  images: WebImage[];
  media: WebMedia[];
  canonicalUrl: string | null;
};
const compact = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/gu, " ").trim().slice(0, 600);
const publicHref = (value: string | null, base: string) => {
  if (!value) return null;
  try {
    return validatePublicWebUrl(new URL(value, base).href).href;
  } catch {
    return null;
  }
};
/** Preserve semantic evidence that visible body text omits. Labels are not verified customer relationships. */
export const extractWebEvidence = (html: string, url: string): WebEvidence => {
  const { document } = parseHTML(html);
  const label = (element: Element) =>
    compact(element.getAttribute("aria-label")) ||
    compact(element.getAttribute("title")) ||
    compact(element.textContent) ||
    compact(element.querySelector("img")?.getAttribute("alt"));
  const links: WebLink[] = [];
  const seen = new Set<string>();
  for (const element of document.querySelectorAll("a[href]")) {
    const href = publicHref(element.getAttribute("href"), url);
    if (!href || seen.has(href) || links.length >= 100) continue;
    seen.add(href);
    links.push({ url: href, label: label(element) });
  }
  const images: WebImage[] = [];
  const seenImages = new Set<string>();
  for (const element of document.querySelectorAll("img,svg,[role=img]")) {
    if (images.length >= 80) break;
    const imageLabel = compact(
      element.getAttribute("alt") ||
        (element.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/u)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim() ||
        element.getAttribute("aria-label") ||
        element.querySelector("title")?.textContent ||
        element.getAttribute("title"),
    );
    const section = element.closest("section,figure,article");
    const imageUrl = publicHref(
      element.getAttribute("src") || element.getAttribute("data-src"),
      url,
    );
    const context = compact(
      section?.querySelector("h1,h2,h3,figcaption")?.textContent,
    );
    const key = `${imageUrl ?? ""}:${imageLabel}:${context}`;
    if ((!imageUrl && !imageLabel) || seenImages.has(key)) continue;
    seenImages.add(key);
    images.push({ url: imageUrl, label: imageLabel, context });
  }

  const media: WebMedia[] = [];
  for (const element of document.querySelectorAll(
    "video,audio,video source,audio source,iframe,track",
  )) {
    if (media.length >= 30) break;
    const href = publicHref(element.getAttribute("src"), url);
    if (!href) continue;
    const tag = element.tagName.toLowerCase();
    media.push({
      kind:
        tag === "track"
          ? "captions"
          : tag === "iframe"
            ? "embed"
            : tag === "audio" || element.closest("audio")
              ? "audio"
              : "video",
      url: href,
      label: compact(element.getAttribute("label")) || label(element),
    });
  }
  return {
    links,
    images,
    media,
    canonicalUrl: publicHref(
      document.querySelector('link[rel="canonical"]')?.getAttribute("href") ??
        null,
      url,
    ),
  };
};
/** Navigation/footer text alone must not mask an empty or loading app root. */
export const hasIncompleteAppContent = (html: string) => {
  const { document } = parseHTML(html);
  if (!document.querySelector("script[src],script[type=module]")) return false;
  const main = document.querySelector(
    "main,[role=main],#root,#app,#__next,app-root",
  );
  if (!main) return false;
  main
    .querySelectorAll("script,style,nav,header,footer")
    .forEach((element) => element.remove());
  const text = compact(main.textContent);
  return (
    text.length < 100 || /^(?:loading|please wait)(?:[.\s]|$)/iu.test(text)
  );
};
