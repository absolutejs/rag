import type {
  ResearchInput,
  ResearchResult,
  ResearchProgress,
} from "../research/types";
export type ResearchRequest = Pick<
  ResearchInput,
  "query" | "task" | "freshness"
>;
export type ResearchState = {
  status: "idle" | "running" | "complete" | "cancelled" | "error";
  result: ResearchResult | null;
  progress: ResearchProgress | null;
  error: string | null;
};
export type ResearchClientOptions = {
  path?: string;
  fetch?: typeof fetch;
  headers?: () => HeadersInit;
};
export const createResearchClient = (options: ResearchClientOptions = {}) => {
  let state: ResearchState = {
    status: "idle",
    result: null,
    progress: null,
    error: null,
  };
  let active: AbortController | undefined;
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: ResearchState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const cancel = () => {
    generation++;
    active?.abort();
    active = undefined;
    if (state.status === "running") publish({ ...state, status: "cancelled" });
  };
  const run = async (input: ResearchRequest): Promise<ResearchResult> => {
    active?.abort();
    const id = ++generation;
    const controller = new AbortController();
    active = controller;
    publish({ status: "running", result: null, progress: null, error: null });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const headers = new Headers(options.headers?.());
      headers.set("content-type", "application/json");
      const response = await (options.fetch ?? fetch)(
        `${options.path ?? "/research"}/stream`,
        {
          method: "POST",
          body: JSON.stringify(input),
          headers,
          credentials: "same-origin",
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body)
        throw new Error(`Research request failed (${response.status})`);
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let result: ResearchResult | undefined;
      const processLine = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === "error") throw new Error("Research request failed");
        if (event.type === "result") {
          if (
            !event.result ||
            !["reviewed", "partial", "empty", "unavailable"].includes(
              event.result.status,
            ) ||
            !Array.isArray(event.result.fields) ||
            !Array.isArray(event.result.sources)
          )
            throw new Error("Invalid research result");
          result = event.result;
        }
        if (event.type === "progress" && id === generation)
          publish({ ...state, progress: event.progress });
      };
      while (true) {
        controller.signal.throwIfAborted();
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value, { stream: !chunk.done });
        if (pending.length > 4_000_000)
          throw new Error("Research response too large");
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          processLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
        if (chunk.done) break;
      }
      if (pending) processLine(pending);
      controller.signal.throwIfAborted();
      if (!result) throw new Error("Research stream ended without a result");
      if (id === generation) publish({ ...state, status: "complete", result });
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
              : "Research request failed",
        });
      throw error;
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      if (id === generation) active = undefined;
    }
  };
  return {
    run,
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
      publish({ status: "idle", result: null, progress: null, error: null });
    },
    dispose: () => {
      cancel();
      listeners.clear();
    },
  };
};

/** HTML binding uses textContent, never model-produced HTML. Returns cleanup. */
export const bindResearchForm = (
  form: HTMLFormElement,
  output: HTMLElement,
  options: ResearchClientOptions = {},
) => {
  const client = createResearchClient(options);
  const unsubscribe = client.subscribe(() => {
    const state = client.getSnapshot();
    output.setAttribute("aria-busy", String(state.status === "running"));
    output.textContent = state.result
      ? JSON.stringify(state.result, null, 2)
      : (state.error ?? state.status);
  });
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const data = new FormData(form);
    void client
      .run({
        query: String(data.get("query") ?? ""),
        ...(data.get("task") ? { task: String(data.get("task")) } : {}),
      })
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
