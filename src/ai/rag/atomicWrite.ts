import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

// Atomic + durable write: write to tmp, fsync the tmp file, rename to dest, fsync
// the parent dir. Survives both SIGTERM mid-write (rename atomicity) and power
// loss / kernel panic after rename returns (dir fsync forces the rename onto disk).
export const writeFileAtomic = async (
  path: string,
  data: string,
  encoding: BufferEncoding = "utf8",
): Promise<void> => {
  const tmpPath = `${path}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const buffer = Buffer.from(data, encoding);
  let renamed = false;

  try {
    const fileHandle = await open(tmpPath, "w");
    try {
      await fileHandle.writeFile(buffer);
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }

    await rename(tmpPath, path);
    renamed = true;

    // Best-effort directory fsync. Windows cannot open a directory as a file,
    // and some filesystems silently ignore it; treat any failure as non-fatal.
    try {
      const dirHandle = await open(dirname(path), "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // intentionally ignored
    }
  } catch (error) {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
        // tmp may not exist if open/write failed before creating it
      }
    }
    throw error;
  }
};
