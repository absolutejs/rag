import type { SearchResult } from "@absolutejs/search";
import type {
  WebIndexDocument,
  WebIndexProjection,
  WebIndexRun,
  WebIndexStats,
} from "../web-index/types";
export type WebIndexRequests = {
  stats: { generation?: string };
  history: { url: string; generation?: string };
  search: { query: string; count?: number; mode?: "web" | "context" };
  projections: { kind: "company" | "person" | "event"; generation?: string };
  enqueue: { urls: string[]; generation?: string };
  run: { generation?: string };
  remove: { url: string; generation?: string };
  restore: { url: string; generation?: string };
  rebuild: { from: string; to: string; limit: number; after?: string };
  activate: { generation: string; expected: string; evidence: string };
};
export type WebIndexResponses = {
  stats: WebIndexStats;
  history: WebIndexDocument[];
  search: SearchResult;
  projections: Array<
    WebIndexProjection & { url: string; version: string; fetchedAt: string }
  >;
  enqueue: { enqueued: number };
  run: WebIndexRun;
  remove: { removed: true };
  restore: { restored: true };
  rebuild: { enqueued: number; next?: string };
  activate: { activated: boolean };
};
export type WebIndexClientState = {
  status: "idle" | "running" | "complete" | "cancelled" | "error";
  operation: keyof WebIndexRequests | null;
  result: WebIndexResponses[keyof WebIndexResponses] | null;
  error: string | null;
};
export type WebIndexClientOptions = {
  path?: string;
  fetch?: typeof fetch;
  headers?: () => HeadersInit;
};
/** One foreground operation per client. Superseding a call cancels its request, not already committed work. */
export const createWebIndexClient = (options: WebIndexClientOptions = {}) => {
  let state: WebIndexClientState = {
    status: "idle",
    operation: null,
    result: null,
    error: null,
  };
  let active: AbortController | undefined;
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: WebIndexClientState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const cancel = () => {
    generation++;
    active?.abort();
    active = undefined;
    if (state.status === "running") publish({ ...state, status: "cancelled" });
  };
  const call = async <K extends keyof WebIndexRequests>(
    operation: K,
    input: WebIndexRequests[K],
  ): Promise<WebIndexResponses[K]> => {
    active?.abort();
    const id = ++generation;
    const controller = new AbortController();
    active = controller;
    publish({ status: "running", operation, result: null, error: null });
    try {
      const headers = new Headers(options.headers?.());
      headers.set("content-type", "application/json");
      const response = await (options.fetch ?? fetch)(
        `${options.path ?? "/web-index"}/${operation}`,
        {
          method: "POST",
          body: JSON.stringify(input),
          headers,
          credentials: "same-origin",
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw new Error(`Index request failed (${response.status})`);
      const result: WebIndexResponses[K] = await response.json();
      controller.signal.throwIfAborted();
      if (id === generation)
        publish({ status: "complete", operation, result, error: null });
      return result;
    } catch (error) {
      if (id === generation)
        publish({
          ...state,
          status: controller.signal.aborted ? "cancelled" : "error",
          error: controller.signal.aborted
            ? null
            : error instanceof Error
              ? error.message
              : "Index request failed",
        });
      throw error;
    } finally {
      if (id === generation) active = undefined;
    }
  };
  return {
    call,
    cancel,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset: () => {
      cancel();
      publish({ status: "idle", operation: null, result: null, error: null });
    },
    dispose: () => {
      cancel();
      listeners.clear();
    },
  };
};
export const bindWebIndexSearchForm = (
  form: HTMLFormElement,
  output: HTMLElement,
  options: WebIndexClientOptions = {},
) => {
  const client = createWebIndexClient(options);
  const unsubscribe = client.subscribe(() => {
    const state = client.getSnapshot();
    output.setAttribute("aria-busy", String(state.status === "running"));
    output.textContent = state.result
      ? JSON.stringify(state.result, null, 2)
      : (state.error ?? state.status);
  });
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    void client
      .call("search", { query: String(new FormData(form).get("query") ?? "") })
      .catch(() => undefined);
  };
  form.addEventListener("submit", submit);
  return {
    ...client,
    dispose: () => {
      form.removeEventListener("submit", submit);
      unsubscribe();
      client.dispose();
    },
  };
};
