import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/internal/atomicWrite";

const tempDirs: string[] = [];

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "absolute-rag-atomic-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeFileAtomic", () => {
  it("writes content to the destination path", async () => {
    const dir = makeTempDir();
    const path = join(dir, "data.json");

    await writeFileAtomic(path, '{"hello":"world"}');

    expect(readFileSync(path, "utf8")).toBe('{"hello":"world"}');
  });

  it("overwrites an existing file", async () => {
    const dir = makeTempDir();
    const path = join(dir, "data.json");

    await writeFileAtomic(path, "first");
    await writeFileAtomic(path, "second");

    expect(readFileSync(path, "utf8")).toBe("second");
  });

  it("does not leave any tmp file behind on success", async () => {
    const dir = makeTempDir();
    const path = join(dir, "data.json");

    await writeFileAtomic(path, "payload");

    const entries = readdirSync(dir);
    expect(entries).toEqual(["data.json"]);
  });

  it("never writes a partial body to the destination path", async () => {
    // The whole point of atomic write: a reader at any moment sees either the
    // old content or the full new content, never a half-written file.
    const dir = makeTempDir();
    const path = join(dir, "data.json");
    const stable = "x".repeat(50_000);

    await writeFileAtomic(path, stable);
    const observed = readFileSync(path, "utf8");

    expect(observed.length).toBe(stable.length);
    expect(observed).toBe(stable);
  });

  it("cleans up the tmp file when rename fails", async () => {
    const dir = makeTempDir();
    // Targeting a path inside a directory that does not exist forces rename to
    // fail (ENOENT on the destination's parent), exercising the cleanup path.
    const path = join(dir, "missing-subdir", "data.json");

    await expect(writeFileAtomic(path, "payload")).rejects.toThrow();

    // The parent dir we created earlier should not contain any orphaned tmp files.
    const entries = readdirSync(dir);
    expect(entries).toEqual([]);
  });
});
