import { defineManifest, toolFactory } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { ResearchConfig, ResearchRuntime } from "./types";
const tool = toolFactory<ResearchRuntime>();
export const researchManifest = defineManifest<
  ResearchConfig,
  ResearchRuntime
>()({
  contract: 2,
  identity: {
    name: "@absolutejs/rag",
    category: "ai",
    accent: "#10b981",
    tagline: "Bounded web research with reviewed evidence.",
    description:
      "Configure search and AI once; research, extract, discover, batch, and monitor with framework bindings and explicit evidence.",
    docsUrl: "https://github.com/absolutejs/rag",
  },
  integration: { mode: "recipe" },
  settings: Type.Object({
    model: Type.String({ minLength: 1 }),
    limits: Type.Optional(
      Type.Object({
        searches: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
        reads: Type.Optional(Type.Integer({ minimum: 0, maximum: 32 })),
        rounds: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600000 })),
      }),
    ),
  }),
  requires: {
    env: [
      {
        key: "BRAVE_SEARCH_API_KEY",
        secret: true,
        description: "Brave key for the default recipe",
      },
      {
        key: "ANTHROPIC_API_KEY",
        secret: true,
        description: "Anthropic key for the default recipe",
      },
    ],
  },
  tools: {
    research_web: tool.runtime({
      description:
        "Research a question or registered extraction task, returning reviewed fields, sources, limitations, and operation records.",
      annotations: { openWorldHint: true },
      authorization: {
        approval: "policy",
        audience: "authenticated",
        effects: ["read", "external-network"],
        destinations: ["configured-research-providers"],
        requiredScopes: ["research:run"],
        reversible: false,
        idempotency: { mode: "host" },
      },
      input: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 8000 }),
        task: Type.Optional(Type.String({ maxLength: 128 })),
      }),
      handler: async (input, runtime) =>
        JSON.stringify(await runtime.run(input)),
    }),
  },
  wiring: [
    {
      id: "brave-anthropic",
      title: "Create the research runtime",
      server: {
        placement: "module-scope",
        imports: [
          { from: "@absolutejs/rag/research", names: ["createResearch"] },
          { from: "@absolutejs/search/brave", names: ["createBraveSearch"] },
          { from: "@absolutejs/ai/anthropic", names: ["anthropic"] },
        ],
        code: "const research = createResearch({ ...${settings}, search: createBraveSearch({ apiKey: ${env.BRAVE_SEARCH_API_KEY} }), provider: anthropic({ apiKey: ${env.ANTHROPIC_API_KEY} }) });",
      },
    },
  ],
});
