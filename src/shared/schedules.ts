/** A durable instruction for a future Agent run. Times are UTC milliseconds unless noted. */
export type ScheduleRule =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; time: string; timeZone: string; days: number[] };

export type ScheduledTaskDraft = {
  name: string;
  prompt: string;
  /** A project on the machine that owns the schedule; absent means a fresh scratch chat. */
  project?: string;
  /** The chat that asked for this task. Each run's outcome is reported back into it. */
  notifyConversationId?: string;
  schedule: ScheduleRule;
};

export type ScheduledTask = ScheduledTaskDraft & {
  id: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: ScheduledRunStatus;
};

export type ScheduledRunStatus = "running" | "completed" | "failed" | "stopped" | "interrupted" | "missed";

export type ScheduledTaskRun = {
  id: string;
  taskId: string;
  scheduledAt: number;
  startedAt?: number;
  endedAt?: number;
  status: ScheduledRunStatus;
  conversationId?: string;
  error?: string;
  /** A manual run does not move a recurring task's next scheduled occurrence. */
  manual?: boolean;
};

export type ScheduledTaskSnapshot = {
  revision: number;
  tasks: ScheduledTask[];
};

export type ScheduledTaskPatch = Partial<Pick<ScheduledTaskDraft, "name" | "prompt" | "schedule">> & {
  /** Explicitly clear a bound project with an empty string (undefined means leave unchanged). */
  project?: string;
  /** An empty string stops reporting back. */
  notifyConversationId?: string;
  enabled?: boolean;
};
