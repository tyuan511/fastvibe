import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DagReport } from "../../shared/dag.ts";

export const DAG_WORKER_TOOLS = ["dag_result", "dag_report"];
export const DAG_COORDINATOR_TOOLS = [...DAG_WORKER_TOOLS, "dag_add_tasks", "dag_status", "dag_wait", "dag_cancel", "dag_retry", "dag_update", "dag_send"];

/** A conservative estimate, with explicit headroom; never truncate project instructions. */
export function estimateDagTokens(text: string): number {
  const nonAscii = text.replace(/[\x00-\x7f]/g, "").length;
  return Math.ceil((text.length - nonAscii) / 3 + nonAscii * 2);
}

export function dagInputAllowance(system: string, tools: string, contextWindow = 128000): number {
  return Math.max(0, Math.floor(contextWindow * 0.65) - estimateDagTokens(system) - estimateDagTokens(tools) - 2048);
}

export function validateDagReport(value: DagReport, acceptance?: string): DagReport {
  if (!["completed", "blocked", "failed"].includes(value.outcome)) throw new Error("必须明确报告 completed、blocked 或 failed");
  if (!value.summary.trim() || value.summary.length > 3000) throw new Error("结论必须是 1–3000 字符");
  for (const list of [value.evidence, value.artifacts]) {
    if (list && (list.length > 20 || list.some((item) => typeof item !== "string" || !item.trim() || item.length > 1000))) throw new Error("证据和产物各最多 20 条，每条 1–1000 字符");
  }
  if (acceptance && value.outcome === "completed" && !value.evidence?.length) throw new Error("任务有验收条件，报告完成时必须提供验收证据");
  return structuredClone(value);
}

export function dagReportExtension(options: { acceptance?: string; report: (report: DagReport | undefined) => void; childrenReady: () => boolean }) {
  return (pi: ExtensionAPI): void => {
    pi.on("tool_call", (event) => { if (event.toolName !== "dag_report") options.report(undefined); });
    pi.registerTool({
      name: "dag_report",
      label: "Report task outcome",
      description: "Before your final response, explicitly report completed, blocked, or failed with a compact conclusion, evidence and artifact paths. This is your claim, not an independent verification. If acceptance is unmet, report blocked. Your final response is saved in full. Any later tool call invalidates this report; report again after further work.",
      parameters: Type.Object({
        outcome: Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed")]),
        summary: Type.String({ maxLength: 3000 }),
        evidence: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 })),
        artifacts: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 20 })),
      }),
      async execute(_id, input) {
        try {
          options.report(undefined);
          if (input.outcome === "completed" && !options.childrenReady()) throw new Error("子任务尚未全部成功；请先等待并处理子任务，或报告 blocked");
          const report = validateDagReport(input, options.acceptance);
          options.report(report);
          return { content: [{ type: "text" as const, text: "Outcome recorded. End with your complete result." }], details: { outcome: report.outcome } };
        } catch (error) { return { content: [{ type: "text" as const, text: String(error) }], details: { outcome: input.outcome }, isError: true }; }
      },
    });
  };
}
