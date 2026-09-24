import { Elysia, t } from "elysia";
import type { ResearchRuntime, ResearchResult } from "./types";

const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export const renderResearchResult = (result: ResearchResult) =>
  `<section aria-label="Research result"><p>${escape(result.status)}</p><ul>${result.fields
    .map(
      (field) =>
        `<li><strong>${escape(field.value)}</strong> — ${escape(field.verdict)}${field.citations
          .map((citation) => {
            const source = result.sources.find(
              (source) => source.id === citation.sourceId,
            );
            if (!source || !/^https?:\/\//u.test(source.url)) return "";
            return ` <a href="${escape(source.url)}" rel="noopener noreferrer">${escape(source.title)}</a><blockquote>${escape(citation.quote)}</blockquote>`;
          })
          .join("")}</li>`,
    )
    .join(
      "",
    )}</ul>${result.limitations.map((message) => `<p>${escape(message)}</p>`).join("")}</section>`;

export type ResearchPluginOptions = {
  runtime:
    | ResearchRuntime
    | ((request: Request) => ResearchRuntime | Promise<ResearchRuntime>);
  /** Required for all routes, including HTML and streaming. Resolve identity before selecting tenant runtime. */
  authorize: (request: Request) => boolean | Promise<boolean>;
  path?: string;
};
const bodySchema = t.Object(
  {
    query: t.String({ minLength: 1, maxLength: 8000 }),
    task: t.Optional(t.String({ maxLength: 128 })),
    freshness: t.Optional(t.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);

export const researchPlugin = (options: ResearchPluginOptions) => {
  const path = options.path ?? "/research";
  const resolve = async (request: Request) => {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return null;
    if (!(await options.authorize(request))) return null;
    return typeof options.runtime === "function"
      ? options.runtime(request)
      : options.runtime;
  };
  return new Elysia({ name: `absolute-research:${path}` })
    .post(path, { body: bodySchema }, async ({ request, body }) => {
      const runtime = await resolve(request);
      if (!runtime) return new Response("Forbidden", { status: 403 });
      return Response.json(
        await runtime.run({ ...body, signal: request.signal }),
        { headers: { "cache-control": "no-store" } },
      );
    })
    .post(`${path}/html`, { body: bodySchema }, async ({ request, body }) => {
      const runtime = await resolve(request);
      if (!runtime) return new Response("Forbidden", { status: 403 });
      return new Response(
        renderResearchResult(
          await runtime.run({ ...body, signal: request.signal }),
        ),
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    })
    .post(`${path}/stream`, { body: bodySchema }, async ({ request, body }) => {
      const runtime = await resolve(request);
      if (!runtime) return new Response("Forbidden", { status: 403 });
      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      const encoder = new TextEncoder();
      let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(output) {
          const send = (event: unknown) => {
            if (!closed)
              output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };
          void runtime
            .run({
              ...body,
              signal,
              onProgress: (progress) => send({ type: "progress", progress }),
            })
            .then((result) => send({ type: "result", result }))
            .catch(() =>
              send({ type: "error", message: "Research request failed" }),
            )
            .finally(() => {
              if (!closed) {
                closed = true;
                output.close();
              }
            });
        },
        cancel() {
          closed = true;
          controller.abort();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        },
      });
    });
};
