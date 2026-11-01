import { Type, type TSchema } from "typebox";
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
  maxDepth?: number;
  maxDimension?: number;
  onScreenOnly?: boolean;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  durationMs?: number;
  stepsCount?: number;
  expect?: unknown[];
  stableSamples?: number;
  width?: number;
  height?: number;
  timeoutMs?: number;
  session?: string;
  conversationId?: string;
};

type ComputerResult = {
  text: string;
  images: Array<{ mimeType: string; data: string }>;
  structured?: string;
  structuredMeta?: string;
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
const PID = Type.Number({ description: "computer_list_apps 返回的应用 pid" });
const COORDINATE = Type.Number({ description: "屏幕坐标，单位是逻辑像素" });
const ACTION_BUTTON = Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")]));
const STATE_SELECTOR = Type.Object({
  role: Type.Optional(Type.String({ description: "无障碍 role" })),
  labelContains: Type.Optional(Type.String({ description: "标签包含的文字" })),
});
const STATE_ELEMENT = Type.Object({
  selector: STATE_SELECTOR,
  exists: Type.Optional(Type.Boolean()),
  valueEquals: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  selected: Type.Optional(Type.Boolean()),
});
const STATE_WINDOW = Type.Object({
  exists: Type.Optional(Type.Boolean()),
  bounds: Type.Optional(Type.Object({
    x: COORDINATE,
    y: COORDINATE,
    width: Type.Number({ description: "窗口宽度" }),
    height: Type.Number({ description: "窗口高度" }),
    tolerancePx: Type.Optional(Type.Number()),
  })),
});
const STATE_PREDICATE = Type.Object({
  window: Type.Optional(STATE_WINDOW),
  element: Type.Optional(STATE_ELEMENT),
});

const BATCH_SCOPE = {
  pid: Type.Optional(PID),
  windowId: Type.Optional(WINDOW_ID),
};

function batchStep(action: string, fields: Record<string, TSchema> = {}): TSchema {
  return Type.Object({ action: Type.Literal(action), ...BATCH_SCOPE, ...fields });
}

const BATCH_STEP = Type.Union([
  batchStep("screenshot"),
  batchStep("list_apps"),
  batchStep("list_windows", { onScreenOnly: Type.Optional(Type.Boolean()) }),
  batchStep("window_state", {
    pid: PID,
    windowId: WINDOW_ID,
    query: Type.Optional(Type.String()),
    includeScreenshot: Type.Optional(Type.Boolean()),
    maxElements: Type.Optional(Type.Number()),
    maxDepth: Type.Optional(Type.Number()),
    maxDimension: Type.Optional(Type.Number()),
  }),
  batchStep("click", {
    elementToken: Type.Optional(Type.String()),
    x: Type.Optional(COORDINATE),
    y: Type.Optional(COORDINATE),
    button: ACTION_BUTTON,
    count: Type.Optional(Type.Number()),
    foreground: Type.Optional(Type.Boolean()),
  }),
  batchStep("type", { text: Type.String(), pid: Type.Optional(PID), windowId: Type.Optional(WINDOW_ID) }),
  batchStep("key", { key: Type.String(), modifiers: Type.Optional(Type.Array(Type.String())) }),
  batchStep("hotkey", { keys: Type.Array(Type.String()), modifiers: Type.Optional(Type.Array(Type.String())) }),
  batchStep("scroll", {
    x: COORDINATE,
    y: COORDINATE,
    direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")])),
    amount: Type.Optional(Type.Number()),
  }),
  batchStep("drag", {
    fromX: COORDINATE,
    fromY: COORDINATE,
    toX: COORDINATE,
    toY: COORDINATE,
    durationMs: Type.Optional(Type.Number()),
    stepsCount: Type.Optional(Type.Number()),
    button: ACTION_BUTTON,
    modifiers: Type.Optional(Type.Array(Type.String())),
  }),
  batchStep("move_cursor", { x: COORDINATE, y: COORDINATE }),
  batchStep("screen_size"),
  batchStep("set_window_frame", {
    pid: PID,
    windowId: WINDOW_ID,
    x: COORDINATE,
    y: COORDINATE,
    width: Type.Number(),
    height: Type.Number(),
  }),
  batchStep("cursor_position"),
  batchStep("cursor_state"),
  batchStep("verify_state", {
    pid: PID,
    windowId: WINDOW_ID,
    expect: Type.Array(STATE_PREDICATE, { minItems: 1, maxItems: 8 }),
    timeoutMs: Type.Optional(Type.Number()),
    stableSamples: Type.Optional(Type.Number()),
    includeScreenshot: Type.Optional(Type.Boolean()),
  }),
  batchStep("menu", { pid: PID, windowId: WINDOW_ID, path: Type.Array(Type.String()) }),
  batchStep("clipboard_read"),
  batchStep("clipboard_write", { text: Type.String() }),
]);

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
    return {
      content,
      details: result.structured || result.structuredMeta
        ? {
            ...(result.structured ? { structured: result.structured } : {}),
            ...(result.structuredMeta ? { structuredMeta: result.structuredMeta } : {}),
          }
        : undefined,
    };
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
      maxDepth: Type.Optional(Type.Number({ description: "最多读取无障碍树的深度" })),
      maxDimension: Type.Optional(Type.Number({ description: "截图最长边上限，单位是像素" })),
    }),
    async execute(_id, params) {
      return call("window_state", {
        pid: params.pid,
        windowId: params.windowId,
        query: params.query,
        includeScreenshot: params.includeScreenshot,
        maxElements: params.maxElements,
        maxDepth: params.maxDepth,
        maxDimension: params.maxDimension,
      });
    },
  });

  pi.registerTool({
    name: "computer_drag",
    label: "拖动",
    description:
      "把鼠标从起点拖到终点。用于拖动滑块、调整窗口或移动文件。优先先读取窗口状态；坐标必须基于最新截图或元素 frame，拖动后再用 computer_verify_state 或 computer_window_state 验证结果。",
    promptSnippet: "拖动鼠标",
    parameters: Type.Object({
      fromX: COORDINATE,
      fromY: COORDINATE,
      toX: COORDINATE,
      toY: COORDINATE,
      pid: Type.Optional(PID),
      windowId: Type.Optional(WINDOW_ID),
      durationMs: Type.Optional(Type.Number({ description: "拖动持续时间，毫秒" })),
      stepsCount: Type.Optional(Type.Number({ description: "拖动分成多少步" })),
      button: ACTION_BUTTON,
      modifiers: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) {
      return call("drag", params);
    },
  });

  pi.registerTool({
    name: "computer_move_cursor",
    label: "移动鼠标",
    description: "把可见的 Agent Cursor 移到屏幕坐标。只用于定位或让用户看清下一步，不会点击。",
    promptSnippet: "移动鼠标",
    parameters: Type.Object({
      x: COORDINATE,
      y: COORDINATE,
      pid: Type.Optional(PID),
      windowId: Type.Optional(WINDOW_ID),
    }),
    async execute(_id, params) {
      return call("move_cursor", params);
    },
  });

  pi.registerTool({
    name: "computer_screen_size",
    label: "读取屏幕尺寸",
    description: "读取 CUA 当前桌面的逻辑尺寸。只有在必须使用坐标且最新窗口状态没有足够坐标信息时调用。",
    promptSnippet: "读取屏幕尺寸",
    parameters: Type.Object({}),
    async execute() {
      return call("screen_size");
    },
  });

  pi.registerTool({
    name: "computer_set_window_frame",
    label: "调整窗口",
    description:
      "移动或调整指定窗口的大小。先用 computer_list_windows 读取当前 bounds 和 screen size，完成后用 computer_window_state 或 computer_verify_state 确认目标窗口仍然正确。",
    promptSnippet: "调整窗口位置或大小",
    parameters: Type.Object({
      pid: PID,
      windowId: WINDOW_ID,
      x: COORDINATE,
      y: COORDINATE,
      width: Type.Number({ description: "窗口宽度" }),
      height: Type.Number({ description: "窗口高度" }),
    }),
    async execute(_id, params) {
      return call("set_window_frame", params);
    },
  });

  pi.registerTool({
    name: "computer_cursor_position",
    label: "读取鼠标位置",
    description: "读取当前 Agent Cursor 的位置，用于继续拖动或解释上一步坐标动作。",
    promptSnippet: "读取鼠标位置",
    parameters: Type.Object({}),
    async execute() {
      return call("cursor_position");
    },
  });

  pi.registerTool({
    name: "computer_cursor_state",
    label: "读取指针状态",
    description: "读取 Agent Cursor 是否启用及其主题、动画和当前位置。",
    promptSnippet: "读取指针状态",
    parameters: Type.Object({}),
    async execute() {
      return call("cursor_state");
    },
  });

  pi.registerTool({
    name: "computer_verify_state",
    label: "验证界面状态",
    description:
      "等待并验证指定窗口是否达到预期状态。用在点击、输入或拖动之后，避免只凭动作返回成功就继续。expect 中的多个条件必须同时满足；超时会返回未满足的条件和最后一次观测。",
    promptSnippet: "验证界面状态",
    parameters: Type.Object({
      pid: PID,
      windowId: WINDOW_ID,
      expect: Type.Array(STATE_PREDICATE, { minItems: 1, maxItems: 8 }),
      timeoutMs: Type.Optional(Type.Number({ description: "最多等待多少毫秒，0 表示只检查一次" })),
      stableSamples: Type.Optional(Type.Number({ description: "连续满足多少次才算稳定" })),
      includeScreenshot: Type.Optional(Type.Boolean({ description: "同时返回最后一次窗口截图" })),
    }),
    async execute(_id, params) {
      return call("verify_state", params);
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
      "一次执行一串动作，按顺序跑，任何一步失败就停下并告诉你停在第几步。适合把不依赖中间观测的点击、输入、按键和截图合并，减少模型往返。需要先读结果再决定的步骤不要合并，例如 elementToken 必须来自前一次 computer_window_state。动作列表支持 screenshot、list_apps、list_windows、window_state、click、type、key、hotkey、scroll、drag、move_cursor、screen_size、set_window_frame、cursor_position、cursor_state、verify_state、menu、clipboard_read、clipboard_write。",
    promptSnippet: "连续执行几步电脑操作",
    parameters: Type.Object({
      steps: Type.Array(BATCH_STEP, { minItems: 1, maxItems: 32 }),
    }),
    async execute(_id, params) {
      return call("batch", { steps: params.steps as any });
    },
  });
}
