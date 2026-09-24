import { createResearch } from "../../src/research/runtime";
import { anthropic } from "@absolutejs/ai/anthropic";
import { t } from "elysia";
import { appendFile } from "node:fs/promises";
const args = Object.fromEntries(
  process.argv
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => arg.slice(2).split("=")),
);
if (
  !args.input ||
  !args.output ||
  (await Bun.file(args.output).exists()) ||
  (await Bun.file(`${args.output}.jsonl`).exists()) ||
  !process.env.ANTHROPIC_API_KEY
)
  throw new Error(
    "Provide --input=CORPUS_REPORT --output=NEW_PATH and Anthropic configuration",
  );
const prior = await Bun.file(args.input).json();
if (!Array.isArray(prior.results) || prior.results.length > 8)
  throw new Error("Replay accepts at most eight frozen cases");
const calls: unknown[] = [];
let count = 0;
const base = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const provider = {
  ...base,
  async *stream(input: Parameters<typeof base.stream>[0]) {
    if (++count > 16) throw new Error("Model cap reached");
    let usage: unknown = null;
    try {
      for await (const chunk of base.stream(input)) {
        if (chunk.type === "done") usage = chunk.usage ?? null;
        yield chunk;
      }
    } finally {
      const call = { model: input.model, usage };
      calls.push(call);
      await appendFile(
        `${args.output}.jsonl`,
        JSON.stringify({ kind: "model", ...call }) + "\n",
      );
    }
  },
};
const results = [];
for (const row of prior.results) {
  const task = prior.tasks.find((task: { id: string }) => task.id === row.task);
  const runtime = createResearch({
    provider,
    model: "claude-haiku-4-5-20251001",
    reviewer: { provider, model: "claude-sonnet-4-6" },
    limits: {
      rounds: 0,
      reads: 0,
      searches: 1,
      outputTokens: 2500,
      timeoutMs: 90000,
    },
    search: {
      name: "frozen",
      version: "1",
      search: async (request) => ({
        provider: "frozen",
        version: "1",
        query: request.query,
        status: row.result.sources.length ? "ok" : "empty",
        sources: structuredClone(row.result.sources),
        attempts: [],
        limitations: [],
      }),
    },
  });
  const started = performance.now();
  const result = await runtime.extract(
    {
      schema: t.Object({ findings: t.Array(t.String(), { maxItems: 4 }) }),
      instructions: task.instructions,
    },
    { query: task.query },
  );
  const record = {
    arm: row.arm,
    task: row.task,
    durationMs: performance.now() - started,
    result,
  };
  results.push(record);
  await appendFile(
    `${args.output}.jsonl`,
    JSON.stringify({ kind: "research", ...record }) + "\n",
  );
}
await Bun.write(
  args.output,
  JSON.stringify(
    {
      protocol: "frozen-replay-2026-09-24-v1",
      input: args.input,
      results,
      calls,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ output: args.output, models: count }));
