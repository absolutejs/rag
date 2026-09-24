export type ResearchCheckpoint = {
  revision: number;
  value: unknown;
  fingerprint: string;
};
export type ResearchClaim = ResearchCheckpoint & { token: string };
export type ResearchDelivery = { id: string; key: string; payload: unknown };
export type ResearchWorkflowStore = {
  claim: (
    key: string,
    fingerprint: string,
    leaseMs: number,
  ) => Promise<ResearchClaim | null>;
  /** Commit state and append delivery records atomically, fenced against lease expiry and takeover. */
  commit: (
    key: string,
    claim: ResearchClaim,
    value: unknown,
    events?: ResearchDelivery[],
  ) => Promise<boolean>;
  release: (key: string, token: string) => Promise<void>;
  deliveries: (key: string, limit: number) => Promise<ResearchDelivery[]>;
  acknowledge: (key: string, id: string) => Promise<void>;
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
export const researchKey = async (value: unknown) => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};
export const createMemoryResearchWorkflowStore = (
  now: () => number = Date.now,
): ResearchWorkflowStore => {
  const rows = new Map<
    string,
    ResearchCheckpoint & { token: string | null; expires: number }
  >();
  const outbox = new Map<string, ResearchDelivery>();
  return {
    async claim(key, fingerprint, leaseMs) {
      const row = rows.get(key);
      if (row && row.fingerprint !== fingerprint)
        throw new Error("Workflow identity reused with different inputs");
      if (row?.token && row.expires > now()) return null;
      const next = {
        revision: row?.revision ?? 0,
        value: structuredClone(row?.value ?? null),
        fingerprint,
        token: crypto.randomUUID(),
        expires: now() + leaseMs,
      };
      rows.set(key, next);
      return structuredClone(next);
    },
    async commit(key, claim, value, events = []) {
      const row = rows.get(key);
      if (
        !row ||
        row.token !== claim.token ||
        row.revision !== claim.revision ||
        row.expires <= now()
      )
        return false;
      for (const event of events)
        if (event.key !== key) throw new Error("Delivery scope mismatch");
      rows.set(key, {
        ...row,
        value: structuredClone(value),
        revision: row.revision + 1,
        token: null,
        expires: 0,
      });
      for (const event of events)
        outbox.set(`${key}:${event.id}`, structuredClone(event));
      return true;
    },
    async release(key, token) {
      const row = rows.get(key);
      if (row?.token === token) row.token = null;
    },
    async deliveries(key, limit) {
      return structuredClone(
        [...outbox.values()]
          .filter((event) => event.key === key)
          .slice(0, limit),
      );
    },
    async acknowledge(key, id) {
      outbox.delete(`${key}:${id}`);
    },
  };
};

export type ResearchSqlClient = {
  unsafe: (
    query: string,
    parameters?: unknown[],
  ) => PromiseLike<Record<string, unknown>[]>;
};
export const researchWorkflowPostgresSchemaSql = () => `
CREATE TABLE IF NOT EXISTS absolute_research_workflows (
  key text PRIMARY KEY, fingerprint text NOT NULL, revision integer NOT NULL DEFAULT 0,
  value jsonb, token text, expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS absolute_research_deliveries (
  key text NOT NULL REFERENCES absolute_research_workflows(key), id text NOT NULL,
  payload jsonb NOT NULL, PRIMARY KEY(key,id)
);`;
/** SQL operations use database time and one fenced statement for state plus outbox. */
export const createPostgresResearchWorkflowStore = (
  sql: ResearchSqlClient,
): ResearchWorkflowStore => ({
  async claim(key, fingerprint, leaseMs) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
      throw new Error("Invalid workflow lease");
    const token = crypto.randomUUID();
    await sql.unsafe(
      "INSERT INTO absolute_research_workflows (key,fingerprint) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [key, fingerprint],
    );
    const rows = await sql.unsafe(
      `UPDATE absolute_research_workflows SET token=$3, expires_at=clock_timestamp()+($4::double precision * interval '1 millisecond') WHERE key=$1 AND fingerprint=$2 AND (token IS NULL OR expires_at <= clock_timestamp()) RETURNING revision,value,fingerprint`,
      [key, fingerprint, token, leaseMs],
    );
    if (rows[0])
      return {
        token,
        revision: Number(rows[0].revision),
        value: rows[0].value,
        fingerprint,
      };
    const existing = await sql.unsafe(
      "SELECT fingerprint FROM absolute_research_workflows WHERE key=$1",
      [key],
    );
    if (existing[0]?.fingerprint !== fingerprint)
      throw new Error("Workflow identity reused with different inputs");
    return null;
  },
  async commit(key, claim, value, events = []) {
    if (events.some((event) => event.key !== key))
      throw new Error("Delivery scope mismatch");
    const rows = await sql.unsafe(
      `WITH updated AS (
      UPDATE absolute_research_workflows SET value=$4::text::jsonb, revision=revision+1, token=NULL, expires_at=NULL
      WHERE key=$1 AND token=$2 AND revision=$3 AND expires_at>clock_timestamp() RETURNING key
    ), inserted AS (
      INSERT INTO absolute_research_deliveries (key,id,payload)
      SELECT updated.key,event->>'id',event->'payload' FROM updated CROSS JOIN jsonb_array_elements($5::text::jsonb) event
      ON CONFLICT DO NOTHING
    ) SELECT key FROM updated`,
      [
        key,
        claim.token,
        claim.revision,
        JSON.stringify(value),
        JSON.stringify(events),
      ],
    );
    return rows.length === 1;
  },
  async release(key, token) {
    await sql.unsafe(
      "UPDATE absolute_research_workflows SET token=NULL,expires_at=NULL WHERE key=$1 AND token=$2",
      [key, token],
    );
  },
  async deliveries(key, limit) {
    const rows = await sql.unsafe(
      "SELECT id,key,payload FROM absolute_research_deliveries WHERE key=$1 ORDER BY id LIMIT $2",
      [key, limit],
    );
    return rows.map((row) => ({
      id: String(row.id),
      key: String(row.key),
      payload: row.payload,
    }));
  },
  async acknowledge(key, id) {
    await sql.unsafe(
      "DELETE FROM absolute_research_deliveries WHERE key=$1 AND id=$2",
      [key, id],
    );
  },
});
