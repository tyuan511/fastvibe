import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ipc } from "../src/shared/ipc.ts";

/**
 * Every method registered on the neutral call table, read out of the sources.
 *
 * The modules that register them import Electron, so they cannot be loaded in a plain
 * `node --test` process; parsing is the price of checking the *real* table rather than a
 * hand-kept copy that drifts. Push-only channels (`engine:event`, `settings:changed`, …)
 * are not methods and are excluded by construction — they are never passed to `handle`.
 *
 * The whole of `src/main` is walked rather than a list of files. A named list missed the
 * first module that was added after it was written (`remote.ts`), which made the policy
 * coverage test pass while seven unclassified methods sat in the table — the exact
 * failure the test exists to prevent.
 */
export function registeredChannels(): string[] {
  const root = fileURLToPath(new URL("../src/main", import.meta.url));
  const names = new Set<string>();
  for (const file of walk(root)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?<!ipcMain\.)\bhandle\(\s*Ipc\.(\w+)\s*,/g)) {
      names.add(match[1]);
    }
  }
  // Registered through a loop over a pair, so the channel is a variable at the call site.
  names.add("workspaceGitPull");
  names.add("workspaceGitPush");
  return [...names].map((name) => (Ipc as Record<string, string>)[name]).filter(Boolean);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}
