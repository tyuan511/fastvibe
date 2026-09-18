/**
 * Tool paths arrive from the engine absolute — the engine's working directory *is*
 * the project — but a transcript reads better in project terms: what matters is
 * that the file is `src/main/engine/pricing.ts`, not that the repo happens to live
 * under `/Users/someone/code`. Every path a tool surface prints goes through
 * `displayPath`.
 *
 * The inverse is `resolvePath`. The engine also reports project-relative paths
 * (`src/renderer/src/mock/preview-data.ts`), and Main's `stat` is not run inside
 * the conversation cwd — a relative string is looked up from `process.cwd()` and
 * comes back ENOENT even though the file is sitting in the project. Conversation
 * previews, Finder reveals and anything else that must open the file go through
 * `resolvePath` first.
 */

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isAbsolute(path: string): boolean {
  return /^([a-zA-Z]:)?\//.test(path);
}

/**
 * `displayPath("/repo/src/a.ts", "/repo")` → `src/a.ts`.
 *
 * A path outside the workspace (a skill under `~/.agents`, another checkout) is
 * printed as given: abbreviating it to a `../..` chain would hide where the file
 * actually lives. A path that is already relative — the engine reports those too —
 * is returned untouched.
 */
export function displayPath(path: string, cwd?: string): string {
  const target = path.trim();
  if (!target || !cwd) return target;
  const value = normalize(target);
  // POSIX and Windows absolutes only; anything else is already project-relative.
  if (!isAbsolute(value)) return target;
  const root = normalize(cwd);
  if (!root) return target;
  // macOS volume names keep their own case, so the tests are case-insensitive while
  // the slice preserves the original spelling.
  const lower = value.toLowerCase();
  const rootLower = root.toLowerCase();
  if (lower === rootLower) return ".";
  if (!lower.startsWith(`${rootLower}/`)) return target;
  return value.slice(root.length + 1);
}

/**
 * `resolvePath("src/a.ts", "/repo")` → `/repo/src/a.ts`.
 *
 * Inverse of `displayPath`. An already-absolute path is returned as a normalised
 * POSIX-style string so later comparisons (`filesPreviewPath`, the file tree's
 * `selected`) match what `readDir` joins together. A relative path is joined onto
 * `cwd`. Without a cwd the relative string is returned untouched — Main cannot
 * guess the workspace.
 */
export function resolvePath(path: string, cwd?: string): string {
  const target = path.trim();
  if (!target) return target;
  const value = normalize(target);
  if (isAbsolute(value)) return value;
  if (!cwd) return target;
  const root = normalize(cwd);
  if (!root) return target;
  return `${root}/${value.replace(/^\.\//, "")}`;
}
