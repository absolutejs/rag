// Browser RAG client shapes. The implementation in src/client/ragClient.ts
// imports these; src/client/index.ts re-exports them for "@absolutejs/rag/
// client" consumers. The derived `RAGClient` (ReturnType<typeof
// createRAGClient>) stays colocated in ragClient.ts.

import type {
  RAGBackendMaintenanceRecommendation,
  RAGBackendMaintenanceSummary,
  RAGMutationResponse,
  RAGOperationsResponse,
  RAGSearchResponse,
  RAGSource,
  RAGStatusResponse,
} from "@absolutejs/ai";

export type RAGClientOptions = {
  path: string;
  fetch?: typeof fetch;
};

export type RAGDetailedSearchResponse = {
  results: RAGSource[];
  trace?: RAGSearchResponse["trace"];
};

export type RAGMaintenancePayload =
  | Pick<RAGMutationResponse, "maintenance" | "admin" | "workflowStatus">
  | Pick<RAGOperationsResponse, "maintenance" | "admin" | "status">
  | Pick<RAGStatusResponse, "maintenance" | "admin" | "status">
  | null
  | undefined;

export type RAGMaintenanceActionDescriptor = {
  kind: "analyze_backend" | "rebuild_native_index";
  label: string;
  available: boolean;
  recommended: boolean;
  reason?: string;
};

export type RAGMaintenanceOverview = {
  activeJobCount: number;
  actions: RAGMaintenanceActionDescriptor[];
  availableActions: RAGMaintenanceActionDescriptor[];
  backend?: RAGBackendMaintenanceSummary["backend"];
  blockingRecommendations: RAGBackendMaintenanceRecommendation[];
  criticalCount: number;
  hasBlockingIssue: boolean;
  infoCount: number;
  primaryRecommendation?: RAGBackendMaintenanceRecommendation;
  recentlyCompletedActions: NonNullable<RAGBackendMaintenanceSummary>["recentActions"];
  recommendationCount: number;
  recommendations: RAGBackendMaintenanceRecommendation[];
  recommendedNow: RAGBackendMaintenanceRecommendation[];
  warningCount: number;
};
