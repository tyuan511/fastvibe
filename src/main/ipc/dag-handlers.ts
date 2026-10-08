import { Ipc } from "@shared/ipc";
import type { PiProcessManager } from "../pi/process-manager";
import { handle } from "./registry";

/**
 * 侧边的图：读，以及图上的操作（取消、重试、恢复）。节点的「停止」走已有的 `engine:abort-subagent`。
 * 图属于引擎，所以 SSH 远端 Agent 注册的是同样的几个方法（`src/agent/handlers.ts`），网关按会话 id 路由。
 */
export function registerDagIpc(engine: PiProcessManager): void {
  handle(Ipc.dagList, () => engine.listDagGraphs());
  handle(Ipc.dagOutput, (payload: { conversationId: string; id: string; offset?: number }) => engine.getDagOutput(payload.conversationId, payload.id, payload.offset));
  handle(Ipc.dagCancel, (payload: { conversationId: string; ids?: string[] }) => engine.cancelDag(payload.conversationId, payload.ids));
  handle(Ipc.dagRetry, (payload: { conversationId: string; id: string }) => engine.retryDagNode(payload.conversationId, payload.id));
  handle(Ipc.dagResume, (payload: { conversationId: string }) => engine.resumeDag(payload.conversationId));
}
