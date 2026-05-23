import type {
  RAGCitation,
  RAGGroundingReference,
  RAGSectionRetrievalDiagnostic,
  RAGSourceSummary,
} from "@absolutejs/ai";

const formatScore = (value: number) =>
  Number.isFinite(value) ? value.toFixed(3) : "0.000";

export type RAGSectionDiagnostic = RAGSectionRetrievalDiagnostic & {
  peakStage?: string;
  peakCount?: number;
  finalCount?: number;
  finalRetentionRate?: number;
  dropFromPeak?: number;
  queryAttribution?: {
    mode: "primary" | "transformed" | "variant" | "mixed";
    primaryHits: number;
    transformedHits: number;
    variantHits: number;
    reasons: string[];
  };
  stageWeights?: Array<{
    stage: string;
    count: number;
    previousStage?: string;
    previousCount?: number;
    countDelta?: number;
    retentionRate?: number;
    totalScore?: number;
    stageScoreShare?: number;
    parentStageScoreShare?: number;
    stageScoreShareGap?: number;
    parentStageScoreShareGap?: number;
    stageShare: number;
    parentStageShare?: number;
    stageShareGap?: number;
    parentStageShareGap?: number;
    strongestSiblingLabel?: string;
    strongestSiblingCount?: number;
    reasons: string[];
  }>;
};

export type RAGSourceSummaryGroup = {
  id: string;
  label: string;
  targetId: string;
  summary: string;
  summaries: RAGSourceSummary[];
};

export type RAGGroundingReferenceGroup = {
  id: string;
  label: string;
  targetId: string;
  summary: string;
  references: RAGGroundingReference[];
};

export type RAGCitationGroup = {
  id: string;
  label: string;
  targetId: string;
  summary: string;
  citations: RAGCitation[];
};

