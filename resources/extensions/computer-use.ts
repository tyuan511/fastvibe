import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Computer-use tools, backed by Cua Driver running inside FastVibe's main process.
 *
 * The shape mirrors `browser-use.ts` — a `globalThis` bridge rather than an import,
 * because this file is loaded by path from outside the asar and cannot reach FastVibe's
 * own modules. What differs is the blast radius: `browser-use` drives a webview this app
 * owns, while these tools drive the user's actual desktop, including applications and
 * documents that have nothing to do with the conversation. Every description below is
 * written to push the model towards the narrow, verifiable action (a token from a fresh
 * snapshot, scoped to one window) and away from the broad one (a guessed coordinate on
 * the whole screen).
 */

type ComputerRequest = {
  action: string;
  /** For `action: "batch"`: the sequence to run in order. */
  steps?: ComputerRequest[];
  pid?: number;
  windowId?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  keys?: string[];
  modifiers?: string[];
  elementToken?: string;
  button?: string;
  count?: number;
  direction?: string;
  amount?: number;
  path?: string[];
  query?: string;
  foreground?: boolean;
  includeScreenshot?: boolean;
  maxElements?: number;
  onScreenOnly?: boolean;
  timeoutMs?: number;
  conversationId?: string;
};

type ComputerResult = {
  text: string;
  images: Array<{ mimeType: string; data: string }>;
  structured?: string;
  targetApp?: { name: string; bundleId?: string };
};

type ComputerBridge = (request: ComputerRequest) => Promise<ComputerResult>;

function bridge(): ComputerBridge {
  const handler = (globalThis as Record<string, unknown>).__fastvibeComputerRequest;
  if (typeof handler !== "function") throw new Error("电脑操作桥接尚未就绪");
  return handler as ComputerBridge;
}

function boundConversationId(): string | undefined {
  const value = (globalThis as Record<string, unknown>).__fastvibeComputerConversationId;
  return typeof value === "string" && value ? value : undefined;
}

/** Window ids are 64-bit; they travel as strings so no precision is lost on the way. */
const WINDOW_ID = Type.String({ description: "computer_list_windows 返回的 windowId（字符串形式的整数）" });
const PID = Type.Number({ description: "computer_list_apps 返回的进程 pid" });

/** The decision-model loop Main installs (src/main/pi/computer-task-runner.ts). */
type ComputerTaskRunner = (request: {
  conversationId?: string;
  goal: string;
  pid: number;
  windowId: string;
  signal?: AbortSignal;
  mode?: string;
  confirm?: (message: string) => Promise<boolean>;
  onStep?: (line: string) => void;
}) => Promise<{ status: string; detail?: string; steps: unknown[]; page?: unknown; backend: string; ms: number }>;

/** The in-window interaction tools computer_task replaces while 电脑控制 is on. */
const COMPUTER_STEP_TOOLS = ["computer_click", "computer_type", "computer_key", "computer_hotkey", "computer_scroll", "computer_batch"];

/** Main's decision-model loop and its switch, when this host provides them (not headless). */
function computerTaskRunner(): { run: ComputerTaskRunner; enabled: () => boolean } | undefined {
  const scope = globalThis as Record<string, unknown>;
  const enabled = scope.__fastvibeComputerTaskEnabled;
  const runner = scope.__fastvibeComputerTask;
  if (typeof enabled !== "function" || typeof runner !== "function") return undefined;
  return {
    run: runner as ComputerTaskRunner,
    enabled: () => {
      try {
        return Boolean(enabled());
      } catch {
        return false;
      }
    },
  };
}

/**
 * Make either the task tool or the step tools active, never both, by swapping one group
 * for the other: tools some other extension deactivated stay as that extension left them.
 */
function syncDecisionTools(pi: ExtensionAPI, task: string, steps: string[], on: boolean): void {
  const active = pi.getActiveTools();
  // A group comes in only in place of the other one: with neither active (plan mode's
  // read-only set), nothing is added.
  const next = on
    ? active.some((name) => steps.includes(name))
      ? [...active.filter((name) => !steps.includes(name)), ...(active.includes(task) ? [] : [task])]
      : active
    : active.includes(task)
      ? [...active.filter((name) => name !== task), ...steps.filter((name) => !active.includes(name))]
      : active;
  if (next === active) return;
  pi.setActiveTools(next);
}

