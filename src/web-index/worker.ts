import type { WebIndexRuntime, WebIndexRun } from "./types";

export type WebIndexWorkerOptions = {
  runtime: WebIndexRuntime;
  generation?: string;
  intervalMs?: number;
  onRun?: (result: WebIndexRun) => void | Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
};
/** One local run at a time; database leases coordinate other hosts. Stop waits for admitted work. */
export const startWebIndexWorker = (options: WebIndexWorkerOptions) => {
  const interval = options.intervalMs ?? 60_000;
  if (
    !Number.isSafeInteger(interval) ||
    interval < 100 ||
    interval > 86_400_000
  )
    throw new Error("Invalid worker interval");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const tick = () => {
    running = (async () => {
      try {
        const report = await options.runtime.run({
          generation: options.generation,
          signal: controller.signal,
        });
        await options.onRun?.(report);
      } catch (error) {
        await options.onError(error);
      }
    })()
      .catch(() => {
        controller.abort();
      })
      .finally(() => {
        if (!controller.signal.aborted) timer = setTimeout(tick, interval);
      });
  };
  tick();
  return {
    get stopped() {
      return controller.signal.aborted;
    },
    stop: async () => {
      controller.abort();
      clearTimeout(timer);
      await running;
    },
  };
};
