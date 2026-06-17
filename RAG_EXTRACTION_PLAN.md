# RAG domain extraction: `@absolutejs/ai` → `@absolutejs/rag`

Plan of record for moving the RAG domain out of the `ai` package (where it currently
lives, entangled with inference) into `rag` (where it belongs). Multi-session effort.
Branch `refactor/rag-domain-extraction` in worktrees:
- ai:  `/home/alexkahn/abs/.worktrees/ai-rag-extraction`
- rag: `/home/alexkahn/abs/.worktrees/rag-rag-extraction`

Leave the main working trees (`/home/alexkahn/abs/ai`, `/home/alexkahn/abs/rag`) untouched —
other agents may be active there.

## Current state (investigated 2026-06-17)

- **`ai/types/ai.ts` is a 6,032-line / 172 KB shared type file with 507 exported decls:
  451 `RAG*`, 46 `AI*`, ~10 shared (`Reasoning*`, `StreamAI*`, `SQLiteVec*`, generic
  `CreateRAG*`).** This is the real home of the RAG type universe.
- `ai/src` is otherwise inference-only (generate/stream/conversation/memory/tools/providers).
- **`rag/src` already holds the RAG engine implementations** (sync, quality, presentation,
  chat, retrieval, ingestion) and imports ~300 `RAG*` types from `@absolutejs/ai` across
  ~80 import sites. `rag/src` defines only 8 `RAG*` symbols of its own.
- `rag@0.0.26` depends on `ai@^0.0.9`; npm-latest `ai` is `0.0.18`. `rag/node_modules/
  @absolutejs/ai` is a dist-only `0.0.9` build. Local `~/abs/ai` is `0.0.18`. **Version
  skew is real** — verify which `ai` the build actually resolves before trusting types.

## The blocker: circular dependency

`ai/src` USES RAG types: `src/ai/client/messageStore.ts` and `src/ai/htmxRenderers.ts`
import `RAGSource` + `RAGRetrievalTrace` (chat surfaces RAG-retrieved sources/traces).
So `ai` cannot simply depend on `rag` for all RAG types — `rag` depends on `ai`.

**Boundary decision:** split the 451 RAG types into two sets:
1. **RAG result/presentation types `ai` needs** (the transitive closure of `RAGSource` +
   `RAGRetrievalTrace` as used by chat/htmx — likely `RAGSource`, `RAGCitation`,
   `RAGRetrievalTrace`, `RAGRetrievalTraceStage/Step`, `RAGGroundingReference`, chunk/excerpt
   shapes they reference). These STAY in `ai` (small, stable, result-shaped).
2. **RAG engine types** (sync, ingestion, evaluation, retrieval-internals, vector-store,
   admin, baselines, incidents, presentation-of-engine, ~400 types). These MOVE to `rag`.

Compute set (1) precisely with a transitive-closure pass before moving anything — anything
reachable from the two ai-facing types must stay (or be duplicated) in `ai`.

## Order of operations

1. **Closure analysis** — from `RAGSource` + `RAGRetrievalTrace`, walk `ai/types/ai.ts` to
   the full set of types `ai/src` transitively needs. Output the keep-in-ai list.
2. **Carve `rag`'s own types file** — create `rag/src/types/rag.ts` with the ~400 engine
   types (moved verbatim from `ai/types/ai.ts`), importing the ai-facing types + `AI*` types
   from `@absolutejs/ai`.
3. **Trim `ai/types/ai.ts`** — delete the moved engine types; keep `AI*` + the closure set +
   shared primitives. Rebuild `ai`, confirm `ai/src` still typechecks.
