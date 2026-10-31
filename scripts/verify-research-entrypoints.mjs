import assert from "node:assert/strict";
import { createResearch } from "../dist/research/index.js";
import { createWebpageReaderClient, isWebReadError, WebReadError } from "../dist/web/index.js";

const url = "https://example.com/news";
const run = async (code, settlementFailure = false) => {
  const outputs = [
    { queries: [], urls: [url], done: true },
    { name: "Example" },
    { fields: [{ path: "/name", verdict: "supported", citations: [{ passageId: "s1:0" }], reason: "Explicit source", checks: { answersQuestion: true, correctEntity: true, correctTime: true, preservesScope: true } }] },
  ];
  const runtime = createResearch({
    model: "fixture",
    search: { name: "fixture", version: "1", search: async (input) => ({ provider: "fixture", version: "1", query: input.query, status: "ok", sources: [{ id: "external", url, title: "Example", excerpts: ["Example announced its launch in 2026."], retrievedAt: "2026-10-31" }], attempts: [], limitations: [] }) },
    provider: { name: "fixture", async *stream(input) { const output = outputs.shift(); assert.ok(output, "unexpected model call"); yield { type: "tool_use", id: "1", name: input.tools[0].name, input: output }; yield { type: "done" }; } },
    reader: createWebpageReaderClient({ endpoint: "https://reader.example/read", fetch: async () => Response.json({ status: "error", text: "", error: { code, message: "Private provider detail" } }) }),
    admit: async (request) => ({ settle: async () => { if (settlementFailure && request.kind === "read") throw new WebReadError("access_blocked", "Accounting settlement failed"); } }),
  });
  return runtime.extract({ schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }, { query: "Example launch" });
};
for (const code of ["access_blocked", "authentication_required", "http_error", "reader_unavailable", "fetch_failed", "timeout"]) {
  const result = await run(code);
  assert.equal(result.fields[0]?.verdict, "supported", `${code}: usable search evidence must survive`);
  assert.equal(result.sourceFailures?.[0]?.code, code);
  assert.ok(!result.limitations.join(" ").includes("Private provider detail"));
}
for (const code of ["unsafe_url", "blocked_address", "blocked_url", "invalid_url", "accounting_failure"]) {
  const result = await run(code);
  assert.equal(result.fields.length, 0, `${code}: must remain a hard stop`);
  assert.equal(result.sourceFailures, undefined);
}
const settlement = await run("access_blocked", true);
assert.equal(settlement.fields.length, 0, "settlement failure must not be downgraded to source unavailability");
assert.equal(settlement.sourceFailures, undefined);
assert.equal(isWebReadError(Object.assign(new Error("Not a reader error"), { name: "WebReadError", code: "access_blocked" })), false);
console.log("Built research/web entrypoint recovery passed (recoverable sources, unsafe destinations, settlement failures, and error identity).");
