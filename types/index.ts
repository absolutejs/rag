// Canonical type surface for @absolutejs/rag. Re-exports every per-domain type
// file plus the upstream @absolutejs/ai types. Function/component props and
// ReturnType-derived results stay colocated with their implementations.

export type * from "@absolutejs/ai";
export type * from "./adapters";
export type * from "./client";
export type * from "./core";
export type * from "./presentation";
export type * from "./providers";
export type * from "./quality";
export type * from "./retrieval";
export type * from "./sync";
