import {
  isPublicNetworkAddress,
  pinnedPublicRequest,
} from "@absolutejs/egress/transport";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import type { WebReadAttempt } from "./index";

/** Allowlisted diagnostic data; never carries transport messages, headers or content. */
export type WebReadFailureDetails = {
  stage: "dns" | "request" | "decode" | "navigation" | "render";
  transportCode?: string;
  limitBytes?: number;
};
const transportCodes = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "HPE_HEADER_OVERFLOW",
  "ERR_RESPONSE_BODY_TOO_LARGE",
  "ERR_BUFFER_TOO_LARGE",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_NOT_YET_VALID",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "Z_DATA_ERROR",
]);
export const webReadFailureDetails = (
  value: unknown,
): WebReadFailureDetails | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const stage = Reflect.get(value, "stage");
  if (!["dns", "request", "decode", "navigation", "render"].includes(stage))
    return undefined;
  const code = Reflect.get(value, "transportCode"),
    limit = Reflect.get(value, "limitBytes");
  return {
    stage,
    ...(typeof code === "string" && transportCodes.has(code)
      ? { transportCode: code }
      : {}),
    ...(Number.isSafeInteger(limit) && limit > 0
      ? { limitBytes: limit as number }
      : {}),
  };
};
/** Normalize known transport causes without serializing provider-controlled messages. */
export const webTransportFailure = (
  error: unknown,
  stage: WebReadFailureDetails["stage"],
  limitBytes?: number,
): WebReadError => {
  if (isWebReadError(error)) return error;
  let current = error,
    transportCode: string | undefined;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    const code = Reflect.get(current, "code");
    if (typeof code === "string" && transportCodes.has(code)) {
      transportCode = code;
      break;
    }
    current = Reflect.get(current, "cause");
  }
  let code = "fetch_failed";
  if (transportCode === "ENOTFOUND") code = "dns_not_found";
  else if (transportCode === "EAI_AGAIN") code = "dns_unavailable";
  else if (transportCode === "HPE_HEADER_OVERFLOW")
    code = "response_headers_too_large";
  else if (
    ["ERR_RESPONSE_BODY_TOO_LARGE", "ERR_BUFFER_TOO_LARGE"].includes(
      transportCode ?? "",
    )
  )
    code = "response_body_too_large";
  else if (
    transportCode === "ETIMEDOUT" ||
    (error instanceof Error && error.name === "TimeoutError")
  )
    code = "timeout";
  else if (error instanceof Error && error.name === "AbortError")
    code = "aborted";
  else if (
    transportCode?.includes("CERT") ||
    transportCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  )
    code = "tls_error";
  else if (
    ["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(
      transportCode ?? "",
    )
  )
    code = "connection_failed";
  else if (stage === "decode") code = "response_decode_failed";
  return new WebReadError(code, `Website retrieval failed (${code}).`, {
    attempts: [],
    failure: {
      stage,
      ...(transportCode ? { transportCode } : {}),
      ...((code === "response_headers_too_large" ||
        code === "response_body_too_large") &&
      limitBytes
        ? { limitBytes }
        : {}),
    },
  });
};

/** Diagnostic metadata only: no page bodies, headers, URL credentials, queries or fragments. */
export type WebReadDiagnostics = {
  url?: string;
  finalUrl?: string;
  method?: "http" | "browser";
  attempts: WebReadAttempt[];
  failure?: WebReadFailureDetails;
};
const diagnosticUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
};
/** Copy only bounded diagnostic fields from an isolated reader response. */
export const webReadDiagnostics = (value: {
  url?: unknown;
  finalUrl?: unknown;
  method?: unknown;
  attempts?: unknown;
  failure?: unknown;
}): WebReadDiagnostics => ({
  failure: webReadFailureDetails(value.failure),
  url: diagnosticUrl(value.url),
  finalUrl: diagnosticUrl(value.finalUrl),
  method:
    value.method === "http" || value.method === "browser"
      ? value.method
      : undefined,
  attempts: Array.isArray(value.attempts)
    ? value.attempts.slice(0, 16).flatMap((attempt) => {
        if (
          !attempt ||
          typeof attempt !== "object" ||
          !["http", "browser"].includes(attempt.method) ||
          typeof attempt.status !== "string" ||
          !/^[a-z_]{1,64}$/u.test(attempt.status)
        )
          return [];
        return [
          {
            method: attempt.method as "http" | "browser",
            status: attempt.status,
            ...(webReadFailureDetails(attempt.failure)
              ? { failure: webReadFailureDetails(attempt.failure) }
              : {}),
            ...(Array.isArray(attempt.resourceFailures)
              ? {
                  resourceFailures: attempt.resourceFailures
                    .slice(0, 8)
                    .flatMap((v: unknown) => {
                      const safe = webReadFailureDetails(v);
                      return safe ? [safe] : [];
                    }),
                }
              : {}),
            ...(Number.isInteger(attempt.httpStatus) &&
            attempt.httpStatus >= 100 &&
            attempt.httpStatus <= 599
              ? { httpStatus: attempt.httpStatus as number }
              : {}),
            ...(Number.isInteger(attempt.extractedChars) &&
            attempt.extractedChars >= 0
              ? { extractedChars: attempt.extractedChars as number }
              : {}),
          },
        ];
      })
    : [],
});

