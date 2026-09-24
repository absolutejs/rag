import robotsParser from "robots-parser";
import { fetchPublicWebResource, validatePublicWebUrl, WebReadError } from "../web/transport";
import type { WebFetchResult } from "../web/transport";

export type DiscoveryFetch = (url: string) => Promise<Response>;
const agent = "AbsoluteJSReader/1.0";
const asResponse = (result: WebFetchResult) => {
  const response = new Response([204, 205, 304].includes(result.status) ? null : new Uint8Array(result.body), {
    status: result.status, headers: result.headers,
  });
  Object.defineProperty(response, "url", { value: result.url });
  return response;
};

/** One sync run owns this cache; failures abort reconciliation rather than deleting unseen documents. */
export const createDiscoveryTransport = (
  resource: typeof fetchPublicWebResource = fetchPublicWebResource,
  respectRobots = false,
) => {
  const policies = new Map<string, Promise<ReturnType<typeof robotsParser>>>();
  const policy = (raw: string) => {
    const url = new URL("/robots.txt", validatePublicWebUrl(raw));
    let pending = policies.get(url.origin);
    if (!pending) {
      pending = (async () => {
        const result = await resource(url.href, {
          maxBytes: 512_000, headers: { "user-agent": agent },
        });
        if (result.status === 429 || result.status >= 500 || result.status < 200 ||
          (result.status >= 300 && result.status < 400))
          throw new WebReadError("robots_unreachable", `Cannot establish robots policy for ${url.origin}: ${result.status}`);
        const text = result.status >= 400 ? "" : new TextDecoder().decode(result.body);
        return robotsParser(url.href, text);
      })();
      policies.set(url.origin, pending);
    }
    return pending;
  };
  const allowed = async (url: string) =>
    (await policy(url)).isAllowed(url, agent) === true;
  const get: DiscoveryFetch = async (raw) => {
    let url = validatePublicWebUrl(raw);
    for (let hop = 0; hop <= 5; hop++) {
      // robots itself is implicitly allowed. Redirect targets still undergo public-address validation.
      if (respectRobots && url.pathname !== "/robots.txt" && !(await allowed(url.href)))
        throw new WebReadError("robots_denied", `Robots policy disallows ${url.href}`);
      const result = await resource(url.href, {
        redirect: "manual", maxBytes: 5_000_000, headers: { "user-agent": agent },
      });
      if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
        url = validatePublicWebUrl(new URL(result.headers.location, url).href);
        continue;
      }
      return asResponse(result);
    }
    throw new WebReadError("redirect_limit", "Discovery exceeded five redirects");
  };
  return { get, allowed, policy };
};
