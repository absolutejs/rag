import { Elysia, t } from "elysia";
import type { WebIndexRuntime } from "./types";

export type WebIndexOperation = "read" | "crawl" | "admin";
export type WebIndexPluginOptions = {
  /** Resolve authenticated identity to a server-configured tenant. Never select it from request data. */
  runtime:
    | WebIndexRuntime
    | ((request: Request) => WebIndexRuntime | Promise<WebIndexRuntime>);
  authorize: (
    request: Request,
    operation: WebIndexOperation,
  ) => boolean | Promise<boolean>;
  path?: string;
};
const generation = t.Optional(t.String({ minLength: 1, maxLength: 128 }));
const url = t.String({ minLength: 1, maxLength: 4096 });
const urlBody = t.Object({ url, generation }, { additionalProperties: false });
const generationBody = t.Object(
  { generation },
  { additionalProperties: false },
);
const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export const renderWebIndexStats = (stats: import("./types").WebIndexStats) =>
  `<section aria-label="Index status"><dl>${Object.entries(stats)
    .map(
      ([key, value]) =>
        `<dt>${escape(key)}</dt><dd>${escape(value ?? "Unknown")}</dd>`,
    )
    .join("")}</dl></section>`;
export const webIndexPlugin = (options: WebIndexPluginOptions) => {
  const path = options.path ?? "/web-index";
  const dispatch = async (
    request: Request,
    operation: WebIndexOperation,
    run: (runtime: WebIndexRuntime) => Promise<unknown>,
  ) => {
    const origin = request.headers.get("origin");
    if (
      (origin && origin !== new URL(request.url).origin) ||
      !(await options.authorize(request, operation))
    )
      return new Response("Forbidden", { status: 403 });
    const runtime =
      typeof options.runtime === "function"
        ? await options.runtime(request)
        : options.runtime;
    return Response.json(await run(runtime), {
      headers: { "cache-control": "no-store" },
    });
  };
  return new Elysia({ name: `absolute-web-index:${path}` })
    .get(`${path}/html`, async ({ request }) => {
      const response = await dispatch(request, "read", (runtime) =>
        runtime.stats(),
      );
      if (!response.ok) return response;
      return new Response(renderWebIndexStats(await response.json()), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    })
    .post(`${path}/stats`, { body: generationBody }, ({ request, body }) =>
      dispatch(request, "read", (runtime) => runtime.stats(body.generation)),
    )
    .post(`${path}/history`, { body: urlBody }, ({ request, body }) =>
      dispatch(request, "read", (runtime) =>
        runtime.history(body.url, body.generation),
      ),
    )
    .post(
      `${path}/search`,
      {
        body: t.Object(
          {
            query: t.String({ minLength: 1, maxLength: 8000 }),
            count: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
            mode: t.Optional(t.Union([t.Literal("web"), t.Literal("context")])),
          },
          { additionalProperties: false },
        ),
      },
      ({ request, body }) =>
        dispatch(request, "read", (runtime) =>
          runtime.search({
            ...body,
            mode: body.mode ?? "web",
            signal: request.signal,
          }),
        ),
    )
    .post(
      `${path}/projections`,
      {
        body: t.Object(
          {
            kind: t.Union([
              t.Literal("company"),
              t.Literal("person"),
              t.Literal("event"),
            ]),
            generation,
          },
          { additionalProperties: false },
        ),
      },
      ({ request, body }) =>
        dispatch(request, "read", (runtime) =>
          runtime.projections(body.kind, body.generation),
        ),
    )
    .post(
      `${path}/enqueue`,
      {
        body: t.Object(
          { urls: t.Array(url, { minItems: 1, maxItems: 1000 }), generation },
          { additionalProperties: false },
        ),
      },
      ({ request, body }) =>
        dispatch(request, "crawl", async (runtime) => ({
          enqueued: await runtime.enqueue(body.urls, body.generation),
        })),
    )
    .post(`${path}/run`, { body: generationBody }, ({ request, body }) =>
      dispatch(request, "crawl", (runtime) =>
        runtime.run({ generation: body.generation, signal: request.signal }),
      ),
    )
    .post(`${path}/remove`, { body: urlBody }, ({ request, body }) =>
      dispatch(request, "admin", async (runtime) => {
        await runtime.remove(body.url, body.generation);
        return { removed: true };
      }),
    )
    .post(`${path}/restore`, { body: urlBody }, ({ request, body }) =>
      dispatch(request, "admin", async (runtime) => {
        await runtime.restore(body.url, body.generation);
        return { restored: true };
      }),
    )
    .post(
      `${path}/rebuild`,
      {
        body: t.Object(
          {
            from: t.String({ minLength: 1, maxLength: 128 }),
            to: t.String({ minLength: 1, maxLength: 128 }),
            limit: t.Integer({ minimum: 1, maximum: 1000 }),
            after: t.Optional(url),
          },
          { additionalProperties: false },
        ),
      },
      ({ request, body }) =>
        dispatch(request, "admin", (runtime) =>
          runtime.rebuild(body.from, body.to, body.limit, body.after),
        ),
    )
    .post(
      `${path}/activate`,
      {
        body: t.Object(
          {
            generation: t.String({ minLength: 1, maxLength: 128 }),
            expected: t.String({ minLength: 1, maxLength: 128 }),
            evidence: t.String({ minLength: 1, maxLength: 8000 }),
          },
          { additionalProperties: false },
        ),
      },
      ({ request, body }) =>
        dispatch(request, "admin", async (runtime) => ({
          activated: await runtime.activate(body.generation, body.expected, {
            passed: true,
            evidence: body.evidence,
          }),
        })),
    );
};
