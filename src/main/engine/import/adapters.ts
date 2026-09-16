import type { ImportSourceId } from "@shared/types";
import type { ImportAdapter } from "./types";
import { claudeCodeAdapter } from "./sources/claude-code";
import { codexAdapter } from "./sources/codex";
import { opencodeAdapter } from "./sources/opencode";
import { piAdapter } from "./sources/pi";
import { zcodeAdapter } from "./sources/zcode";

/**
 * The sources FastVibe imports from, in the order the 导入 pane lists them: the
 * sibling CLI whose format FastVibe's own engine speaks first, then the four that
 * cover most of the rest of the market.
 *
 * Adding a source means writing one adapter and naming it here — nothing else in the
 * app is aware of how many there are.
 */
export const IMPORT_ADAPTERS: ImportAdapter[] = [piAdapter, claudeCodeAdapter, codexAdapter, opencodeAdapter, zcodeAdapter];

export function importAdapter(id: ImportSourceId): ImportAdapter | undefined {
  return IMPORT_ADAPTERS.find((adapter) => adapter.id === id);
}
