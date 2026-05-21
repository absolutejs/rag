// Presentation-layer shapes. The derived `RAGStreamProgressState`
// (ReturnType<typeof buildRAGStreamProgress>) stays colocated in
// src/presentation/presentation.ts since it references a local function.

import type {
  AIMessage,
  RAGHTMXWorkflowRenderConfig,
  RAGStreamStage,
} from "@absolutejs/ai";

export type RAGStreamProgress = {
  stage: RAGStreamStage;
  conversationId?: string;
  messageId?: string;
  retrievalStartedAt?: number;
  retrievedAt?: number;
  retrievalDurationMs?: number;
  hasContent: boolean;
  hasRetrieved: boolean;
  hasSources: boolean;
  hasThinking: boolean;
  hasToolCalls: boolean;
  isComplete: boolean;
  isError: boolean;
  isIdle: boolean;
  isRetrieving: boolean;
  isRetrieved: boolean;
  isStreaming: boolean;
  isSubmitting: boolean;
  sourceCount: number;
  latestMessage: AIMessage | undefined;
};

export type ResolvedRAGWorkflowRenderers =
  Required<RAGHTMXWorkflowRenderConfig>;
