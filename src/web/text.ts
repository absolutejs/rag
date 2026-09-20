import { parseHTML } from "linkedom";

/** Website research needs the whole page, not the highest-scoring article fragment. */
export const websiteHtmlText = (html: string): string => {
  const { document } = parseHTML(html);
  document
    .querySelectorAll(
      "script,style,template,noscript,svg,[hidden],[aria-hidden=true]",
    )
    .forEach((element) => element.remove());
  const root = document.body?.textContent?.trim()
    ? document.body
    : document.documentElement;
  const parts: string[] = [];
  const blocks =
    /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DIV|DL|DT|DD|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|SECTION|TABLE|TD|TH|TR|UL)$/u;
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push((node.textContent ?? "").replace(/\s+/gu, " "));
      return;
    }
    const block = blocks.test(node.nodeName);
    if (block) parts.push("\n");
    node.childNodes.forEach(walk);
    if (block) parts.push("\n");
  };
  if (root) walk(root);
  return parts
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
};
