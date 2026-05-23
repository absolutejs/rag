import type {
  RAGAdminActionRecord,
  RAGAdminJobRecord,
  RAGBackendCapabilities,
  RAGVectorStoreStatus,
} from "@absolutejs/ai";

import { buildRAGRetrievalTracePresentation } from "./presentation";

type RetrievalTrace = Parameters<typeof buildRAGRetrievalTracePresentation>[0];

const STREAM_STAGES = [
  "submitting",
  "retrieving",
  "retrieved",
  "streaming",
  "complete",
] as const;

type RAGStreamStage = (typeof STREAM_STAGES)[number];

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const formatTime = (timestamp?: number) => {
  if (!timestamp) {
    return "n/a";
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
};

const formatDuration = (durationMs?: number) =>
  typeof durationMs !== "number" || durationMs < 0 ? "n/a" : `${durationMs}ms`;

/** Server-rendered HTMX fragment renderers for the RAG workflow surface.
 *  Every default emits `${classPrefix}-*` class names (default prefix `rag`) so
 *  a consumer can keep its own design system by passing `classPrefix`. Any
 *  individual renderer can be overridden; the rest fall back to these defaults
 *  (mirrors `@absolutejs/ai`'s `resolveRenderers`). */
export type RAGHTMXRenderConfig = {
  classPrefix?: string;
  tracePanel?: (input: {
    title: string;
    summary: string;
    trace?: RetrievalTrace;
  }) => string;
  stageRow?: (currentStage: RAGStreamStage) => string;
  capabilities?: (capabilities?: RAGBackendCapabilities) => string;
  nativeSource?: (status?: RAGVectorStoreStatus) => string;
  statusSummary?: (status?: RAGVectorStoreStatus) => string;
  statusMessage?: (status?: RAGVectorStoreStatus) => string;
  detailList?: (lines: string[], fallback: string) => string;
  adminJobCards?: (jobs?: RAGAdminJobRecord[]) => string;
  adminActionCards?: (actions?: RAGAdminActionRecord[]) => string;
};

export type ResolvedRAGHTMXRenderers = Required<
  Omit<RAGHTMXRenderConfig, "classPrefix">
> & { classPrefix: string };

const makeTracePanel =
  (prefix: string) =>
  ({
    title,
    summary,
    trace,
  }: {
    title: string;
    summary: string;
    trace?: RetrievalTrace;
  }) => {
    if (!trace) {
      return "";
    }

    const presentation = buildRAGRetrievalTracePresentation(trace);
    return [
      `<div class="${prefix}-results">`,
      `<h4>${escapeHtml(title)}</h4>`,
      `<p class="${prefix}-metadata">${escapeHtml(summary)}</p>`,
      `<div class="${prefix}-stat-grid">`,
      presentation.stats
        .map(
          (row) =>
            `<article class="${prefix}-stat-card"><p class="${prefix}-section-caption">${escapeHtml(row.label)}</p><strong>${escapeHtml(row.value)}</strong></article>`,
        )
        .join(""),
      "</div>",
      "<div>",
      presentation.details
        .map(
          (row) =>
            `<p class="${prefix}-key-value-row"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.value)}</span></p>`,
        )
        .join(""),
      "</div>",
      `<div class="${prefix}-result-grid">`,
      presentation.steps
        .map(
          (step, index) =>
            `<details class="${prefix}-collapsible ${prefix}-result-item" ${index === 0 ? "open" : ""}><summary><strong>${index + 1}. ${escapeHtml(step.label)}</strong></summary>${step.rows.map((row) => `<p class="${prefix}-key-value-row"><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(row.value)}</span></p>`).join("")}</details>`,
        )
        .join(""),
      "</div>",
      "</div>",
    ].join("");
  };

const makeStageRow = (prefix: string) => (currentStage: RAGStreamStage) =>
  `<div class="${prefix}-stage-row">${STREAM_STAGES.map((stage) => {
    const classNames = [`${prefix}-stage-pill`];

    if (stage === "complete") {
      classNames.push("complete");
    }

    if (stage === currentStage) {
      classNames.push("current");
    }

    return `<span class="${classNames.join(" ")}">${escapeHtml(stage)}</span>`;
  }).join("")}</div>`;

const makeCapabilities =
  (prefix: string) => (capabilities?: RAGBackendCapabilities) => {
    if (!capabilities) {
      return `<p class="${prefix}-metadata">Backend capabilities unavailable.</p>`;
    }

    const values = [
      capabilities.backend,
      capabilities.persistence,
      capabilities.nativeVectorSearch
        ? "native vector search"
        : "managed fallback search",
      capabilities.serverSideFiltering
        ? "server-side filters"
        : "client-side filters",
      capabilities.streamingIngestStatus
        ? "streaming ingest status"
        : "polled ingest status",
    ];

    return `<p class="${prefix}-metadata">Backend capabilities: <strong>${escapeHtml(values.join(" · "))}</strong></p>`;
  };