export const buildSearchTargetId = (prefix: string, value: string) => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${normalized || "item"}`;
};

export const buildSourceSummarySectionGroups = (
  summaries?: RAGSourceSummary[] | null,
): RAGSourceSummaryGroup[] => {
  const groups = new Map<string, RAGSourceSummaryGroup>();
  for (const summary of summaries ?? []) {
    const label = summary.contextLabel ?? summary.label;
    const id = buildSearchTargetId("source-summary-section", label);
    const existing = groups.get(id);
    if (existing) {
      existing.summaries.push(summary);
      existing.summary = `${existing.summaries.length} evidence summar${existing.summaries.length === 1 ? "y" : "ies"}`;
      continue;
    }
    groups.set(id, {
      id,
      label,
      targetId: id,
      summary: "1 evidence summary",
      summaries: [summary],
    });
  }
  return [...groups.values()].sort((left, right) => {
    const leftScore = Math.max(
      ...left.summaries.map((summary) => summary.bestScore),
    );
    const rightScore = Math.max(
      ...right.summaries.map((summary) => summary.bestScore),
    );
    return rightScore - leftScore;
  });
};

export const buildGroundingReferenceGroups = (
  references?: RAGGroundingReference[] | null,
): RAGGroundingReferenceGroup[] => {
  const groups = new Map<string, RAGGroundingReferenceGroup>();
  for (const reference of references ?? []) {
    const label =
      reference.contextLabel ??
      reference.label ??
      reference.source ??
      reference.chunkId;
    const id = buildSearchTargetId("grounding-reference-section", label);
    const existing = groups.get(id);
    if (existing) {
      existing.references.push(reference);
      existing.summary = `${existing.references.length} grounding reference${existing.references.length === 1 ? "" : "s"}`;
      continue;
    }
    groups.set(id, {
      id,
      label,
      targetId: id,
      summary: "1 grounding reference",
      references: [reference],
    });
  }
  return [...groups.values()].sort((left, right) => {
    const leftScore = Math.max(
      ...left.references.map((reference) => reference.score),
    );
    const rightScore = Math.max(
      ...right.references.map((reference) => reference.score),
    );
    return rightScore - leftScore;
  });
};

export const buildCitationGroups = (
  citations?: RAGCitation[] | null,
): RAGCitationGroup[] => {
  const groups = new Map<string, RAGCitationGroup>();
  for (const citation of citations ?? []) {
    const label =
      citation.contextLabel ??
      citation.label ??
      citation.source ??
      citation.chunkId;
    const id = buildSearchTargetId("citation-section", label);
    const existing = groups.get(id);
    if (existing) {
      existing.citations.push(citation);
      existing.summary = `${existing.citations.length} citation${existing.citations.length === 1 ? "" : "s"}`;
      continue;
    }
    groups.set(id, {
      id,
      label,
      targetId: id,
      summary: "1 citation",
      citations: [citation],
    });
  }
  return [...groups.values()].sort((left, right) => {
    const leftScore = Math.max(
      ...left.citations.map((citation) => citation.score),
    );
    const rightScore = Math.max(
      ...right.citations.map((citation) => citation.score),
    );
    return rightScore - leftScore;
  });
};

export const formatCitationLabel = (citation: RAGCitation) =>
  [citation.label, citation.contextLabel, citation.locatorLabel]
    .filter(Boolean)
    .join(" · ");

export const formatCitationSummary = (citation: RAGCitation) =>
  citation.source ?? citation.title ?? citation.chunkId;

export const formatCitationExcerpt = (citation: RAGCitation) =>
  citation.excerpt || citation.text;

const formatEvidenceDetailLine = (label: string, value?: string | null) =>
  value && value.length > 0 ? `${label}: ${value}` : "";

const formatEvidenceContextLine = (
  contextLabel?: string | null,
  locatorLabel?: string | null,
) => {
  const value = [locatorLabel, contextLabel]
    .filter((entry): entry is string => Boolean(entry && entry.length > 0))
    .join(" · ");
  return value.length > 0 ? `location: ${value}` : "";
};

export const formatSourceSummaryDetails = (summary: RAGSourceSummary) =>
  [
    `best score: ${formatScore(summary.bestScore)}`,
    `coverage: ${summary.count} chunk(s) · citations ${summary.citationNumbers.map((value) => `[${value}]`).join(" ") || "none"}`,
    formatEvidenceContextLine(summary.contextLabel, summary.locatorLabel),
    formatEvidenceDetailLine("provenance", summary.provenanceLabel),
  ].filter((value) => value.length > 0);

export const formatCitationDetails = (citation: RAGCitation) =>
  [
    formatEvidenceDetailLine(
      "evidence",
      citation.source ?? citation.title ?? citation.chunkId,
    ),
    formatEvidenceContextLine(citation.contextLabel, citation.locatorLabel),
    formatEvidenceDetailLine("provenance", citation.provenanceLabel),
    `score: ${formatScore(citation.score)}`,
  ].filter((value) => value.length > 0);

const formatSectionDiagnosticPercent = (value?: number) =>
  typeof value === "number" ? `${Math.round(value * 100)}%` : null;

const formatSectionDiagnosticReason = (reason: string) =>
  reason.replaceAll("_", " ");

const formatSectionDiagnosticStage = (stage: string) =>
  stage.replaceAll("_", " ");

const formatSectionDiagnosticWeightReason = (reason: string) =>
  ({
    final_stage_concentration: "final stage concentrated on this section",
    final_stage_dominant_within_parent:
      "final stage stayed ahead inside its parent",
    rerank_preserved_lead: "rerank kept this section in front",
    stage_runner_up_pressure: "runner-up stayed close in this stage",
    stage_expanded: "this section expanded in this stage",
    stage_held: "this section held steady in this stage",
    stage_narrowed: "this section narrowed in this stage",
  })[reason] ?? reason.replaceAll("_", " ");

const formatSectionQueryAttributionReason = (reason: string) =>
  ({
    base_query_only: "came only from the base query",
    transformed_query_only: "came only from the transformed query",
    variant_only: "came only from query variants",
    transform_introduced: "the transformed query introduced this section",
    variant_supported: "query variants reinforced this section",
    mixed_query_sources: "multiple query forms contributed",
  })[reason] ?? reason.replaceAll("_", " ");

export const formatSectionDiagnosticChannels = (
  diagnostic: RAGSectionRetrievalDiagnostic,
) =>
  `Channels · hybrid ${diagnostic.hybridHits} · vector ${diagnostic.vectorHits} · lexical ${diagnostic.lexicalHits}`;

export const formatSectionDiagnosticAttributionFocus = (
  diagnostic: RAGSectionDiagnostic,
) => {
  const mode = diagnostic.queryAttribution?.mode ?? "mixed";
  const label =
    mode === "primary"
      ? "Attribution · base-query-only"
      : mode === "transformed"
        ? "Attribution · transformed-only"
        : mode === "variant"
          ? "Attribution · variant-only"
          : "Attribution · mixed";
  const parts = [label];
  if ((diagnostic.queryAttribution?.primaryHits ?? 0) > 0)
    parts.push(`base ${diagnostic.queryAttribution?.primaryHits}`);
  if ((diagnostic.queryAttribution?.transformedHits ?? 0) > 0)
    parts.push(`transformed ${diagnostic.queryAttribution?.transformedHits}`);
  if ((diagnostic.queryAttribution?.variantHits ?? 0) > 0)
    parts.push(`variant ${diagnostic.queryAttribution?.variantHits}`);
  return parts.join(" · ");
};

export const formatSectionDiagnosticPipeline = (
  diagnostic: RAGSectionDiagnostic,
) => {
  const requestedMode =
    diagnostic.requestedMode ?? diagnostic.retrievalMode ?? "n/a";
  const selectedMode = diagnostic.retrievalMode ?? "n/a";
  const routeLabel = diagnostic.routingLabel ?? "default route";
  const transformLabel = diagnostic.queryTransformLabel ?? "no transform";
  return `Mode ${selectedMode} · requested ${requestedMode} · route ${routeLabel} · transform ${transformLabel} · rerank ${diagnostic.rerankApplied ? "on" : "off"} · source balance ${diagnostic.sourceBalanceApplied ? "on" : "off"} · threshold ${diagnostic.scoreThresholdApplied ? "on" : "off"} · query ${diagnostic.queryAttribution?.mode ?? "n/a"}`;
};

export const formatSectionDiagnosticStageFlow = (
  diagnostic: RAGSectionRetrievalDiagnostic,
) =>
  diagnostic.stageCounts.length > 0
    ? `Stage flow · ${diagnostic.stageCounts
        .map(
          (entry) =>
            `${formatSectionDiagnosticStage(entry.stage)} ${entry.count}`,
        )
        .join(" → ")}`
    : null;

export const formatSectionDiagnosticStageBounds = (
  diagnostic: RAGSectionDiagnostic,
) => {
  const parts: string[] = [];
  if (diagnostic.firstSeenStage)
    parts.push(
      `first seen ${formatSectionDiagnosticStage(diagnostic.firstSeenStage)}`,
    );
  if (diagnostic.lastSeenStage)
    parts.push(
      `last seen ${formatSectionDiagnosticStage(diagnostic.lastSeenStage)}`,
    );
  if (diagnostic.peakStage)
    parts.push(
      `peak ${formatSectionDiagnosticStage(diagnostic.peakStage)} ${diagnostic.peakCount}`,
    );
  const finalRetention = formatSectionDiagnosticPercent(
    diagnostic.finalRetentionRate,
  );
  if (finalRetention) parts.push(`final retention ${finalRetention}`);
  if (typeof diagnostic.dropFromPeak === "number")
    parts.push(`drop from peak ${diagnostic.dropFromPeak}`);
  return parts.length > 0 ? parts.join(" · ") : null;
};

export const formatSectionDiagnosticStageWeightRows = (
  diagnostic: RAGSectionDiagnostic,
) =>
  (diagnostic.stageWeights ?? [])
    .filter(
      (entry) =>
        entry.reasons.length > 0 ||
        entry.stage === "rerank" ||
        entry.stage === "finalize",
    )
    .map((entry) => {
      const parts = [
        `${formatSectionDiagnosticStage(entry.stage)} ${(entry.stageShare * 100).toFixed(0)}% of stage`,
        typeof entry.stageScoreShare === "number"
          ? `${(entry.stageScoreShare * 100).toFixed(0)}% of stage score`
          : null,
        typeof entry.retentionRate === "number" &&
        entry.previousStage &&
        entry.retentionRate !== 1
          ? `${(entry.retentionRate * 100).toFixed(0)}% retained from ${formatSectionDiagnosticStage(entry.previousStage)}`
          : null,
        typeof entry.countDelta === "number" && entry.countDelta !== 0
          ? `delta ${entry.countDelta >= 0 ? "+" : ""}${entry.countDelta}`
          : null,
        typeof entry.parentStageShare === "number" &&
        entry.strongestSiblingLabel
          ? `${(entry.parentStageShare * 100).toFixed(0)}% of parent stage`
          : null,
        typeof entry.parentStageScoreShare === "number" &&
        entry.strongestSiblingLabel
          ? `${(entry.parentStageScoreShare * 100).toFixed(0)}% of parent stage score`
          : null,
        typeof entry.stageShareGap === "number"
          ? `gap ${(entry.stageShareGap * 100).toFixed(0)}%`
          : null,
        typeof entry.stageScoreShareGap === "number"
          ? `score gap ${(entry.stageScoreShareGap * 100).toFixed(0)}%`
          : null,
        entry.strongestSiblingLabel
          ? `runner-up ${entry.strongestSiblingLabel}`
          : null,
      ].filter((value): value is string => Boolean(value));
      return parts.join(" · ");
    });

export const formatSectionDiagnosticStageWeightReasons = (
  diagnostic: RAGSectionDiagnostic,
) =>
  (diagnostic.stageWeights ?? []).flatMap((entry) =>
    entry.reasons.map(
      (reason) =>
        `${formatSectionDiagnosticStage(entry.stage)} · ${formatSectionDiagnosticWeightReason(reason)}`,
    ),
  );

const formatSectionDiagnosticQueryAttributionReasons = (
  diagnostic: RAGSectionDiagnostic,
) =>
  (diagnostic.queryAttribution?.reasons ?? []).map((reason) =>
    formatSectionQueryAttributionReason(reason),
  );

export const formatSectionDiagnosticCompetition = (
  diagnostic: RAGSectionRetrievalDiagnostic,
) => {
  const parts: string[] = [];
  const parentShare = formatSectionDiagnosticPercent(diagnostic.parentShare);
  const parentShareGap = formatSectionDiagnosticPercent(
    diagnostic.parentShareGap,
  );
  if (!diagnostic.strongestSiblingLabel) return "";
  if (parentShare) parts.push(`parent share ${parentShare}`);
  if (parentShareGap) parts.push(`gap ${parentShareGap}`);
  parts.push(`runner-up ${diagnostic.strongestSiblingLabel}`);
  return parts.join(" · ");
};

export const formatSectionDiagnosticTopEntry = (
  diagnostic: RAGSectionDiagnostic,
) => {
  const parts: string[] = [];
  if (diagnostic.topSource) parts.push(`top source ${diagnostic.topSource}`);
  if (diagnostic.topChunkId) parts.push(`lead chunk ${diagnostic.topChunkId}`);
  parts.push(
    `${diagnostic.sourceCount} source${diagnostic.sourceCount === 1 ? "" : "s"}`,
  );
  parts.push(
    `primary ${diagnostic.queryAttribution?.primaryHits ?? 0} · transformed ${diagnostic.queryAttribution?.transformedHits ?? 0} · variant ${diagnostic.queryAttribution?.variantHits ?? 0}`,
  );
  return parts.join(" · ");
};

export const formatSectionDiagnosticReasons = (
  diagnostic: RAGSectionDiagnostic,
) => [
  ...diagnostic.reasons.map((reason) => formatSectionDiagnosticReason(reason)),
  ...formatSectionDiagnosticQueryAttributionReasons(diagnostic),
  ...(diagnostic.routingReason
    ? [`routing · ${diagnostic.routingReason}`]
    : []),
  ...(diagnostic.queryTransformReason
    ? [`transform · ${diagnostic.queryTransformReason}`]
    : []),
];

export const formatSectionDiagnosticDistributionRows = (
  diagnostic: RAGSectionRetrievalDiagnostic,
) =>
  diagnostic.parentDistribution.map(
    (entry) =>
      `${entry.isActive ? "Active" : "Peer"} · ${entry.label} · ${entry.count} hit${entry.count === 1 ? "" : "s"} · ${formatSectionDiagnosticPercent(entry.parentShare) ?? "0%"}`,
  );
