import type {
  WebIndexStore,
  WebIndexDocument,
  WebIndexLease,
  WebIndexStats,
  WebIndexProjection,
} from "./types";
export type WebIndexSql = {
  unsafe: (
    query: string,
    values?: unknown[],
  ) => PromiseLike<Record<string, unknown>[]>;
};
export type WebIndexDatabase = WebIndexSql & {
  begin: <T>(run: (sql: WebIndexSql) => Promise<T>) => Promise<T>;
};
export const webIndexPostgresSchemaSql = () => `
CREATE TABLE IF NOT EXISTS absolute_web_indexes (scope text PRIMARY KEY, active text NOT NULL);
CREATE TABLE IF NOT EXISTS absolute_web_takedowns (scope text NOT NULL REFERENCES absolute_web_indexes(scope), url text NOT NULL, PRIMARY KEY(scope,url));
CREATE TABLE IF NOT EXISTS absolute_web_generations (
 partition text PRIMARY KEY, scope text NOT NULL REFERENCES absolute_web_indexes(scope),
 generation text NOT NULL, fingerprint text NOT NULL, activation jsonb, UNIQUE(scope,generation));
CREATE TABLE IF NOT EXISTS absolute_web_origins (origin text PRIMARY KEY, token text, expires timestamptz, next_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS absolute_web_frontier (
 partition text NOT NULL REFERENCES absolute_web_generations(partition), url text NOT NULL, origin text NOT NULL REFERENCES absolute_web_origins(origin),
 depth integer NOT NULL, priority integer NOT NULL, next_at timestamptz NOT NULL DEFAULT now(),
 token text, expires timestamptz, attempts integer NOT NULL DEFAULT 0, error text, disabled boolean NOT NULL DEFAULT false,
 PRIMARY KEY(partition,url));
CREATE INDEX IF NOT EXISTS absolute_web_frontier_due ON absolute_web_frontier(partition,next_at,origin) WHERE NOT disabled;
CREATE TABLE IF NOT EXISTS absolute_web_documents (partition text NOT NULL, url text NOT NULL, version text, value jsonb, PRIMARY KEY(partition,url));
CREATE TABLE IF NOT EXISTS absolute_web_versions (partition text NOT NULL, url text NOT NULL, version text NOT NULL, value jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(partition,url,version));
CREATE TABLE IF NOT EXISTS absolute_web_projections (partition text NOT NULL, url text NOT NULL, version text NOT NULL, kind text NOT NULL, identity text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(partition,url,version,kind,identity));`;
const asDocument = (value: unknown) =>
  value == null ? null : (value as WebIndexDocument);
