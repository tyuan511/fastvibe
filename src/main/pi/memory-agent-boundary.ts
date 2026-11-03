import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** Only the private consolidation session uses this boundary, never ordinary agents. */
export function memoryToolPathAllowed(cwd: string, name: string, args: unknown): boolean {
  if (!["read", "edit", "write", "grep", "find", "ls"].includes(name)) return false;
  const fields = args && typeof args === "object" ? args as { path?: unknown } : {};
  if (fields.path !== undefined && typeof fields.path !== "string") return false;
  if (["read", "edit", "write"].includes(name) && (typeof fields.path !== "string" || !fields.path)) return false;
  // SDK file tools expand @, ~, file URLs and Unicode spaces before resolving.
  // Consolidation uses ordinary literal paths, so reject those alternate spellings.
  if (typeof fields.path === "string" && (/^(?:@|~|file:)/.test(fields.path) || /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(fields.path))) return false;
  const root = resolve(cwd);
  const candidate = resolve(root, typeof fields.path === "string" ? fields.path : ".");
  const within = (base: string, target: string) => { const rel = relative(base, target); return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel); };
  if (!within(root, candidate)) return false;
  if (["write", "edit"].includes(name) && !/^(?:MEMORY\.md|memory_summary\.md|raw_memories\.md|rollout_summaries\/[^/]+\.md)$/.test(relative(root, candidate).replaceAll("\\", "/"))) return false;
  try {
    const actualRoot = realpathSync(root);
    let parent = candidate;
    let existing: string | undefined;
    for (;;) {
      try {
        const stat = lstatSync(parent);
        if (stat.isSymbolicLink()) return false;
        if (!existing) existing = parent;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
      if (parent === root) break;
      const next = dirname(parent);
      if (next === parent) return false;
      parent = next;
    }
    return Boolean(existing && within(actualRoot, realpathSync(existing)));
  } catch { return false; }
}
