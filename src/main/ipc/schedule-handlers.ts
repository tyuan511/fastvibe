import { Ipc } from "@shared/ipc";
import type { ScheduledTaskDraft, ScheduledTaskPatch } from "@shared/schedules";
import type { PiProcessManager } from "../pi/process-manager";
import { handle } from "./registry";

/** One neutral call table for the desktop and a resident SSH Agent. */
export function registerScheduleIpc(engine: PiProcessManager): void {
  handle(Ipc.scheduleList, () => engine.listSchedules());
  handle(Ipc.scheduleCreate, (draft: ScheduledTaskDraft) => engine.createSchedule(draft));
  handle(Ipc.scheduleUpdate, (payload: { id: string; patch: ScheduledTaskPatch }) => engine.updateSchedule(payload.id, payload.patch));
  handle(Ipc.scheduleRemove, (payload: { id: string }) => engine.removeSchedule(payload.id));
  handle(Ipc.scheduleRunNow, (payload: { id: string }) => engine.runScheduleNow(payload.id));
  handle(Ipc.scheduleStopRun, (payload: { id: string }) => engine.stopScheduledRun(payload.id));
  handle(Ipc.scheduleHistory, (payload: { id: string }) => engine.scheduleHistory(payload.id));
}
