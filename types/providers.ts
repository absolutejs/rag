// Embedding, reranker, extractor (OCR/transcription), and email provider
// configuration shapes. Definitions live here; the provider implementations in
// src/rag/*Providers.ts import these. Private vendor wire-format/response types
// stay colocated with the code that parses them.

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit | BunFetchRequestInit,
) => Promise<Response>;

// --- Embedding providers ---

export type OpenAIEmbeddingsConfig = {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  dimensions?: number;
  fetch?: FetchLike;
};

export type OpenAICompatibleEmbeddingsConfig = OpenAIEmbeddingsConfig & {
  baseUrl: string;
};

export type GeminiEmbeddingsConfig = {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  dimensions?: number;
  fetch?: FetchLike;
};

export type OllamaEmbeddingsConfig = {
  baseUrl?: string;
  defaultModel?: string;
  fetch?: FetchLike;
};

// --- Reranker providers ---

export type CrossEncoderRerankerConfig = {
  apiKey: string;
  defaultModel?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Extra headers (e.g. API version) merged into the request. */
  headers?: Record<string, string>;
};

// --- Extractor providers (OCR / transcription) ---

export type OpenAITranscriptionConfig = {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  fetch?: FetchLike;
  language?: string;
  prompt?: string;
};

export type OpenAICompatibleTranscriptionConfig = OpenAITranscriptionConfig & {
  baseUrl: string;
};

export type OpenAIOCRConfig = {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  fetch?: FetchLike;
  prompt?: string;
};

export type OpenAICompatibleOCRConfig = OpenAIOCRConfig & {
  baseUrl: string;
};

export type GeminiOCRConfig = {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  fetch?: FetchLike;
  prompt?: string;
};

export type OllamaOCRConfig = {
  baseUrl?: string;
  defaultModel?: string;
  fetch?: FetchLike;
  prompt?: string;
};

export type OllamaTranscriptionConfig = {
  baseUrl?: string;
  defaultModel?: string;
  fetch?: FetchLike;
  prompt?: string;
};

export type AnthropicOCRConfig = {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  fetch?: FetchLike;
  prompt?: string;
};

// --- Email sync providers ---

export type GmailEmailSyncConfig = {
  accessToken: string;
  userId?: string;
  query?: string;
  labelIds?: string[];
  includeSpamTrash?: boolean;
  maxResults?: number;
  fetch?: typeof fetch;
};

export type GraphEmailSyncConfig = {
  accessToken: string;
  baseUrl?: string;
  userId?: string;
  folderId?: string;
  filter?: string;
  search?: string;
  top?: number;
  fetch?: typeof fetch;
};

export type IMAPEmailSyncConfig = {
  host: string;
  port?: number;
  secure?: boolean;
  username: string;
  password: string;
  mailbox?: string;
  search?: string[];
  maxResults?: number;
};