const defaultNativeSource = (status?: RAGVectorStoreStatus) => {
  const native = status?.native;
  if (!native || !native.active) {
    return "Not applicable";
  }

  if (status?.backend === "sqlite") {
    return "Packaged sqlite-vec";
  }

  if (status?.backend === "postgres") {
    return "PostgreSQL pgvector extension";
  }

  return "Managed by AbsoluteJS";
};

const defaultStatusSummary = (status?: RAGVectorStoreStatus) => {
  if (!status) {
    return "No backend status is available.";
  }

  if (status.native?.active) {
    return "Native vector acceleration is active.";
  }

  if (status.vectorMode === "json_fallback") {
    return "Owned JSON fallback retrieval is active.";
  }

  return `Vector mode ${status.vectorMode} is active.`;
};

const defaultStatusMessage = (status?: RAGVectorStoreStatus) => {
  if (!status) {
    return "Backend status unavailable.";
  }

  return status.native?.fallbackReason ?? defaultStatusSummary(status);
};

const makeDetailList =
  (prefix: string) => (lines: string[], fallback: string) => {
    const values = lines.length > 0 ? lines : [fallback];
    return `<ul class="${prefix}-detail-list">${values.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`;
  };

const makeAdminJobCards = (prefix: string) => (jobs?: RAGAdminJobRecord[]) => {
  const records = (jobs ?? []).slice(0, 3);
  if (records.length === 0) {
    return `<p class="${prefix}-metadata">No admin jobs recorded yet.</p>`;
  }

  return `<div class="${prefix}-stat-grid">${records
    .map((job) => {
      const target = job.target ?? "global";
      const timing =
        typeof job.startedAt === "number" ? formatTime(job.startedAt) : "n/a";

      return `<article class="${prefix}-stat-card">
        <span class="${prefix}-stat-label">${escapeHtml(job.action)}</span>
        <strong>${escapeHtml(job.status.toUpperCase())}</strong>
        <p>${escapeHtml(target)}</p>
        <div class="${prefix}-key-value-list">
          <div class="${prefix}-key-value-row"><span>Started</span><strong>${escapeHtml(timing)}</strong></div>
          ${typeof job.elapsedMs === "number" ? `<div class="${prefix}-key-value-row"><span>Elapsed</span><strong>${escapeHtml(formatDuration(job.elapsedMs))}</strong></div>` : ""}
        </div>
      </article>`;
    })
    .join("")}</div>`;
};

const makeAdminActionCards =
  (prefix: string) => (actions?: RAGAdminActionRecord[]) => {
    const records = (actions ?? []).slice(0, 3);
    if (records.length === 0) {
      return `<p class="${prefix}-metadata">No admin actions recorded yet.</p>`;
    }

    return `<div class="${prefix}-stat-grid">${records
      .map((action) => {
        const target = action.documentId ?? action.target ?? "global";
        const timing =
          typeof action.elapsedMs === "number"
            ? formatDuration(action.elapsedMs)
            : typeof action.startedAt === "number"
              ? formatTime(action.startedAt)
              : "n/a";

        return `<article class="${prefix}-stat-card">
        <span class="${prefix}-stat-label">${escapeHtml(action.action)}</span>
        <strong>${escapeHtml(action.status.toUpperCase())}</strong>
        <p>${escapeHtml(target)}</p>
        <div class="${prefix}-key-value-list">
          <div class="${prefix}-key-value-row"><span>When</span><strong>${escapeHtml(timing)}</strong></div>
        </div>
      </article>`;
      })
      .join("")}</div>`;
  };

export const resolveRAGHTMXRenderers = (
  custom: RAGHTMXRenderConfig = {},
): ResolvedRAGHTMXRenderers => {
  const classPrefix = custom.classPrefix ?? "rag";

  return {
    adminActionCards: custom.adminActionCards ?? makeAdminActionCards(classPrefix),
    adminJobCards: custom.adminJobCards ?? makeAdminJobCards(classPrefix),
    capabilities: custom.capabilities ?? makeCapabilities(classPrefix),
    classPrefix,
    detailList: custom.detailList ?? makeDetailList(classPrefix),
    nativeSource: custom.nativeSource ?? defaultNativeSource,
    stageRow: custom.stageRow ?? makeStageRow(classPrefix),
    statusMessage: custom.statusMessage ?? defaultStatusMessage,
    statusSummary: custom.statusSummary ?? defaultStatusSummary,
    tracePanel: custom.tracePanel ?? makeTracePanel(classPrefix),
  };
};
