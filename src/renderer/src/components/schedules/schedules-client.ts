import type {
  ScheduledTask,
  ScheduledTaskDraft,
  ScheduledTaskPatch,
  ScheduledTaskRun,
  ScheduledTaskSnapshot,
} from "@shared/schedules";

/**
 * `window.fastvibe.schedules`, as the desktop bridge will expose it.
 *
 * `stopRun` takes the task id, same as `runNow` / `history` / `update` / `remove`:
 * the page stops that task's active run, and does not invent a second id.
 */
export type SchedulesApi = {
  list(): Promise<ScheduledTaskSnapshot>;
  create(draft: ScheduledTaskDraft): Promise<ScheduledTask>;
  update(id: string, patch: ScheduledTaskPatch): Promise<ScheduledTask>;
  remove(id: string): Promise<boolean>;
  runNow(id: string): Promise<ScheduledTaskRun>;
  stopRun(id: string): Promise<boolean>;
  history(id: string): Promise<ScheduledTaskRun[]>;
  onChanged(listener: (snapshot: ScheduledTaskSnapshot) => void): () => void;
};

export class SchedulesUnavailableError extends Error {
  constructor() {
    super("schedules-unavailable");
    this.name = "SchedulesUnavailableError";
  }
}

type Host = typeof window.fastvibe;
type LiveSchedules = Host extends { schedules: infer Api } ? Api : SchedulesApi;

/** Fails typecheck once the bridge exists but does not satisfy this page's contract. */
type SchedulesCompatible = Host extends { schedules: infer Api } ? (Api extends SchedulesApi ? true : false) : true;
type AssertSchedules<T extends true> = T;
type _SchedulesApiCheck = AssertSchedules<SchedulesCompatible>;

export function schedulesApi(): SchedulesApi {
  const api = (window.fastvibe as Host & { schedules?: LiveSchedules }).schedules;
  if (!api) throw new SchedulesUnavailableError();
  return api as SchedulesApi;
}