// Package entrypoints are bundled independently; constructor identity is not shared.
const WEB_READ_ERROR = Symbol.for("@absolutejs/rag/WebReadError");
export class WebReadError extends Error {
  readonly [WEB_READ_ERROR] = true;
  constructor(
    public code: string,
    message: string,
    public diagnostics?: WebReadDiagnostics,
  ) {
    super(message);
    this.name = "WebReadError";
  }
}
export const isWebReadError = (error: unknown): error is WebReadError =>
  error instanceof Error &&
  Reflect.get(error, WEB_READ_ERROR) === true &&
  typeof Reflect.get(error, "code") === "string";
export const isPublicWebAddress = (address: string) =>
  isPublicNetworkAddress(address);
export type WebRedirect = {
  from: string;
  to: string;
  kind: "http" | "client";
  status?: number;
};
export type WebFetchResult = {
  redirects?: WebRedirect[];
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
};
export type WebFetchOptions = {
  signal?: AbortSignal;
  redirect?: "follow" | "manual";
  maxBytes?: number;
  maxHeaderBytes?: number;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
};
export const validatePublicWebUrl = (raw: string) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebReadError(
      "invalid_url",
      "Provide a valid public HTTP or HTTPS URL.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new WebReadError(
      "blocked_url",
      "Only public HTTP/HTTPS URLs on standard ports are supported.",
    );
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    host === "localhost" ||
    /\.(?:localhost|local|internal)$/u.test(host) ||
    (isIP(host) && !isPublicWebAddress(host))
  )
    throw new WebReadError(
      "blocked_url",
      "Private and local network destinations are not allowed.",
    );
  return url;
};
/** Pin the validated DNS answer into the connection, including every redirect. */
export const fetchPublicWebResource = async (
  raw: string,
  options: WebFetchOptions = {},
): Promise<WebFetchResult> => {
  const signal = options.signal ?? AbortSignal.timeout(15000);
  const maxBytes = options.maxBytes ?? 5_000_000;
  let url = validatePublicWebUrl(raw);
  const redirects: WebRedirect[] = [];
  let method = options.method ?? "GET";
  let body = options.body;
  for (let hop = 0; hop <= 5; hop++) {
    signal.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    const addresses = await lookup(host, { all: true }).catch((error) => {
      throw webTransportFailure(error, "dns");
    });
    if (
      !addresses.length ||
      addresses.some(({ address }) => !isPublicWebAddress(address))
    )
      throw new WebReadError(
        "blocked_url",
        "The destination resolved to a private or reserved network.",
      );
    signal.throwIfAborted();
    const selected =
      addresses.find(({ family }) => family === 4) ?? addresses[0]!;
    const incoming = await pinnedPublicRequest(
      new Request(url, {
        method,
        body,
        signal,
        headers: {
          "user-agent": "AbsoluteJSReader/1.0",
          accept: "*/*",
          "accept-encoding": "identity",
          ...options.headers,
          host: url.host,
        },
      }),
      {
        hostname: host,
        address: selected.address,
        maxResponseBytes: maxBytes,
        maxResponseHeaderBytes: options.maxHeaderBytes ?? 65_536,
      },
    ).catch((error) => {
      const failure = webTransportFailure(error, "request");
      if (failure.diagnostics?.failure) {
        if (failure.code === "response_headers_too_large")
          failure.diagnostics.failure.limitBytes =
            options.maxHeaderBytes ?? 65_536;
        if (failure.code === "response_body_too_large")
          failure.diagnostics.failure.limitBytes = maxBytes;
      }
      throw failure;
    });
    let data: Uint8Array = new Uint8Array(await incoming.arrayBuffer());
    const encoding = incoming.headers.get("content-encoding");
    const limits = { maxOutputLength: maxBytes };
    try {
      if (encoding === "gzip") data = gunzipSync(data, limits);
      else if (encoding === "br") data = brotliDecompressSync(data, limits);
      else if (encoding === "deflate") data = inflateSync(data, limits);
    } catch (error) {
      throw webTransportFailure(error, "decode", maxBytes);
    }
    const response: WebFetchResult = {
      url: url.href,
      status: incoming.status,
      headers: Object.fromEntries(
        [...incoming.headers].filter(
          ([key]) =>
            ![
              "content-encoding",
              "content-length",
              "transfer-encoding",
              "set-cookie",
            ].includes(key),
        ),
      ),
      body: data,
    };
    if (options.redirect === "manual") return response;
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      response.headers.location
    ) {
      const next = validatePublicWebUrl(
        new URL(response.headers.location, url).href,
      );
      redirects.push({
        from: url.href,
        to: next.href,
        kind: "http",
        status: response.status,
      });
      url = next;
      if (
        response.status === 303 ||
        ([301, 302].includes(response.status) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return { ...response, redirects };
  }
  throw new WebReadError(
    "redirect_limit",
    "The site exceeded the redirect limit.",
  );
};
