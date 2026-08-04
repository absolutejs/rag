// Owner-scoped corpus reconciliation.
//
// Every RAG host eventually needs the same three-way answer: given what a
// PERSON (or tenant, or workspace) should have embedded right now, versus what
// is actually embedded for them — what must be embedded, what must be deleted,
// and what can be left alone.
//
// Hosts routinely build the first two thirds and skip the third. An ingest pass
// that only upserts leaves a vector behind every time a source record is
// deleted, reclassified as noise, or filtered out by a rule that did not exist
// when it was embedded. Those vectors keep matching queries forever, and once
// the source row is gone their ids can no longer be enumerated, so nothing can
// ever address them again. The corpus silently accumulates content the owner
// believes is gone — a retrieval-quality problem and, when the source was
// personal data the owner asked to delete, a compliance one.
//
// Reconciliation needs one thing an append-only digest table cannot give you:
// the ability to list what an owner currently has. That is why `list` is part
// of the store contract rather than an optimisation.

/** One embedded chunk, as the host has it recorded. */
export type RAGCorpusRecord = {
  chunkId: string;
  /** Hash of the exact text that was embedded, so a content change is
   *  detectable without storing the text twice. */
  textHash: string;
};

/** One chunk the owner should have embedded right now. */
export type RAGCorpusDocument = {
  chunkId: string;
  text: string;
};

/**
 * Host-owned persistence for what is embedded, scoped by owner.
 *
 * `Owner` is whatever identifies the subject in the host's model — a profile
 * id, a tenant id, a workspace key.
 */
export type RAGCorpusStore<Owner = string> = {
  /** Every chunk currently recorded as embedded for this owner. */
  list: (owner: Owner) => Promise<RAGCorpusRecord[]> | RAGCorpusRecord[];
  /** Record chunks as embedded. Must be an upsert on chunkId. */
  remember: (
    owner: Owner,
    records: RAGCorpusRecord[],
  ) => Promise<void> | void;
  /** Forget chunks. Called only AFTER their vectors are gone, so a crash
   *  in between leaves a re-deletable record rather than an orphan. */
  forget: (owner: Owner, chunkIds: string[]) => Promise<void> | void;
};

/** What a reconcile would do, without doing it. */
export type RAGCorpusPlan = {
  /** New or content-changed — these cost embedding tokens. */
  embed: RAGCorpusDocument[];
  /** Recorded for this owner but no longer desired — delete their vectors. */
  remove: string[];
  /** Already embedded with identical text; skipped, and free. */
  unchanged: number;
};

/** SHA-256 of the text, as `RAGCorpusRecord.textHash`. */
export const corpusTextHash = async (text: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Diff desired against stored. Pure — no embedding, no deletion, no I/O beyond
 * the store's `list`, so a host can show the cost of a pass before paying it.
 *
 * Identical duplicate chunk ids are collapsed. Conflicting text for the same
 * id is rejected because silently choosing either value corrupts reconciliation.
 */
export const planRAGCorpus = async <Owner = string>(
  store: RAGCorpusStore<Owner>,
  owner: Owner,
  desired: RAGCorpusDocument[],
): Promise<RAGCorpusPlan> => {
  const wanted = new Map<string, RAGCorpusDocument>();
  for (const doc of desired) {
    const existing = wanted.get(doc.chunkId);
    if (existing && existing.text !== doc.text) {
      throw new Error(
        `Conflicting RAG corpus documents share chunkId "${doc.chunkId}".`,
      );
    }
    if (!existing) wanted.set(doc.chunkId, doc);
  }

  const stored = new Map(
    (await store.list(owner)).map((record) => [record.chunkId, record.textHash]),
  );

  const embed: RAGCorpusDocument[] = [];
  let unchanged = 0;
  for (const [chunkId, doc] of wanted) {
    const hash = await corpusTextHash(doc.text);
    if (stored.get(chunkId) === hash) unchanged += 1;
    else embed.push(doc);
  }

  return {
    embed,
    remove: [...stored.keys()].filter((chunkId) => !wanted.has(chunkId)),
    unchanged,
  };
};

export type RAGCorpusApply<Owner = string> = {
  /**
   * Embed + upsert these chunks.
   *
   * Return a COUNT only when the whole plan was written — the count is then
   * taken at its word and every planned chunk is recorded as embedded. If the
   * pass can stop early (a budget ceiling, an abort signal, a partial failure
   * it chooses to swallow), return the chunk ids actually written instead.
   *
   * Getting this wrong is silent and permanent: a chunk recorded as embedded
   * that was not will match `unchanged` on every later pass, so it is never
   * embedded again until its source text happens to change. Reporting ids is
   * always safe; reporting a count is a promise the caller cannot verify.
   */
  embed: (
    docs: RAGCorpusDocument[],
    owner: Owner,
  ) => Promise<number | readonly string[]> | number | readonly string[];
  /** Delete these chunk ids from the vector store. */
  remove: (chunkIds: string[], owner: Owner) => Promise<void> | void;
};

export type RAGCorpusResult = {
  embedded: number;
  removed: number;
  unchanged: number;
};

/**
 * Bring an owner's embedded corpus in line with what they should have.
 *
 * Ordering is deliberate. Deletions run FIRST and their records are forgotten
 * only after the vectors are gone: a crash mid-pass then leaves a record whose
 * vector may already be deleted, which a later pass simply deletes again
 * (harmless), rather than a vector whose record is gone — which nothing could
 * ever find. Embedding records its digests after the write for the same reason,
 * so an interrupted run never claims to have embedded something it did not.
 */
/** Hoisted out of the filter predicate: building the set per document turned a
 *  full re-embed into an O(n^2) blocking loop on the hottest path there is. */
const filterToWritten = (
  planned: RAGCorpusDocument[],
  written: readonly string[],
) => {
  const ids = new Set(written);

  return planned.filter((doc) => ids.has(doc.chunkId));
};

export const reconcileRAGCorpus = async <Owner = string>(
  store: RAGCorpusStore<Owner>,
  owner: Owner,
  desired: RAGCorpusDocument[],
  apply: RAGCorpusApply<Owner>,
): Promise<RAGCorpusResult> => {
  const plan = await planRAGCorpus(store, owner, desired);

  if (plan.remove.length > 0) {
    await apply.remove(plan.remove, owner);
    await store.forget(owner, plan.remove);
  }

  let embedded = 0;
  if (plan.embed.length > 0) {
    const outcome = await apply.embed(plan.embed, owner);
    // Only what was actually written gets recorded. Remembering the whole plan
    // regardless of outcome is how a partial pass turns into a permanent hole:
    // the unwritten chunks look `unchanged` forever after.
    if (typeof outcome === "number" && outcome !== plan.embed.length) {
      throw new Error(
        `A numeric RAG corpus embed result must equal the full plan length (${plan.embed.length}); received ${outcome}. Return exact chunk ids for partial writes.`,
      );
    }
    const written =
      typeof outcome === "number"
        ? plan.embed
        : filterToWritten(plan.embed, outcome);
    embedded = written.length;
    if (written.length > 0) {
      await store.remember(
        owner,
        await Promise.all(
          written.map(async (doc) => ({
            chunkId: doc.chunkId,
            textHash: await corpusTextHash(doc.text),
          })),
        ),
      );
    }
  }

  return { embedded, removed: plan.remove.length, unchanged: plan.unchanged };
};
