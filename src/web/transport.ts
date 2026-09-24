import {
  isPublicNetworkAddress,
  pinnedPublicRequest,
} from "@absolutejs/egress/transport";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export class WebReadError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "WebReadError";
  }
}
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
    const addresses = await lookup(host, { all: true });
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
      { hostname: host, address: selected.address, maxResponseBytes: maxBytes },
    );
    let data: Uint8Array = new Uint8Array(await incoming.arrayBuffer());
    const encoding = incoming.headers.get("content-encoding");
    const limits = { maxOutputLength: maxBytes };
    if (encoding === "gzip") data = gunzipSync(data, limits);
    else if (encoding === "br") data = brotliDecompressSync(data, limits);
    else if (encoding === "deflate") data = inflateSync(data, limits);
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
