import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_DECISION_MODEL, decisionModelConfigOf, type DecisionModelConfig } from "../../../shared/decision.ts";

/**
 * `decision.json`, holding only which decision-model backend is selected.
 *
 * Kept apart from `settings.json` for the same reason `providers.json`/`mcp.json` are:
 * that file is handed whole to every renderer and re-broadcast on every write (see
 * AGENTS.md "设置跨窗口同步"), and this has nothing to do with UI preferences. Unlike
 * those files, nothing here is a secret — Laya runs locally, so there is no key to keep
 * off the wire the way `remote-access.json` or `gateway-credentials.json` do.
 *
 * docs/decision-layer.md §5.6 envisions a richer file (`largeModel`, `scenarios`,
 * `consents`, `trace`); none of those exist yet, so this only ever writes and reads
 * `decisionModel` — adding a field here without a consumer for it would be exactly the
 * half-finished state AGENTS.md warns against.
 */
const FILE_VERSION = 1;

type DecisionFile = { version: number; decisionModel: unknown };

/**
 * A missing, corrupt, or future-versioned file reads back as `{kind:"off"}` — the same
 * "ignored rather than trusted" rule `oauth-store.ts` uses — and is never rewritten by a
 * read. The worst case is the decision model reverting to off, not data loss.
 */
export function readDecisionConfig(file: string): DecisionModelConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return DEFAULT_DECISION_MODEL;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_DECISION_MODEL;
  const record = parsed as Partial<DecisionFile>;
  if (record.version !== FILE_VERSION) return DEFAULT_DECISION_MODEL;
  return decisionModelConfigOf(record.decisionModel);
}

/** Write through a temp file and rename, so a crash mid-write cannot leave a half-written config. */
export function writeDecisionConfig(file: string, config: DecisionModelConfig): void {
  const payload: DecisionFile = { version: FILE_VERSION, decisionModel: config };
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
