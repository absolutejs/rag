import { readRAGWebpage } from "../../src/web/index";
const html =
  "<html><body><div " +
  ' id="root" '.repeat(50000) +
  ">" +
  "Ordinary readable page content. ".repeat(30) +
  "</div></body></html>";
const result = await readRAGWebpage({
  url: "https://fixture.example/",
  fetchResource: async () => ({
    url: "https://fixture.example/",
    status: 200,
    headers: { "content-type": "text/html" },
    body: new TextEncoder().encode(html),
  }),
});
if (result.status !== "ok") throw new Error(JSON.stringify(result));