export default function computerUse(pi: ExtensionAPI): void {
  const conversationId = boundConversationId();

  async function call(action: string, params: Omit<ComputerRequest, "action"> = {}): Promise<any> {
    let result: ComputerResult;
    try {
      result = await bridge()({ action, ...params, conversationId });
    } catch (error) {
      // The bridge attaches what would resolve the failure. Handing the model only the
      // sentence makes it retry the identical call; handing it the remedy lets it either
      // act or tell the user precisely what to do.
      const detail = (error as { detail?: { suggestedAction?: string } })?.detail;
      const message = error instanceof Error ? error.message : String(error);
      throw detail?.suggestedAction ? new Error(`${message}\n${detail.suggestedAction}`) : error;
    }
    // Screenshots go back as real image parts rather than a base64 blob inside text: the
    // model has to *see* the screen for any of this to work, and a stringified payload is
    // both invisible to it and large enough to crowd out the rest of the context.
    const content: Array<Record<string, unknown>> = [];
    // Naming the app makes an observation self-describing: a screenshot that says which
    // window it came from is one the model can reason about a turn later.
    const prefix = result.targetApp ? `[${result.targetApp.name}] ` : "";
    if (result.text) content.push({ type: "text", text: prefix + result.text });
    else if (prefix) content.push({ type: "text", text: prefix.trim() });
    for (const image of result.images) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    if (content.length === 0) content.push({ type: "text", text: "(无输出)" });
    return { content, details: result.structured ? { structured: result.structured } : undefined };
  }

  // Offered only while a decision model is selected (设置 → 决策引擎), read when this
  // session's tools load; with none, computer use stays on the step-by-step tools below.
  const runTask = computerTaskRunner();
  // computer_task and the in-window step tools are both registered; which are *active*
  // follows 设置 → 决策引擎 › 电脑控制, re-read every turn. On, in-window interaction goes
  // through computer_task only (click, type, key, hotkey, scroll, batch inactive — beside
  // it the main model keeps stepping itself and Jev never runs); off, computer_task is not
  // offered. Reading the desktop, menus (outside the window's tree, so computer_task cannot
  // see them) and the clipboard stay either way.
  if (runTask) {
    const sync = () => syncDecisionTools(pi, "computer_task", COMPUTER_STEP_TOOLS, runTask.enabled());
    pi.on("session_start", sync);
    pi.on("before_agent_start", sync);
  }
  if (runTask) {
    pi.registerTool({
      name: "computer_task",
      label: "电脑任务",
      description:
        "快速电脑执行器：在一个指定窗口里由决策模型逐步点击、输入、滚动，直到完成目标或无法继续。先用 computer_list_windows 找到 pid 和 windowId，再把用户的完整目标原文一次交给它（例如“在这个窗口新建一条提醒：标题 X，备注 Y，然后保存”），不要拆成小步，也不要写“然后告诉我……”——它只负责操作，不负责回答。返回执行过的每一步和最终窗口内容；由你据此回答用户，需要时再用 computer_window_state 或 computer_screenshot 核对。它只操作这一个窗口。",
      promptSnippet: "让决策模型在一个窗口里连续执行一个目标",
      parameters: Type.Object({
        pid: PID,
        windowId: WINDOW_ID,
        goal: Type.String({ description: "用户的完整目标原文（或尚未完成的部分）" }),
      }),
      async execute(_id, params, signal, onUpdate, ctx) {
        // Switched off since this turn began: refuse rather than drive the window anyway.
        if (!runTask.enabled()) {
          return { content: [{ type: "text", text: "电脑控制已在设置中关闭，computer_task 从下一轮起不可用；请改用 computer_click 等逐步工具。" }], details: undefined };
        }
        const lines: string[] = [];
        const result = await runTask.run({
          conversationId,
          goal: params.goal,
          pid: params.pid,
          windowId: params.windowId,
          signal,
          mode: process.env.FASTVIBE_PERMISSION_MODE,
          confirm: (message) => (ctx?.hasUI ? ctx.ui.confirm("FastVibe 电脑任务", message) : Promise.resolve(false)),
          onStep: (line) => {
            lines.push(line);
            onUpdate?.({ content: [{ type: "text", text: lines.join("\n") }], details: undefined });
          },
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      },
    });
  }

  pi.registerTool({
    name: "computer_screenshot",
    label: "截取屏幕",
    description:
      "截取整个桌面的当前画面。用来确认屏幕上有什么、或验证上一步操作是否生效。要操作某个窗口里的控件时不要只靠这张图猜坐标——先用 computer_window_state 拿到元素令牌。",
    promptSnippet: "看一下我的屏幕",
    parameters: Type.Object({}),
    async execute() {
      return call("screenshot");
    },
  });

  pi.registerTool({
    name: "computer_list_apps",
    label: "列出应用",
    description: "列出当前正在运行的应用及其 pid。这是定位目标应用的第一步。",
    promptSnippet: "看看有哪些应用在运行",
    parameters: Type.Object({}),
    async execute() {
      return call("list_apps");
    },
  });

  pi.registerTool({
    name: "computer_list_windows",
    label: "列出窗口",
    description: "列出窗口（windowId、所属应用、标题、位置尺寸）。省略 pid 时列出所有应用的窗口。",
    promptSnippet: "看看有哪些窗口",
    parameters: Type.Object({
      pid: Type.Optional(PID),
      onScreenOnly: Type.Optional(Type.Boolean({ description: "只列出屏幕上可见的窗口，默认 true" })),
    }),
    async execute(_id, params) {
      return call("list_windows", { pid: params.pid, onScreenOnly: params.onScreenOnly });
    },
  });

  pi.registerTool({
    name: "computer_window_state",
    label: "读取窗口内容",
    description:
      "读取一个窗口的无障碍树，返回其中可交互元素的 elementToken。点击任何控件之前都应该先调用它：令牌指向的是控件本身，按坐标点击则是在赌那个位置上现在是什么。令牌会失效——窗口内容变化后要重新读取。",
    promptSnippet: "看看那个窗口里有什么",
    parameters: Type.Object({
      pid: PID,
      windowId: WINDOW_ID,
      query: Type.Optional(Type.String({ description: "按文本筛选元素，减少返回量" })),
      includeScreenshot: Type.Optional(Type.Boolean({ description: "同时返回该窗口的截图" })),
      maxElements: Type.Optional(Type.Number({ description: "最多返回多少个元素，默认 200" })),
    }),
    async execute(_id, params) {
      return call("window_state", {
        pid: params.pid,
        windowId: params.windowId,
        query: params.query,
        includeScreenshot: params.includeScreenshot,
        maxElements: params.maxElements,
      });
    },
  });

  pi.registerTool({
    name: "computer_click",
    label: "点击",
    description:
      "点击一个控件。优先传 elementToken（来自 computer_window_state）；只有在确实没有令牌时才传 x/y 坐标。默认使用后台投递，不会抢走用户正在使用的窗口焦点；如果目标不支持后台投递会直接报错，此时再决定是否传 foreground: true——那会打断用户当前的操作。",
    promptSnippet: "点击那个按钮",
    parameters: Type.Object({
      elementToken: Type.Optional(Type.String({ description: "computer_window_state 返回的元素令牌，优先使用" })),
      pid: Type.Optional(PID),
      windowId: Type.Optional(WINDOW_ID),
      x: Type.Optional(Type.Number({ description: "屏幕坐标 X，没有令牌时才用" })),
      y: Type.Optional(Type.Number({ description: "屏幕坐标 Y，没有令牌时才用" })),
      button: Type.Optional(Type.String({ description: "left（默认）、right 或 middle" })),
      count: Type.Optional(Type.Number({ description: "点击次数，双击传 2" })),
      foreground: Type.Optional(Type.Boolean({ description: "抢占前台焦点，会打断用户，默认 false" })),
    }),
    async execute(_id, params) {
      return call("click", {
        elementToken: params.elementToken,
        pid: params.pid,
        windowId: params.windowId,
        x: params.x,
        y: params.y,
        button: params.button,
        count: params.count,
        foreground: params.foreground,
      });
    },
  });

  pi.registerTool({
    name: "computer_type",
    label: "输入文本",
    description:
      "向当前焦点所在的位置输入文本。传 pid + windowId 可以把输入限定在某个窗口内。注意这会真的把字符打进去——确认焦点在预期的输入框里再调用。",
    promptSnippet: "输入一段文本",
    parameters: Type.Object({
      text: Type.String({ description: "要输入的文本" }),
      pid: Type.Optional(PID),
      windowId: Type.Optional(WINDOW_ID),
    }),
    async execute(_id, params) {
      return call("type", { text: params.text, pid: params.pid, windowId: params.windowId });
    },
  });

  pi.registerTool({
    name: "computer_key",
    label: "按键",
    description: "按一个键，可带修饰键。例如 key: \"Return\"，或 key: \"a\" 配合 modifiers: [\"cmd\"]。",
    promptSnippet: "按一个键",
    parameters: Type.Object({
      key: Type.String({ description: "键名，例如 Return、Escape、Tab、a" }),
      modifiers: Type.Optional(Type.Array(Type.String(), { description: "修饰键，例如 [\"cmd\", \"shift\"]" })),
      pid: Type.Optional(PID),
      windowId: Type.Optional(WINDOW_ID),
    }),
    async execute(_id, params) {
      return call("key", { key: params.key, modifiers: params.modifiers, pid: params.pid, windowId: params.windowId });
    },
  });

  pi.registerTool({
    name: "computer_hotkey",
    label: "组合键",
    description: "同时按下一组键，例如 keys: [\"cmd\", \"s\"]。",
    promptSnippet: "按一个组合键",
    parameters: Type.Object({
      keys: Type.Array(Type.String(), { description: "同时按下的键，例如 [\"cmd\", \"s\"]" }),
      pid: Type.Optional(PID),
      windowId: Type.Optional(WINDOW_ID),
    }),
    async execute(_id, params) {
      return call("hotkey", { keys: params.keys, pid: params.pid, windowId: params.windowId });
    },
  });

  pi.registerTool({
    name: "computer_scroll",
    label: "滚动",
    description: "在指定位置滚动。x/y 决定滚动发生在哪个区域上。",
    promptSnippet: "滚动页面",
    parameters: Type.Object({
      x: Type.Number({ description: "滚动位置的屏幕坐标 X" }),
      y: Type.Number({ description: "滚动位置的屏幕坐标 Y" }),
      direction: Type.Optional(Type.String({ description: "up、down（默认）、left 或 right" })),
      amount: Type.Optional(Type.Number({ description: "滚动量" })),
      pid: Type.Optional(PID),
      windowId: Type.Optional(WINDOW_ID),
    }),
    async execute(_id, params) {
      return call("scroll", {
        x: params.x,
        y: params.y,
        direction: params.direction,
        amount: params.amount,
        pid: params.pid,
        windowId: params.windowId,
      });
    },
  });

  pi.registerTool({
    name: "computer_menu",
    label: "调用菜单",
    description:
      "调用窗口的菜单项，path 是从顶层菜单开始的完整路径，例如 [\"文件\", \"保存\"]。比在屏幕上点菜单更可靠，因为不依赖菜单展开后的坐标。",
    promptSnippet: "用菜单执行一个命令",
    parameters: Type.Object({
      pid: PID,
      windowId: WINDOW_ID,
      path: Type.Array(Type.String(), { description: "菜单路径，例如 [\"File\", \"Save\"]" }),
    }),
    async execute(_id, params) {
      return call("menu", { pid: params.pid, windowId: params.windowId, path: params.path });
    },
  });

  pi.registerTool({
    name: "computer_clipboard_read",
    label: "读取剪贴板",
    description: "读取系统剪贴板的文本内容。",
    promptSnippet: "看看剪贴板里是什么",
    parameters: Type.Object({}),
    async execute() {
      return call("clipboard_read");
    },
  });

  pi.registerTool({
    name: "computer_clipboard_write",
    label: "写入剪贴板",
    description: "把文本写入系统剪贴板，会覆盖用户原有的剪贴板内容。",
    promptSnippet: "复制到剪贴板",
    parameters: Type.Object({
      text: Type.String({ description: "要写入剪贴板的文本" }),
    }),
    async execute(_id, params) {
      return call("clipboard_write", { text: params.text });
    },
  });

  pi.registerTool({
    name: "computer_batch",
    label: "连续操作",
    description:
      "一次执行一串动作，按顺序跑，任何一步失败就停下并告诉你停在哪。只要下一步不依赖上一步的返回结果，就应该用它，而不是连着发好几个 computer_* 调用——每个单独调用都要多一轮模型往返、一次确认和一张截图。\n" +
      "典型用法：点击输入框 → 输入文本 → 回车 → 截图。每步的 action 和参数与同名单独工具一致（click、type、key、hotkey、scroll、menu、screenshot、window_state、list_apps、list_windows、clipboard_read、clipboard_write）。\n" +
      "不要把需要先看结果再决定的步骤放进同一批：元素令牌要先 computer_window_state 拿到，拿令牌和用令牌应该分两次。",
    promptSnippet: "连续执行几步电脑操作",
    parameters: Type.Object({
      steps: Type.Array(
        Type.Object({
          action: Type.String({
            description: "click、type、key、hotkey、scroll、menu、screenshot、window_state、list_apps、list_windows、clipboard_read、clipboard_write",
          }),
          elementToken: Type.Optional(Type.String()),
          pid: Type.Optional(Type.Number()),
          windowId: Type.Optional(Type.String()),
          x: Type.Optional(Type.Number()),
          y: Type.Optional(Type.Number()),
          text: Type.Optional(Type.String()),
          key: Type.Optional(Type.String()),
          keys: Type.Optional(Type.Array(Type.String())),
          modifiers: Type.Optional(Type.Array(Type.String())),
          button: Type.Optional(Type.String()),
          count: Type.Optional(Type.Number()),
          direction: Type.Optional(Type.String()),
          amount: Type.Optional(Type.Number()),
          path: Type.Optional(Type.Array(Type.String())),
          query: Type.Optional(Type.String()),
          foreground: Type.Optional(Type.Boolean()),
          includeScreenshot: Type.Optional(Type.Boolean()),
          maxElements: Type.Optional(Type.Number()),
          onScreenOnly: Type.Optional(Type.Boolean()),
        }),
        { description: "按顺序执行的动作列表" },
      ),
    }),
    async execute(_id, params) {
      return call("batch", { steps: params.steps as any });
    },
  });
}
