import type { ScheduledTask, ScheduledTaskDraft, ScheduledTaskPatch, ScheduledTaskRun, ScheduledTaskSnapshot } from "@shared/schedules";

/** Browser-only fixture for `mock.html?tasks=sample#/tasks`. No engine is started. */
export function createScheduleFixture(sample = false) {
  const now = Date.now();
  let revision = 0;
  let tasks: ScheduledTask[] = sample ? [
    { id: "fixture-daily", name: "每日整理项目", prompt: "整理昨天的开发记录，生成今日待办摘要。", schedule: { kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" }, enabled: true, createdAt: now - 86_400_000, updatedAt: now, nextRunAt: now + 3_600_000, lastRunAt: now - 86_400_000, lastStatus: "completed" },
    { id: "fixture-weekly", name: "每周总结", prompt: "总结本周的改动与待解决问题。", schedule: { kind: "weekly", time: "17:00", timeZone: "Asia/Shanghai", days: [5] }, enabled: true, createdAt: now - 86_400_000, updatedAt: now, nextRunAt: now + 86_400_000 },
  ] : [];
  const runs: ScheduledTaskRun[] = sample ? [{ id: "fixture-run", taskId: "fixture-daily", scheduledAt: now - 86_400_000, startedAt: now - 86_400_000, endedAt: now - 86_400_000 + 15_000, status: "completed", conversationId: "preview-conversation" }] : [];
  const listeners = new Set<(snapshot: ScheduledTaskSnapshot) => void>();
  const snapshot = (): ScheduledTaskSnapshot => ({ revision, tasks: tasks.map((task) => structuredClone(task)) });
  const emit = () => { revision++; for (const listener of listeners) listener(snapshot()); };
  const requireTask = (id: string): ScheduledTask => {
    const task = tasks.find((item) => item.id === id);
    if (!task) throw new Error("定时任务不存在");
    return task;
  };
  return {
    list: async () => snapshot(),
    create: async (draft: ScheduledTaskDraft) => {
      const task: ScheduledTask = { ...draft, id: crypto.randomUUID(), enabled: true, createdAt: Date.now(), updatedAt: Date.now(), nextRunAt: Date.now() + 3_600_000 };
      tasks = [task, ...tasks]; emit(); return structuredClone(task);
    },
    update: async (id: string, patch: ScheduledTaskPatch) => {
      const current = requireTask(id);
      const task: ScheduledTask = { ...current, ...patch, project: patch.project === "" ? undefined : patch.project ?? current.project, updatedAt: Date.now(), nextRunAt: patch.enabled === false ? undefined : current.nextRunAt };
      tasks = tasks.map((item) => item.id === id ? task : item); emit(); return structuredClone(task);
    },
    remove: async (id: string) => { const had = tasks.some((item) => item.id === id); tasks = tasks.filter((item) => item.id !== id); emit(); return had; },
    runNow: async (id: string) => {
      const task = requireTask(id);
      const run: ScheduledTaskRun = { id: crypto.randomUUID(), taskId: id, scheduledAt: Date.now(), startedAt: Date.now(), status: "running", manual: true };
      runs.unshift(run); task.lastStatus = "running"; emit();
      window.setTimeout(() => { if (run.status === "running") { run.status = "completed"; run.endedAt = Date.now(); task.lastStatus = "completed"; emit(); } }, 1800);
      return { ...run };
    },
    stopRun: async (id: string) => { const run = runs.find((item) => item.taskId === id && item.status === "running"); if (!run) return false; run.status = "stopped"; run.endedAt = Date.now(); requireTask(id).lastStatus = "stopped"; emit(); return true; },
    history: async (id: string) => runs.filter((run) => run.taskId === id).map((run) => ({ ...run })),
    onChanged: (listener: (snapshot: ScheduledTaskSnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
