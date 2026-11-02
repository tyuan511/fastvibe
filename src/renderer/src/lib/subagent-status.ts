import type { SubagentInfo } from "@shared/types";
import { subagentViewStatus } from "@shared/subagent-state";
import { i18n } from "./i18n";

export function subagentStatusText(info?: SubagentInfo, fallback?: string): string {
  const raw = subagentViewStatus(info, fallback);
  const status = raw === "failed" ? "error" : raw === "interrupted" ? "aborted" : raw === "closed" ? "completed" : raw === "working" ? "running" : raw;
  const key = status === "running" && info?.phase && info.phase !== "working" ? info.phase : status;
  return i18n.t(`sidepane:subagent.status.${["running", "completed", "error", "aborted", "retrying", "compacting", "waiting", "queued", "skipped"].includes(key) ? key : "unknown"}`) as string;
}
