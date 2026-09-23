import { StalePage, type BrowserControl, type ObservedPage } from "../engine/decision/browser-agent";
import type { ObservedAction } from "../engine/decision/browser-snapshot";
import { windowObservation, type WindowObservation, type WindowStateInfo } from "../engine/decision/computer-observation";
import { uiText } from "../engine/ui-text";
import type { ComputerRequest } from "@shared/types";
import { requestComputer } from "./cua-bridge";
import { decisionTasksEnabled, runDecisionTask, type DecisionTaskRequest, type DecisionTaskResult } from "./decision-task-runner";

/**
 * `computer_task`: the decision-model path of computer use (docs/decision-layer.md §7.9).
 *
 * Same loop as `browser_task`; the control layer here is one desktop window through Cua
 * Driver. Every call goes through `requestComputer`, so the 电脑操控 switch, the macOS
 * grants and the driver's own approvals apply exactly as they do to `computer_*` tools.
 *
 * Tokens name elements of one snapshot, so an action is always resolved against a fresh
 * read of the window: `fresh` re-reads it, and `act` uses the tokens of that read — the
 * content has just been checked to be the same, so the node numbers line up.
 */

export type ComputerTaskRequest = DecisionTaskRequest & { pid: number; windowId: string };
export type ComputerTaskResult = DecisionTaskResult;

const SETTLE_MS = 200;

function computerControl(pid: number, windowId: string): BrowserControl {
  const call = (request: Omit<ComputerRequest, "pid" | "windowId">) => requestComputer({ ...request, pid, windowId } as ComputerRequest);
  let latest: WindowObservation | null = null;

  const read = async (): Promise<WindowObservation> => {
    const result = await call({ action: "window_state", maxElements: 300 });
    let state: WindowStateInfo;
    try {
      state = JSON.parse(result.text ?? "{}") as WindowStateInfo;
    } catch {
      throw new Error(uiText("无法读取窗口内容", "Could not read the window"));
    }
    latest = windowObservation({ ...state, elements: state.elements ?? [] });
    return latest;
  };

  const control: BrowserControl = {
    async observe(): Promise<ObservedPage> {
      return (await read()).observation;
    },
    async fresh(page, action) {
      try {
        const now = (await read()).observation;
        if (action && action.node !== undefined && (action.kind === "click" || action.kind === "select")) {
          return JSON.stringify(now.guards[String(action.node)] ?? null) === JSON.stringify(page.guards[String(action.node)] ?? null);
        }
        return JSON.stringify(now.marker) === JSON.stringify(page.marker);
      } catch {
        return false;
      }
    },
    async act(action: ObservedAction, page, text) {
      if (!(await control.fresh(page, action)) || !latest) throw new StalePage();
      const current = latest;
      if (action.kind === "wait") {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return;
      }
      if (action.kind === "scroll") {
        if (!current.scrollPoint) throw new StalePage(uiText("窗口里没有可滚动的区域", "The window has nothing to scroll"));
        await call({ action: "scroll", x: current.scrollPoint.x, y: current.scrollPoint.y, direction: (action.delta ?? 1) < 0 ? "up" : "down", amount: Math.abs(action.delta ?? 5) });
      } else {
        const token = action.node !== undefined ? current.tokens.get(action.node) : undefined;
        if (!token) throw new StalePage(uiText("目标已变化", "The target changed"));
        await call({ action: "click", elementToken: token });
        if (action.kind === "fill") {
          // Replace, not append: select everything in the field first.
          await call({ action: "hotkey", keys: [process.platform === "darwin" ? "cmd" : "ctrl", "a"] });
          await call({ action: "type", text: text ?? "" });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    },
  };
  return control;
}

export function runComputerTask(request: ComputerTaskRequest): Promise<ComputerTaskResult> {
  return runDecisionTask(request, {
    kind: "computer-task",
    control: computerControl(request.pid, request.windowId),
    where: (page) => page.title || uiText("该窗口", "this window"),
    missing: uiText(
      "读不到这个窗口，请先用 computer_list_windows 确认 pid 与 windowId",
      "Could not read this window; confirm pid and windowId with computer_list_windows first",
    ),
  });
}

/** Expose the runner to the computer-use extension, which cannot import FastVibe internals. */
export function installComputerTaskGlobal(): void {
  const scope = globalThis as Record<string, unknown>;
  scope.__fastvibeComputerTask = runComputerTask;
  scope.__fastvibeComputerTaskEnabled = decisionTasksEnabled;
}
