import type { SubagentInfo } from "@shared/types";
import { subagentViewStatus } from "@shared/subagent-state";
import { i18n } from "./i18n";

export function subagentStatusText(info?: SubagentInfo, fallback?: string): string {
  const status = subagentViewStatus(info, fallback);
  const key = status === "running" && info?.phase && info.phase !== "working" ? info.phase : status;
  return i18n.t(`sidepane:subagent.status.${["running", "completed", "error", "aborted", "retrying", "compacting", "waiting", "queued", "skipped"].includes(key) ? key : "unknown"}`) as string;
}
