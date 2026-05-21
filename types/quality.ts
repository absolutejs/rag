// SQLite-backed quality/governance store option shapes. The store factories in
// src/quality/quality.ts import these (and re-export them, since "@absolutejs/rag/
// quality" is a public entry point). Every per-store option is the same
// db/path/tableName shape, expressed via a shared base.

import type { Database } from "bun:sqlite";

type SQLiteStoreOptionsBase = {
  db?: Database;
  path?: string;
  tableName?: string;
};

export type SQLiteRAGSearchTraceStoreOptions = SQLiteStoreOptionsBase;
export type SQLiteRAGEvaluationHistoryStoreOptions = SQLiteStoreOptionsBase;
export type SQLiteRAGEvaluationSuiteSnapshotHistoryStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGAnswerGroundingEvaluationHistoryStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGSearchTracePruneHistoryStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalComparisonHistoryStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalReleaseDecisionStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalBaselineStoreOptions = SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalReleaseIncidentStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalLaneHandoffDecisionStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalLaneHandoffIncidentStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalLaneHandoffIncidentHistoryStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalIncidentRemediationDecisionStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalIncidentRemediationExecutionHistoryStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalLaneHandoffAutoCompletePolicyHistoryStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalReleaseLanePolicyHistoryStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalBaselineGatePolicyHistoryStoreOptions =
  SQLiteStoreOptionsBase;
export type SQLiteRAGRetrievalReleaseLaneEscalationPolicyHistoryStoreOptions =
  SQLiteStoreOptionsBase;

export type SQLiteRAGGovernanceStoreBundleOptions = {
  db?: Database;
  path?: string;
  tablePrefix?: string;
};

export type SQLiteRAGStoreMigrationOptions = {
  db?: Database;
  path?: string;
  descriptors?: Array<{
    tableName: string;
    columns: Array<{ name: string; definition: string }>;
  }>;
};
