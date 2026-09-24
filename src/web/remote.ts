/** Typed boundary for a host-managed isolated website reader. The service URL is
 * trusted host configuration; public destination validation stays in the reader. */
export type WebsiteServiceResult = Record<string, unknown> & {
  status: "ok" | "partial" | "error";
  text: string;
  limitations?: string[];
  sources?: { url: string; title?: string; citation?: string }[];
};
export const parseWebsiteServiceResult = (
  value: unknown,
): WebsiteServiceResult => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Website reader returned an invalid response");
  const row = value as Record<string, unknown>;
  if (
    typeof row.text !== "string" ||
    !["ok", "partial", "error"].includes(String(row.status))
  )
    throw new Error("Website reader returned an invalid response");
  if (
    row.limitations !== undefined &&
    (!Array.isArray(row.limitations) ||
      !row.limitations.every((item) => typeof item === "string"))
  )
    throw new Error("Invalid website limitations");
  if (
    row.sources !== undefined &&
    (!Array.isArray(row.sources) ||
      !row.sources.every((source) => {
        if (
          !source ||
          typeof source !== "object" ||
          typeof source.url !== "string"
        )
          return false;
        try {
          const url = new URL(source.url);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      }))
  )
    throw new Error("Invalid website sources");
  return row as WebsiteServiceResult;
};
export const createWebsiteReaderClient =
  (options: {
    endpoint: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    fallbackReserveMs?: number;
    fallback: (input: {
      url: string;
      maxPages: number;
      mode: "auto" | "browser";
      signal: AbortSignal;
    }) => Promise<WebsiteServiceResult>;
  }) =>
  async (input: {
    url: string;
    maxPages?: number;
    mode?: "auto" | "browser";
    signal?: AbortSignal;
  }) => {
    const timeoutMs = options.timeoutMs ?? 85000,
      reserveMs = options.fallbackReserveMs ?? 15000;
    if (!(reserveMs > 0 && timeoutMs > reserveMs))
      throw new Error("Reader deadline must reserve fallback time");
    const signal = AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);
    signal.throwIfAborted();
    const request = {
      url: input.url,
      maxPages: input.maxPages ?? 8,
      mode: input.mode ?? ("auto" as const),
    };
    if (
      !Number.isInteger(request.maxPages) ||
      request.maxPages < 1 ||
      request.maxPages > 12
    )
      throw new Error("Reader page limit must be 1–12");
    try {
      const response = await (options.fetch ?? fetch)(options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(timeoutMs - reserveMs),
        ]),
      });
      if (response.status === 503)
        return {
          status: "error" as const,
          text: "",
          error: {
            code: "reader_busy",
            message:
              "Website reader is busy. Retry shortly; this is not evidence of missing information.",
            retryAfterSeconds: 2,
          },
        };
      if (!response.ok)
        throw new Error(`Website reader returned ${response.status}`);
      const result = parseWebsiteServiceResult(await response.json());
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      const result = parseWebsiteServiceResult(
        await options.fallback({ ...request, signal }),
      );
      signal.throwIfAborted();
      return {
        ...result,
        limitations: [
          ...(result.limitations ?? []),
          "Browser service unavailable; static fallback may omit JavaScript-only evidence.",
        ],
      };
    }
  };
