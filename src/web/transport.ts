import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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
export const isPublicWebAddress = (address: string) => {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const value = address.toLowerCase();
  return (
    isIP(value) === 6 &&
    /^[23]/u.test(value) &&
    !/^2001:(?:db8|0):/u.test(value) &&
    !value.startsWith("2002:")
  );
};
export type WebFetchResult = {
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
    const response = await new Promise<WebFetchResult>((resolve, reject) => {
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(
        {
          protocol: url.protocol,
          hostname: selected.address,
          family: selected.family,
          servername: isIP(host) ? undefined : host,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method,
          signal,
          agent: false,
          headers: {
            "user-agent": "onSparkReader/1.0 (+https://onspark.com)",
            accept: "*/*",
            "accept-encoding": "identity",
            ...options.headers,
            host: url.host,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("error", reject);
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              const error = new WebReadError(
                "too_large",
                "The response exceeded the website read limit.",
              );
              res.destroy(error);
              reject(error);
            } else chunks.push(chunk);
          });
          res.on("end", () => {
            try {
              let data: Uint8Array = Buffer.concat(chunks);
              const encoding = res.headers["content-encoding"];
              const limits = { maxOutputLength: maxBytes };
              if (encoding === "gzip") data = gunzipSync(data, limits);
              else if (encoding === "br")
                data = brotliDecompressSync(data, limits);
              else if (encoding === "deflate") data = inflateSync(data, limits);
              const headers = Object.fromEntries(
                Object.entries(res.headers)
                  .filter(
                    ([key]) =>
                      ![
                        "content-encoding",
                        "content-length",
                        "transfer-encoding",
                        "set-cookie",
                      ].includes(key),
                  )
                  .map(([key, value]) => [
                    key,
                    Array.isArray(value) ? value.join(", ") : (value ?? ""),
                  ]),
              );
              resolve({
                url: url.href,
                status: res.statusCode ?? 502,
                headers,
                body: data,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
    if (options.redirect === "manual") return response;
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      response.headers.location
    ) {
      url = validatePublicWebUrl(new URL(response.headers.location, url).href);
      if (
        response.status === 303 ||
        ([301, 302].includes(response.status) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return response;
  }
  throw new WebReadError(
    "redirect_limit",
    "The site exceeded the redirect limit.",
  );
};
