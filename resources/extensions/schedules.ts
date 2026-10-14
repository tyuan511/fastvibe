import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const T = (zh: string, en: string): string => process.env.FASTVIBE_UI_LANGUAGE === "en" ? en : zh;
const once = Type.Object({ kind: Type.Literal("once"), at: Type.String({ description: "Absolute ISO-8601 date-time with offset, e.g. 2027-05-01T10:00:00+08:00" }) });
const daily = Type.Object({ kind: Type.Literal("daily"), time: Type.String({ description: "Local HH:mm" }), timeZone: Type.String({ description: "IANA timezone, e.g. Asia/Shanghai" }) });
const weekly = Type.Object({ kind: Type.Literal("weekly"), time: Type.String({ description: "Local HH:mm" }), timeZone: Type.String({ description: "IANA timezone" }), days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { description: "Weekdays, Sunday=0 through Saturday=6" }) });
const rule = Type.Union([once, daily, weekly]);
const draft = Type.Object({
  name: Type.String({ description: "Short task name" }),
  prompt: Type.String({ description: "Self-contained Agent instruction to run in a fresh conversation" }),
  project: Type.Optional(Type.String({ description: "Existing project path on this Agent's machine. Omit to use this chat's project." })),
  schedule: rule,
});
type ScheduleHost = { schedules?(request: Record<string, unknown>): Promise<unknown> };
function hostOf(ctx: ExtensionContext): ScheduleHost { return ctx.ui as unknown as ScheduleHost; }
function output(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value }; }
async function call(ctx: ExtensionContext, request: Record<string, unknown>) {
  const host = hostOf(ctx);
  if (!host.schedules) return { content: [{ type: "text" as const, text: T("当前宿主不支持定时任务", "Scheduled tasks are unavailable on this host") }], details: {}, isError: true };
  try { return output(await host.schedules(request)); }
  catch (error) { return { content: [{ type: "text" as const, text: String(error instanceof Error ? error.message : error) }], details: {}, isError: true }; }
}

export default function schedulesExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "schedule_create", label: T("创建定时任务", "Create scheduled task"),
    description: "Schedule a self-contained Agent instruction for a future time. A run creates a new chat and may use tools in its selected project. The app keeps running after its last window closes, but an explicit Quit stops it. Only create when the user explicitly asks for future work.",
    promptSnippet: "Create an Agent task that runs once, daily, or on selected weekdays",
    parameters: draft,
    async execute(_id, input, _signal, _update, ctx) { return call(ctx, { action: "create", draft: input }); },
  });
  pi.registerTool({
    name: "schedule_list", label: T("查看定时任务", "List scheduled tasks"),
    description: "List upcoming scheduled Agent tasks, their state, and next run time.",
    parameters: Type.Object({}),
    async execute(_id, _input, _signal, _update, ctx) { return call(ctx, { action: "list" }); },
  });
  pi.registerTool({
    name: "schedule_update", label: T("修改定时任务", "Update scheduled task"),
    description: "Edit or pause/resume one task by id. enabled=false pauses future runs without stopping a current run; enabled=true resumes from the next occurrence.",
    parameters: Type.Object({ id: Type.String(), patch: Type.Object({
      name: Type.Optional(Type.String()), prompt: Type.Optional(Type.String()), project: Type.Optional(Type.String()),
      schedule: Type.Optional(rule), enabled: Type.Optional(Type.Boolean()),
    }) }),
    async execute(_id, input, _signal, _update, ctx) { return call(ctx, { action: "update", ...input }); },
  });
  pi.registerTool({
    name: "schedule_run_now", label: T("立即运行定时任务", "Run scheduled task now"),
    description: "Start one scheduled Agent task immediately. A recurring task keeps its future planned time; a one-off task is consumed.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, input, _signal, _update, ctx) { return call(ctx, { action: "runNow", id: input.id }); },
  });
  pi.registerTool({
    name: "schedule_history", label: T("查看定时任务历史", "Scheduled task history"),
    description: "Read a scheduled task's recent outcomes and conversation ids. Use the conversation to inspect the full transcript.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, input, _signal, _update, ctx) { return call(ctx, { action: "history", id: input.id }); },
  });
  pi.registerTool({
    name: "schedule_stop_run", label: T("停止定时任务运行", "Stop scheduled run"),
    description: "Stop this task's current Agent run without pausing its future occurrences.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, input, _signal, _update, ctx) { return call(ctx, { action: "stopRun", id: input.id }); },
  });
  pi.registerTool({
    name: "schedule_remove", label: T("删除定时任务", "Delete scheduled task"),
    description: "Delete a task and its schedule history (its chat transcripts remain). A running task must be stopped first.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, input, _signal, _update, ctx) { return call(ctx, { action: "remove", id: input.id }); },
  });
}
