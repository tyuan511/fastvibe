import { Ipc } from "../../shared/ipc.ts";
import type { ImageGenerateRequest } from "../../shared/image-generation.ts";
import type { PiProcessManager } from "../pi/process-manager";
import { handle } from "./registry";

/** Register before attaching either Electron or the App Protocol transport. */
export function registerImagesIpc(engine: PiProcessManager): void {
  handle(Ipc.imagesGetConfig, () => engine.images.getConfig());
  handle(Ipc.imagesSnapshot, (input?: { sessionId?: string }) => engine.images.snapshot(input?.sessionId));
  handle(Ipc.imagesCreateSession, (input?: { title?: string }) => engine.images.createSession(input?.title));
  handle(Ipc.imagesRenameSession, (input: { id: string; title: string }) => engine.images.renameSession(input.id, input.title));
  handle(Ipc.imagesDeleteSession, (input: { id: string }) => engine.images.deleteSession(input.id));
  handle(Ipc.imagesDeleteTask, (input: { taskId: string }) => engine.images.deleteTask(input.taskId));
  handle(Ipc.imagesGenerate, (input: ImageGenerateRequest) => engine.images.generate(input));
  handle(Ipc.imagesCancel, (input: { taskId: string }) => engine.images.cancel(input.taskId));
}
