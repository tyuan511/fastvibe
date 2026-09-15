import { useSessionStore } from "@/stores/session";

/**
 * Tool paths arrive from the engine absolute — the engine's working directory *is*
 * the project — but a transcript reads better in project terms: what matters is
 * that the file is `src/main/engine/pricing.ts`, not that the repo happens to live
 * under `/Users/someone/code`. Every path a tool surface prints goes through
 * `displayPath`.
 */

/**
 * Working directory of the conversation on screen, or `undefined` when nothing is
 * bound yet. Tool cards only ever render inside a conversation's transcript — the
 * main thread, the side pane's chats and the subagent viewer all belong to the
 * active one — so that conversation is the right frame for every path they show.
 */
export function useWorkspacePath(): string | undefined {
  return useSessionStore((state) => state.conversations.find((item) => item.id === state.activeId)?.cwd);
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
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
  if (!/^([a-zA-Z]:)?\//.test(value)) return target;
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
