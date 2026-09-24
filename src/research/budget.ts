import type { ResearchConfig, ResearchOperation } from "./types";
type Admission = NonNullable<ResearchConfig["admit"]>;
type Outcome = Parameters<
  Exclude<Awaited<ReturnType<Admission>>, false>["settle"]
>[0];
/** Structural adapter for @absolutejs/billing/provider-budget; no second ledger. */
export type ResearchBudgetConfig = {
  ledger: {
    reserve: (input: {
      id: string;
      scope: string;
      period: string;
      reserveMicros: number;
      maxMicros: number;
      maxRequests: number;
    }) => Promise<boolean>;
    settle: (
      id: string,
      status: "fulfilled" | "rejected" | "unknown",
      actualMicros: number | null,
    ) => Promise<void>;
  };
  scope: string;
  period: () => string;
  maxMicros: number;
  maxRequests: number;
  /** Conservative ceilings for configured models, token limits, search and reader. */
  reserveMicros: Record<ResearchOperation, number>;
  actualMicros: (kind: ResearchOperation, outcome: Outcome) => number | null;
};
export const createResearchBudgetAdmission = (
  config: ResearchBudgetConfig,
): Admission => {
  if (!config.scope.trim())
    throw new Error(
      "Research budget requires an explicit tenant or public scope",
    );
  for (const value of [
    config.maxMicros,
    config.maxRequests,
    ...Object.values(config.reserveMicros),
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(
        "Research budget values must be nonnegative integer micros",
      );
  return async ({ kind, signal }) => {
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const reserveMicros = config.reserveMicros[kind];
    if (!Number.isSafeInteger(reserveMicros))
      throw new Error("Missing research operation price ceiling");
    if (
      !(await config.ledger.reserve({
        id,
        scope: config.scope,
        period: config.period(),
        reserveMicros,
        maxMicros: config.maxMicros,
        maxRequests: config.maxRequests,
      }))
    )
      return false;
    return {
      settle: async (outcome) => {
        const actual =
          outcome.status === "unknown"
            ? null
            : config.actualMicros(kind, outcome);
        if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0)) {
          await config.ledger.settle(id, "unknown", null);
          throw new Error("Invalid actual research cost");
        }
        await config.ledger.settle(
          id,
          actual === null ? "unknown" : "fulfilled",
          actual,
        );
        if (actual !== null && actual > reserveMicros)
          throw new Error(
            "Research price exceeded its configured reservation ceiling",
          );
      },
    };
  };
};
