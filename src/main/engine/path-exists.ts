import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * Keep filesystem probes bounded. Markdown can contain a large number of path-like
 * tokens, and stat calls are cheap individually but still compete for the same IO
 * pool when fired without a limit.
 */
const MAX_PATHS = 512;
const MAX_PATH_LENGTH = 4096;
const CONCURRENCY = 32;

/**
 * Return the input candidates that resolve to regular files.
 *
 * The renderer sends the original spelling so it can match the answer back to the
 * Markdown AST. Relative paths are resolved against the conversation cwd; without a
 * cwd they are ignored rather than guessed from the process cwd.
 */
export async function existingFiles(rawPaths: unknown, rawCwd: unknown): Promise<string[]> {
  if (!Array.isArray(rawPaths)) return [];
  const cwd = typeof rawCwd === "string" && rawCwd.trim() ? rawCwd.trim() : undefined;
  const paths = [...new Set(rawPaths
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()) && value.trim().length <= MAX_PATH_LENGTH)
    .map((value) => value.trim()))]
    .slice(0, MAX_PATHS);
  if (paths.length === 0) return [];

  const result: string[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < paths.length) {
      const index = cursor++;
      const candidate = paths[index]!;
      // Absolute paths are valid without a cwd. A relative path with no cwd is not
      // safe to interpret relative to whichever directory happens to launch Main.
      if (!isAbsolute(candidate) && !cwd) continue;
      const target = isAbsolute(candidate) ? candidate : resolve(cwd!, candidate);
      try {
        if ((await stat(target)).isFile()) result.push(candidate);
      } catch {
        // Missing, inaccessible, and malformed candidates are all simply not files.
      }
    }
  }

  const workers = Math.min(CONCURRENCY, paths.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return result;
}

export const pathExistenceLimits = { maxPaths: MAX_PATHS, concurrency: CONCURRENCY } as const;
