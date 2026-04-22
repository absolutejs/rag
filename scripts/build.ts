import { $ } from "bun";
import { rm } from "node:fs/promises";

const DIST = "dist";

await rm(DIST, { force: true, recursive: true });

const serverBuild = await Bun.build({
  entrypoints: [
    "src/ai/rag/index.ts",
    "src/ai/rag/ui.ts",
    "src/ai/rag/quality.ts",
    "src/ai/client/index.ts",
    "src/ai/client/ui.ts",
  ],
  external: ["elysia", "@absolutejs/ai", "@absolutejs/ai/client"],
  outdir: DIST,
  root: "src",
  sourcemap: "linked",
  target: "bun",
});

if (!serverBuild.success) {
  for (const log of serverBuild.logs) console.error(log);
  process.exit(1);
}

const browserBuild = await Bun.build({
  entrypoints: [
    "src/react/ai/index.ts",
    "src/vue/ai/index.ts",
    "src/svelte/ai/index.ts",
    "src/angular/ai/index.ts",
  ],
  external: [
    "react",
    "vue",
    "svelte",
    "@angular/core",
    "@absolutejs/ai",
    "@absolutejs/ai/client",
  ],
  outdir: DIST,
  root: "src",
  sourcemap: "linked",
  target: "browser",
});

if (!browserBuild.success) {
  for (const log of browserBuild.logs) console.error(log);
  process.exit(1);
}

await $`tsc --emitDeclarationOnly --project tsconfig.build.json`;