4. **Rewire `rag/src`** — change the ~80 import sites: engine types from `./types/rag` (or
   rag's index), ai-facing + `AI*` types still from `@absolutejs/ai`. Stop the blanket
   `export type * from "@absolutejs/ai"` re-export of RAG types; re-export rag's own instead.
5. **Bump `rag` → `ai@0.0.18`** (resolve the version skew) and rebuild rag end-to-end.
6. **Consumers** — update dealroom (`@absolutejs/rag` import surface) + any other consumer;
   typecheck + lint each. dealroom canonical clone: `~/onspark/absolutejs/dealroom`.
7. **Release** — version bump both (BSL packages; keep the carveout), publish in dep order
   (ai first, then rag), update lockfiles.

## Cross-repo build/test

`rag` consumes `ai` via node_modules. To test the modified `ai` against the modified `rag`
without publishing: `bun link` the ai worktree into the rag worktree (or a file: dep), build
`ai`, then build/typecheck `rag`. Confirm the resolved `@absolutejs/ai` is the worktree, not
the cached `0.0.9`. Do NOT point the main trees at the worktree.

## Verification (per step)

- `ai`: `bun run build` + `tsc` clean; `ai/src` has zero unresolved RAG imports.
- `rag`: `bun run build` + `tsc` clean; tests in `rag/tests/*` pass (quality, presentation).
- dealroom: `bun run typecheck` + lint on the changed import surface.
- Grep guard: after the split, `ai/types/ai.ts` should contain 0 engine-RAG decls; `ai/src`
  should import only the closure set.

## Risks / watch-outs

- **Circular deps** — the #1 risk. The closure set must be airtight; a single engine type
  leaking into `ai/src` re-creates the cycle.
- **Version skew** — `rag@0.0.9` vs `ai@0.0.18` divergence may mean some types already
  changed shape. Diff the `0.0.9` dist types against `0.0.18` `types/ai.ts` for the moved set.
- **Framework hooks** — `rag/src/{vue,react,svelte,angular}` import RAG types from ai too;
  they're in the ~80 sites. Don't miss them.
- **Published-artifact source-of-truth** — the engine types' canonical source is
  `ai/types/ai.ts@0.0.18`, NOT the `0.0.9` dist. Move from the source file.
- **rag-adapters** — `@absolutejs/rag-adapters` (pinecone/postgres/sqlite) may also import
  RAG types from ai; include it in the rewire sweep.

## Closure analysis result (step 1, DONE 2026-06-17)

`ai/src` imports exactly TWO RAG types directly: `RAGSource`, `RAGRetrievalTrace` (verified
across all of `ai/src`). Transitive closure over `ai/types/ai.ts` from those two roots =
**11 types that MUST stay in `ai`** (0 non-RAG deps — clean):

```
RAGChunkSection, RAGChunkSequence, RAGChunkStructure, RAGDiversityStrategy,
RAGHybridRetrievalMode, RAGRetrievalTrace, RAGRetrievalTraceStage, RAGRetrievalTraceStep,
RAGSource, RAGSourceBalanceStrategy, RAGSourceLabels
```

**→ Keep 11 in `ai`, move the other 440 RAG decls to `rag`.** No circular-dependency risk
once those 11 remain. (Re-run the closure script before the move in case `ai/src` grows new
RAG usage.) Closure script lives in this commit's shell history / regenerate from the two
roots if needed.

## Status log

- 2026-06-17: investigation complete; worktrees created; plan committed (a395080).
- 2026-06-17: step 1 (closure analysis) DONE — 11 keep / 440 move (446 incl. non-prefixed
  CreateRAG*/SQLiteVec*), validated airtight (b970e4a).
- 2026-06-17: steps 2-4 DONE + VERIFIED.
  - ai: `types/ai.ts` trimmed 6032→678 lines (61 keep: AI* + 11 RAG + Reasoning*/StreamAI*).
    ai typechecks clean. Committed in ai worktree `09b1b6d`.
  - rag: 446 engine types → `types/engine.ts` (NOT `src/types/` — rag uses a root `types/`
    barrel: `types/index.ts` re-exports per-domain files + `@absolutejs/ai`). Wired
    `types/index.ts` + `src/index.ts` to re-export `./engine`. Codemod repointed 58 `src/`
    + 5 `types/` import sites from `@absolutejs/ai` → `./engine`. Committed `df5793f`.
  - VERIFICATION: typechecked rag against the trimmed ai via a `tsconfig.verify.json` with
    `paths` mapping `@absolutejs/ai*` → the ai worktree `src/`. Type extraction is CLEAN.
    (The harness emits ~36 TS6059 "not under rootDir" — pure artifact of mapping paths to
    ai *source* outside rag's rootDir; gone once ai is consumed as a built/linked package.)

### REMAINING (next session)

- **5 residual real errors — `thinking`→`reasoning` skew in `src/chat/chat.ts`** (lines
  ~856-858 `config.thinking`, ~1973 + ~12317 `thinking:` in StreamAIOptions). This is the
  separate **bump rag → ai@0.0.18** step: ai 0.0.18 removed the legacy `thinking` field for
  the portable `reasoning: ReasoningConfig` knob. Rename `resolveThinking`→`resolveReasoning`,
  read `config.reasoning`, pass `reasoning:` to streamAI. Verify `AIChatPluginConfig`'s new
  shape in `ai/types/ai.ts` first. Watch for other renamed/removed types from the 0.0.9→0.0.18
  jump (e.g. `RAGQueryTransformer`/`RAGReranker`/`RAGStreamStage` appeared then resolved after
  the types/ repoint — re-verify none are truly gone).
- **Build/link for a real verify**: `bun link` the ai worktree into rag (replace the cached
  0.0.9), bump `rag` package.json `@absolutejs/ai` → `0.0.18`, `bun run build` both. The
  `tsconfig.verify.json` paths-hack was only to confirm the extraction without a publish.
- **rag-adapters sweep**: `@absolutejs/rag-adapters` (pinecone/postgres/sqlite) likely imports
  moved RAG types from `@absolutejs/ai` — repoint to `@absolutejs/rag`.
- **dealroom + consumers**: update `@absolutejs/rag`/`@absolutejs/ai` import surface,
  typecheck + lint. dealroom canonical clone: `~/onspark/absolutejs/dealroom`.
- **Release**: version-bump ai then rag (BSL, keep carveout); publish in dep order.
- Regenerate helpers if needed: `/tmp/dr-migrate/gen-engine.js`, `codemod-rag3.js`,
  `move-names.json`, `ai-types-backup.ts` (original untrimmed types/ai.ts).