const milliseconds = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 31_536_000_000)
    throw new Error("Invalid index interval");
  return value;
};
const bound = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
    throw new Error("Invalid page size");
  return value;
};
export const createPostgresWebIndexStore = (
  db: WebIndexDatabase,
): WebIndexStore => {
  const fenced = async (sql: WebIndexSql, lease: WebIndexLease) => {
    const origin = await sql.unsafe(
      "SELECT origin FROM absolute_web_origins WHERE origin=$1 AND token=$2 AND expires>clock_timestamp() FOR UPDATE",
      [lease.origin, lease.token],
    );
    if (!origin.length) return false;
    const rows = await sql.unsafe(
      "SELECT url FROM absolute_web_frontier WHERE partition=$1 AND url=$2 AND token=$3 AND expires>clock_timestamp() AND NOT disabled FOR UPDATE",
      [lease.partition, lease.url, lease.token],
    );
    return rows.length > 0;
  };
  return {
    async register(scope, generation, partition, fingerprint) {
      await db.begin(async (sql) => {
        await sql.unsafe(
          "INSERT INTO absolute_web_indexes(scope,active) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [scope, generation],
        );
        await sql.unsafe(
          "INSERT INTO absolute_web_generations(partition,scope,generation,fingerprint) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [partition, scope, generation, fingerprint],
        );
        const rows = await sql.unsafe(
          "SELECT fingerprint FROM absolute_web_generations WHERE partition=$1 AND scope=$2 AND generation=$3",
          [partition, scope, generation],
        );
        if (rows[0]?.fingerprint !== fingerprint)
          throw new Error(
            "Index generation reused with incompatible embedding or crawl configuration",
          );
      });
    },
    async active(scope) {
      const rows = await db.unsafe(
        "SELECT active FROM absolute_web_indexes WHERE scope=$1",
        [scope],
      );
      return typeof rows[0]?.active === "string" ? rows[0].active : null;
    },
    async activate(scope, generation, expected, report) {
      if (report.passed !== true || !report.evidence.trim())
        throw new Error("A passing generation evaluation is required");
      return db.begin(async (sql) => {
        const rows = await sql.unsafe(
          "UPDATE absolute_web_indexes SET active=$2 WHERE scope=$1 AND active=$3 AND EXISTS(SELECT 1 FROM absolute_web_generations WHERE scope=$1 AND generation=$2) RETURNING scope",
          [scope, generation, expected],
        );
        if (!rows.length) return false;
        await sql.unsafe(
          "UPDATE absolute_web_generations SET activation=$3::text::jsonb WHERE scope=$1 AND generation=$2",
          [scope, generation, JSON.stringify(report)],
        );
        return true;
      });
    },
    async enqueue(partition, items, maxUrls) {
      if (!Number.isSafeInteger(maxUrls) || maxUrls < 1)
        throw new Error("Invalid corpus size limit");
      return db.begin(async (sql) => {
        const locked = await sql.unsafe(
          "SELECT partition FROM absolute_web_generations WHERE partition=$1 FOR UPDATE",
          [partition],
        );
        if (!locked.length) throw new Error("Unknown index generation");
        const counts = await sql.unsafe(
          "SELECT count(*)::int AS count FROM absolute_web_frontier WHERE partition=$1",
          [partition],
        );
        let count = Number(counts[0]?.count ?? 0),
          inserted = 0;
        for (const item of items) {
          if (count >= maxUrls) break;
          await sql.unsafe(
            "INSERT INTO absolute_web_origins(origin) VALUES($1) ON CONFLICT DO NOTHING",
            [item.origin],
          );
          const rows = await sql.unsafe(
            "INSERT INTO absolute_web_frontier(partition,url,origin,depth,priority) SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS(SELECT 1 FROM absolute_web_takedowns t JOIN absolute_web_generations g ON g.scope=t.scope WHERE g.partition=$1 AND t.url=$2) ON CONFLICT DO NOTHING RETURNING url",
            [partition, item.url, item.origin, item.depth, item.priority],
          );
          count += rows.length;
          inserted += rows.length;
        }
        return inserted;
      });
    },
    async claim(partition, leaseMs) {
      milliseconds(leaseMs);
      return db.begin(async (sql) => {
        const origins = await sql.unsafe(
          `SELECT o.origin FROM absolute_web_origins o WHERE o.next_at<=clock_timestamp() AND (o.token IS NULL OR o.expires<=clock_timestamp())
          AND EXISTS(SELECT 1 FROM absolute_web_frontier q WHERE q.partition=$1 AND q.origin=o.origin AND NOT q.disabled AND q.next_at<=clock_timestamp() AND (q.token IS NULL OR q.expires<=clock_timestamp()))
          ORDER BY o.next_at,o.origin LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
          [partition],
        );
        if (!origins.length) return null;
        const origin = String(origins[0]!.origin);
        const rows = await sql.unsafe(
          `SELECT q.*,d.value AS document FROM absolute_web_frontier q LEFT JOIN absolute_web_documents d ON d.partition=q.partition AND d.url=q.url
          WHERE q.partition=$1 AND q.origin=$2 AND NOT q.disabled AND q.next_at<=clock_timestamp() AND (q.token IS NULL OR q.expires<=clock_timestamp()) ORDER BY q.priority DESC,q.next_at,q.url LIMIT 1 FOR UPDATE OF q SKIP LOCKED`,
          [partition, origin],
        );
        if (!rows.length) return null;
        const row = rows[0]!,
          token = crypto.randomUUID();
        await sql.unsafe(
          "UPDATE absolute_web_frontier SET token=$3,expires=clock_timestamp()+$4::double precision*interval '1 millisecond',attempts=attempts+1 WHERE partition=$1 AND url=$2",
          [partition, row.url, token, leaseMs],
        );
        await sql.unsafe(
          "UPDATE absolute_web_origins SET token=$2,expires=clock_timestamp()+$3::double precision*interval '1 millisecond' WHERE origin=$1",
          [origin, token, leaseMs],
        );
        return {
          partition,
          url: String(row.url),
          origin,
          token,
          depth: Number(row.depth),
          attempts: Number(row.attempts) + 1,
          document: asDocument(row.document),
        };
      });
    },
    async gateOrigin(origin, token, leaseMs, delayMs) {
      milliseconds(leaseMs);
      milliseconds(delayMs);
      await db.unsafe(
        "INSERT INTO absolute_web_origins(origin) VALUES($1) ON CONFLICT DO NOTHING",
        [origin],
      );
      const rows = await db.unsafe(
        "UPDATE absolute_web_origins SET token=$2,expires=clock_timestamp()+$3::double precision*interval '1 millisecond',next_at=clock_timestamp()+$4::double precision*interval '1 millisecond' WHERE origin=$1 AND (token=$2 OR token IS NULL OR expires<=clock_timestamp()) AND next_at<=clock_timestamp() RETURNING origin",
        [origin, token, leaseMs, delayMs],
      );
      if (rows.length) return 0;
      const pending = await db.unsafe(
        "SELECT greatest(1,ceil(extract(epoch from(next_at-clock_timestamp()))*1000)) AS wait FROM absolute_web_origins WHERE origin=$1 AND (token=$2 OR token IS NULL OR expires<=clock_timestamp())",
        [origin, token],
      );
      return pending.length ? Number(pending[0]!.wait) : null;
    },
    async deferOrigin(origin, token, delayMs) {
      milliseconds(delayMs);
      await db.unsafe(
        "UPDATE absolute_web_origins SET next_at=greatest(next_at,clock_timestamp()+$3::double precision*interval '1 millisecond') WHERE origin=$1 AND token=$2",
        [origin, token, delayMs],
      );
    },
    async releaseOrigins(token, delayMs) {
      milliseconds(delayMs);
      await db.unsafe(
        "UPDATE absolute_web_origins SET token=NULL,expires=NULL,next_at=greatest(next_at,clock_timestamp()+$2::double precision*interval '1 millisecond') WHERE token=$1",
        [token, delayMs],
      );
    },
    async finish(lease, document, nextFetchMs, delayMs) {
      milliseconds(nextFetchMs);
      milliseconds(delayMs);
      return db.begin(async (sql) => {
        if (!(await fenced(sql, lease))) return false;
        if (!document) {
          await sql.unsafe(
            "UPDATE absolute_web_documents SET version=NULL,value=NULL WHERE url=$2 AND partition IN(SELECT partition FROM absolute_web_generations WHERE scope=(SELECT scope FROM absolute_web_generations WHERE partition=$1))",
            [lease.partition, lease.url],
          );
          await sql.unsafe(
            "UPDATE absolute_web_frontier SET token=NULL,expires=NULL WHERE partition<>$1 AND url=$2 AND partition IN(SELECT partition FROM absolute_web_generations WHERE scope=(SELECT scope FROM absolute_web_generations WHERE partition=$1))",
            [lease.partition, lease.url],
          );
        }
        if (document)
          await sql.unsafe(
            "INSERT INTO absolute_web_versions(partition,url,version,value) VALUES($1,$2,$3,$4::text::jsonb) ON CONFLICT DO NOTHING",
            [
              lease.partition,
              lease.url,
              document.version,
              JSON.stringify(document),
            ],
          );
        await sql.unsafe(
          "INSERT INTO absolute_web_documents(partition,url,version,value) VALUES($1,$2,$3,$4::text::jsonb) ON CONFLICT(partition,url) DO UPDATE SET version=excluded.version,value=excluded.value",
          [
            lease.partition,
            lease.url,
            document?.version ?? null,
            document ? JSON.stringify(document) : null,
          ],
        );
        await sql.unsafe(
          "UPDATE absolute_web_frontier SET token=NULL,expires=NULL,attempts=0,error=NULL,next_at=clock_timestamp()+$3::double precision*interval '1 millisecond' WHERE partition=$1 AND url=$2",
          [lease.partition, lease.url, nextFetchMs],
        );
        await sql.unsafe(
          "UPDATE absolute_web_origins SET token=NULL,expires=NULL,next_at=clock_timestamp()+$2::double precision*interval '1 millisecond' WHERE origin=$1 AND token=$3",
          [lease.origin, delayMs, lease.token],
        );
        return true;
      });
    },
    async fail(lease, error, retryMs, delayMs) {
      milliseconds(retryMs);
      milliseconds(delayMs);
      return db.begin(async (sql) => {
        if (!(await fenced(sql, lease))) return false;
        await sql.unsafe(
          "UPDATE absolute_web_frontier SET token=NULL,expires=NULL,error=$3,next_at=clock_timestamp()+$4::double precision*interval '1 millisecond' WHERE partition=$1 AND url=$2",
          [lease.partition, lease.url, error.slice(0, 1000), retryMs],
        );
        await sql.unsafe(
          "UPDATE absolute_web_origins SET token=NULL,expires=NULL,next_at=clock_timestamp()+$2::double precision*interval '1 millisecond' WHERE origin=$1 AND token=$3",
          [lease.origin, delayMs, lease.token],
        );
        return true;
      });
    },
    async document(partition, url) {
      const rows = await db.unsafe(
        "SELECT value FROM absolute_web_documents WHERE partition=$1 AND url=$2",
        [partition, url],
      );
      return asDocument(rows[0]?.value);
    },
    async lookup(partition, urls) {
      if (urls.length > 500) throw new Error("Document lookup limit exceeded");
      if (!urls.length) return [];
      const rows = await db.unsafe(
        "SELECT value FROM absolute_web_documents WHERE partition=$1 AND value IS NOT NULL AND url IN (SELECT jsonb_array_elements_text($2::text::jsonb))",
        [partition, JSON.stringify(urls)],
      );
      return rows.map((row) => asDocument(row.value)!);
    },
    async documents(partition, limit, after = "") {
      return (
        await db.unsafe(
          "SELECT value FROM absolute_web_documents WHERE partition=$1 AND url>$2 AND value IS NOT NULL ORDER BY url LIMIT $3",
          [partition, after, bound(limit)],
        )
      ).map((row) => asDocument(row.value)!);
    },
    async history(partition, url, limit) {
      return (
        await db.unsafe(
          "SELECT value FROM absolute_web_versions WHERE partition=$1 AND url=$2 ORDER BY created_at DESC LIMIT $3",
          [partition, url, bound(limit)],
        )
      ).map((row) => asDocument(row.value)!);
    },
    async remove(partition, url, permanent) {
      await db.begin(async (sql) => {
        const generations = await sql.unsafe(
          "SELECT scope FROM absolute_web_generations WHERE partition=$1",
          [partition],
        );
        if (!generations.length) return;
        const scope = generations[0]!.scope;
        if (permanent)
          await sql.unsafe(
            "INSERT INTO absolute_web_takedowns(scope,url) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [scope, url],
          );
        await sql.unsafe(
          "UPDATE absolute_web_frontier SET disabled=$3,token=NULL,expires=NULL WHERE url=$2 AND partition IN(SELECT partition FROM absolute_web_generations WHERE scope=$1)",
          [scope, url, permanent],
        );
        await sql.unsafe(
          "UPDATE absolute_web_documents SET version=NULL,value=NULL WHERE url=$2 AND partition IN(SELECT partition FROM absolute_web_generations WHERE scope=$1)",
          [scope, url],
        );
        await sql.unsafe(
          "DELETE FROM absolute_web_versions WHERE url=$2 AND partition IN(SELECT partition FROM absolute_web_generations WHERE scope=$1)",
          [scope, url],
        );
        await sql.unsafe(
          "DELETE FROM absolute_web_projections WHERE url=$2 AND partition IN(SELECT partition FROM absolute_web_generations WHERE scope=$1)",
          [scope, url],
        );
      });
    },
    async restore(partition, url) {
      await db.begin(async (sql) => {
        const rows = await sql.unsafe(
          "SELECT scope FROM absolute_web_generations WHERE partition=$1",
          [partition],
        );
        if (!rows.length) return;
        await sql.unsafe(
          "DELETE FROM absolute_web_takedowns WHERE scope=$1 AND url=$2",
          [rows[0]!.scope, url],
        );
        await sql.unsafe(
          "UPDATE absolute_web_frontier SET disabled=false,next_at=clock_timestamp() WHERE url=$2 AND partition IN(SELECT partition FROM absolute_web_generations WHERE scope=$1)",
          [rows[0]!.scope, url],
        );
      });
    },
    async stats(partition) {
      const rows = await db.unsafe(
        `SELECT (SELECT count(*)::int FROM absolute_web_frontier WHERE partition=$1) AS urls,
        count(*) FILTER(WHERE value IS NOT NULL)::int AS documents,count(*) FILTER(WHERE value IS NULL)::int AS tombstones,
        min(value->>'fetchedAt') AS oldest,max(value->>'fetchedAt') AS newest,
        (SELECT count(*)::int FROM absolute_web_frontier WHERE partition=$1 AND error IS NOT NULL) AS failed,
        (SELECT count(*)::int FROM absolute_web_frontier WHERE partition=$1 AND NOT disabled AND next_at<=clock_timestamp()) AS pending FROM absolute_web_documents WHERE partition=$1`,
        [partition],
      );
      const r = rows[0]!;
      return {
        urls: Number(r.urls),
        documents: Number(r.documents),
        tombstones: Number(r.tombstones),
        pending: Number(r.pending),
        failed: Number(r.failed),
        oldestFetchedAt: r.oldest as string | null,
        newestFetchedAt: r.newest as string | null,
      } satisfies WebIndexStats;
    },
    async saveProjection(partition, url, version, projection) {
      return db.begin(async (sql) => {
        const rows = await sql.unsafe(
          "SELECT version FROM absolute_web_documents WHERE partition=$1 AND url=$2 AND version=$3 FOR UPDATE",
          [partition, url, version],
        );
        if (!rows.length) return false;
        await sql.unsafe(
          "INSERT INTO absolute_web_projections(partition,url,version,kind,identity,value) VALUES($1,$2,$3,$4,$5,$6::text::jsonb) ON CONFLICT(partition,url,version,kind,identity) DO UPDATE SET value=excluded.value",
          [
            partition,
            url,
            version,
            projection.kind,
            projection.identity,
            JSON.stringify(projection),
          ],
        );
        return true;
      });
    },
    async projections(partition, kind, limit) {
      const rows = await db.unsafe(
        "SELECT p.value,p.url,p.version,d.value->>'fetchedAt' AS fetched FROM absolute_web_projections p JOIN absolute_web_documents d ON d.partition=p.partition AND d.url=p.url AND d.version=p.version WHERE p.partition=$1 AND p.kind=$2 ORDER BY p.identity,p.url LIMIT $3",
        [partition, kind, bound(limit)],
      );
      return rows.map((row) => ({
        ...(row.value as WebIndexProjection),
        url: String(row.url),
        version: String(row.version),
        fetchedAt: String(row.fetched),
      }));
    },
  };
};
