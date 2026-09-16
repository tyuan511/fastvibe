import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Opening another agent's SQLite history without disturbing whoever has it open.
 *
 * opencode and zcode keep their sessions in a WAL database that their own process
 * writes to. An ordinary read-only handle on the live file is *usually* fine and costs
 * nothing, but a checkpoint in flight can throw `SQLITE_BUSY`, and WAL mode needs write
 * access to the `-shm` sidecar even for reads. So: try the live file read-only, and only
 * on failure copy it (with its `-wal`/`-shm`) aside and open that.
 *
 * The copy is a last resort, not the default. opencode's database is 2.8 GB on the
 * author's corpus, and copying it per call made a ten-session import spend half a minute
 * copying the same bytes — so a successful copy is cached for the lifetime of the run and
 * removed by `disposeImportDatabases()`, which `ImportAdapter.dispose` calls.
 */
type Handle = { db: DatabaseSync; close: () => Promise<void> };

/** A live read-only handle never outlives its call, so only copied databases are cached. */
const copies = new Map<string, { db: DatabaseSync; dir: string }>();

export async function openReadOnlyDatabase(file: string): Promise<Handle> {
  const cached = copies.get(file);
  if (cached) return { db: cached.db, close: async () => undefined };
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.prepare("SELECT 1").get();
    return { db, close: async () => db.close() };
  } catch {
    // Locked or mid-checkpoint: fall through to the copy.
  }
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-import-"));
  const copy = join(dir, basename(file));
  await copyFile(file, copy);
  for (const suffix of ["-wal", "-shm"]) {
    await copyFile(`${file}${suffix}`, `${copy}${suffix}`).catch(() => undefined);
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(copy, { readOnly: true });
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  copies.set(file, { db, dir });
  return { db, close: async () => undefined };
}

/** Drop any cached copies. Called once an import run finishes (`ImportAdapter.dispose`). */
export async function disposeImportDatabases(): Promise<void> {
  const handles = [...copies.values()];
  copies.clear();
  for (const handle of handles) {
    try {
      handle.db.close();
    } catch {
      // Already closed — the copy is disposable either way.
    }
    await rm(handle.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
