import { $ } from "bun";
import { rm } from "node:fs/promises";

const DIST = "dist";

await rm(DIST, { force: true, recursive: true });

const serverBuild = await Bun.build({
  entrypoints: [
    "src/index.ts",
    "src/adapter-kit/index.ts",
    "src/presentation/ui.ts",
    "src/quality/quality.ts",
    "src/client/index.ts",
    "src/client/ui.ts",
  ],
  external: [
    "elysia",
    "@absolutejs/ai",
    "@absolutejs/ai/client",
    "@absolutejs/sync",
    "@absolutejs/sync/engine",
  ],
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
    "src/react/index.ts",
    "src/vue/index.ts",
    "src/svelte/index.ts",
    "src/angular/index.ts",
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
