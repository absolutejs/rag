import { t } from "elysia";
import { Type } from "typebox";
import { Type as Legacy } from "@sinclair/typebox";
import type { ResearchRuntime, ResearchConfig } from "../src/research";

declare const runtime: ResearchRuntime;
const schema = t.Object({
  findings: t.Array(t.String()),
  count: t.Optional(t.Number()),
});
const configured: ResearchConfig["tasks"] = { company: { schema } };
void configured;
const result = await runtime.extract({ schema }, { query: "Example" });
const data: { findings: string[]; count?: number } | null = result.data;
void data;
if (result.data) {
  // @ts-expect-error Elysia schema inference must not degrade to any.
  const wrong: number[] = result.data.findings;
  void wrong;
  // @ts-expect-error Unknown fields must not become accessible.
  result.data.missing;
}
const modern = await runtime.extract(
  { schema: Type.Object({ name: Type.String() }) },
  { query: "Example" },
);
const legacy = await runtime.extract(
  { schema: Legacy.Object({ name: Legacy.String() }) },
  { query: "Example" },
);
const names: (string | undefined)[] = [modern.data?.name, legacy.data?.name];
void names;
