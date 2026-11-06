import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Type-only: erased when the resource extension is loaded from a packaged app.
import type { BrowserRequest } from "../../src/shared/types";

type BrowserBridge = (request: BrowserRequest, signal?: AbortSignal) => Promise<unknown>;

function bridge(): BrowserBridge {
  const handler = (globalThis as Record<string, unknown>).__fastvibeBrowserRequest;
  if (typeof handler !== "function") throw new Error("内置浏览器桥接尚未就绪");
  return handler as BrowserBridge;
}

function boundConversationId(): string | undefined {
  const value = (globalThis as Record<string, unknown>).__fastvibeBrowserConversationId;
  return typeof value === "string" && value ? value : undefined;
}

const TAB_ID = (required: boolean) => {
  const schema = Type.String({
    description: "browser_open 返回的 tabId；省略则使用最近打开的标签页",
  });
  return required ? schema : Type.Optional(schema);
};

/** Loading a page can outlast the bridge's default 30s, so say so per action. */
const LOAD_TIMEOUT = 45_000;

const OBJECT_RESULT = Type.Object({}, { additionalProperties: true });
const TAB_RESULT = Type.Object({ tabId: Type.String(), url: Type.String() }, { additionalProperties: true });
const SNAPSHOT_RESULT = Type.Object({
  tabId: Type.String(), url: Type.String(), title: Type.String(), text: Type.String(),
  elementCount: Type.Number(), truncated: Type.Boolean(),
  snapshotId: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  complete: Type.Optional(Type.Boolean()),
  nodes: Type.Optional(Type.Array(Type.Any())),
  elements: Type.Array(Type.Object({
    ref: Type.String({ description: "快照中的不透明 ref 字符串（如 sAbCdEf12345:e3），操作时须完整原样传回，不要解析或拼接" }), selector: Type.String(), tag: Type.String(), text: Type.String(),
    type: Type.Optional(Type.String()), role: Type.Optional(Type.String()),
    value: Type.Optional(Type.String()), placeholder: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()), href: Type.Optional(Type.String()), disabled: Type.Optional(Type.Boolean()),
    accessibleName: Type.Optional(Type.String()), states: Type.Optional(OBJECT_RESULT),
  })),
}, { additionalProperties: true });
/** Model-facing text only; scripts and the UI retain the complete structured result. */
export function formatBrowserSnapshot(page: Record<string, any>): string {
  const quote = (value: unknown) => JSON.stringify(String(value ?? ''));
  const lines = [`Tab: ${page.tabId ?? ''}`, `URL: ${page.url ?? ''}`, `Title: ${quote(page.title)}`];
  if (page.source && page.source !== 'dom-semantics') lines.push(`Source: ${page.source}`);
  if (page.scope && (typeof page.scope === 'string' || page.scope.kind !== 'document')) lines.push(`Scope: ${quote(typeof page.scope === 'string' ? page.scope : JSON.stringify(page.scope))}`);
  if (page.note) lines.push(`Note: ${page.note}`);
  if (Array.isArray(page.limitations)) for (const limitation of page.limitations) lines.push(`Limitation: ${limitation}`);
  const represented = new Set<string>();
  const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const render = (node: Record<string, any>, depth: number) => {
    const name = node.name ?? node.accessibleName ?? node.text;
    if (normalize(name)) represented.add(normalize(name));
    const fields = ['type', 'value', 'placeholder']
      .filter(key => node[key] !== undefined && !(key === 'value' && /^(password|file)$/i.test(node.type ?? '')))
      .map(key => `${key}=${quote(node[key])}`).join(' ');
    const states = Object.entries(node.states ?? {})
      .filter(([, value]) => value !== undefined && value !== false && value !== 'false')
      .map(([key, value]) => `${key}=${value}`).join(' ');
    const childrenCount = node.childrenCount ?? node.children_count;
    const missingChildren = childrenCount !== undefined && childrenCount > (node.children?.length ?? 0);
    const boundary = missingChildren ? ` [children=${childrenCount}]` : '';
    const truncated = missingChildren || node.subtreeTruncated || node.subtree_truncated ? ' [truncated]' : '';
    const scopeTarget = node.ref && node.targetType === 'container' ? ' [scope]' : '';
    lines.push(`${'  '.repeat(Math.min(depth, 12))}- ${node.role ?? node.tag ?? 'group'} ${quote(node.name ?? node.accessibleName ?? node.text)}${node.ref ? ` [ref=${node.ref}]` : ''}${scopeTarget}${states ? ` [${states}]` : ''}${fields ? ` ${fields}` : ''}${node.href ? ` ${quote(node.href)}` : ''}${boundary}${truncated}`);
    for (const child of node.children ?? []) render(child, depth + 1);
  };
  if (Array.isArray(page.nodes)) for (const node of page.nodes) render(node, 0);
  else for (const element of page.elements ?? []) render({ ...element, name: element.accessibleName ?? element.text }, 0);
  // Only remove whole lines exactly represented by semantic names. Substrings,
  // validation messages and extended status prose must survive.
  const remainingText = String(page.text ?? '').split('\n')
    .filter(line => !normalize(line) || !represented.has(normalize(line))).join('\n').trim();
  if (remainingText) lines.push('', 'Page text:', remainingText);
  if (page.truncated || page.complete === false) lines.push('[Partial snapshot: content was truncated.]');
  return lines.join('\n');
}

const BATCH_GUIDELINES = [
  "codemode 可用时，连续浏览器步骤优先写成一次脚本：await tools.browser_*(args)，用条件、循环处理结构化返回值，只 text()/return 必要结果。单步操作或 codemode 不可用时直接调用 browser_*。",
  "同一标签页的操作与快照必须顺序 await；不同标签页的独立读取才可并行。根据最新快照定位，导航后重新快照；异步页面用 browser_wait 等条件，不反复请求模型或固定睡眠。",
  "浏览器调用失败会抛错并停止脚本，已完成操作不会回滚。不要捕获失败后继续提交；打印必要进度以保留失败前的证据。",
];

/** Browser-use tools backed by FastVibe's side-pane Electron webview. */
export default function browserUse(pi: ExtensionAPI): void {
  // Closed over at factory time: the host stamps the conversation around reload,
  // and execute() must not read the global later (another session may have loaded).
  const conversationId = boundConversationId();
  async function call(action: string, params: Omit<BrowserRequest, "action"> = {}, signal?: AbortSignal): Promise<any> {
    const result = await bridge()({ action, ...params, conversationId }, signal);
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const outcome = result as Record<string, unknown>;
      // Throw instead of returning structured error data: codemode deliberately resolves
      // structuredContent even for isError results, which would let a form keep submitting.
      if (["ok", "clicked", "filled", "loaded"].some((key) => outcome[key] === false)) {
        throw new Error(`browser_${action}: ${JSON.stringify(result)}`);
      }
    }
    return {
      content: [{ type: "text", text: action === "snapshot" && result && typeof result === "object"
        ? formatBrowserSnapshot(result as Record<string, any>)
        : typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
      details: result,
      structuredContent: result,
    };
  }
  pi.registerTool({
    name: "browser_open",
    outputSchema: TAB_RESULT,
    promptGuidelines: BATCH_GUIDELINES,
    label: "打开浏览器",
    description:
      "打开内置浏览器标签页并访问网址，返回 tabId（后续操作的默认目标）。省略 url 时会打开一个空白页——不会替你访问任何站点。默认复用已经打开的标签页——它会被导航到新网址，不会重复新建；只有确实需要同时保留两个页面时才传 newTab: true。连续操作优先在 codemode 中编写脚本，顺序 await tools.browser_*；返回结构化对象，失败会抛错停止后续步骤。",
    promptSnippet: "打开内置浏览器并访问网址",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "网址或搜索词，可省略" })),
      newTab: Type.Optional(Type.Boolean({ description: "在新标签页中打开，保留当前页面" })),
    }),
    async execute(_id, params, signal) {
      return call("open", { url: params.url, newTab: params.newTab, timeoutMs: LOAD_TIMEOUT }, signal);
    },
  });

  pi.registerTool({
    name: "browser_list_tabs",
    outputSchema: Type.Array(Type.Object({ tabId: Type.String(), url: Type.String(), title: Type.String(), alive: Type.Boolean() })),
    label: "浏览器标签页",
    description: "列出内置浏览器当前可控制的标签页（tabId、网址、标题）。",
    promptSnippet: "查看浏览器标签页",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return call("list", {}, signal);
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    outputSchema: TAB_RESULT,
    label: "浏览器导航",
    description: "在当前标签页打开网址（等待页面加载完成后再返回）。",
    promptSnippet: "浏览器访问网址",
    parameters: Type.Object({ tabId: TAB_ID(false), url: Type.String() }),
    async execute(_id, params, signal) {
      return call("navigate", { tabId: params.tabId, url: params.url, timeoutMs: LOAD_TIMEOUT }, signal);
    },
  });

  pi.registerTool({
    name: "browser_search",
    outputSchema: TAB_RESULT,
    label: "浏览器搜索",
    description: "用内置浏览器搜索引擎搜索关键词，加载完成后返回当前页面地址。",
    promptSnippet: "在内置浏览器中搜索关键词",
    parameters: Type.Object({ tabId: TAB_ID(false), query: Type.String() }),
    async execute(_id, params, signal) {
      return call("search", { tabId: params.tabId, text: params.query, timeoutMs: LOAD_TIMEOUT }, signal);
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    outputSchema: SNAPSHOT_RESULT,
    label: "浏览器页面快照",
    description:
      "读取页面快照。默认 snapshotMode=dom，返回紧凑 DOM 语义树和正文；snapshotMode=accessibility 读取浏览器原生无障碍树，并把可定位节点绑定为精确 ref。脚本仍获得 elements[]、text 等兼容字段。复杂页面可用 selector 或 rootRef 读取一个区域（两者互斥），maxDepth/maxElements 控制输出；带 childrenCount 的容器可用其 ref 下钻。每次快照会使所有旧 ref 失效；rootRef 必须来自最近一次快照。ref 是不透明字符串，必须完整原样传回。能力限制见 source/limitations，不能假定 iframe 已展开；STALE_REF 时重新快照。",
    promptSnippet: "读取网页内容和可交互元素",
    parameters: Type.Object({
      tabId: TAB_ID(false),
      snapshotMode: Type.Optional(Type.Union([Type.Literal("dom"), Type.Literal("accessibility")], { description: "默认 dom 保持兼容；accessibility 使用 CDP 原生无障碍树" })),
      selector: Type.Optional(Type.String({ minLength: 1, description: "只读取匹配的唯一区域，与 rootRef 互斥" })),
      rootRef: Type.Optional(Type.String({ minLength: 1, description: "最近快照中的容器 ref，完整原样传回；读取后所有旧 ref 均失效" })),
      maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "输出的最大语义层级；截断处可使用容器 ref 下钻" })),
      maxElements: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "最多返回的语义节点数（含容器），默认 150" })),
    }),
    async execute(_id, params, signal) {
      if (params.selector !== undefined && !params.selector.trim() || params.rootRef !== undefined && !params.rootRef.trim()) throw new Error("browser_snapshot requires non-empty selector/rootRef");
      if (params.selector !== undefined && params.rootRef !== undefined) throw new Error("browser_snapshot selector and rootRef are mutually exclusive");
      if (params.snapshotMode !== undefined && params.snapshotMode !== "dom" && params.snapshotMode !== "accessibility") throw new Error("browser_snapshot unknown snapshotMode");
      for (const [key, max] of [["maxDepth", 50], ["maxElements", 500]] as const) {
        const value = params[key];
        if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > max)) throw new Error(`browser_snapshot ${key} must be an integer between 1 and ${max}`);
      }
      return call("snapshot", { ...params, timeoutMs: LOAD_TIMEOUT }, signal);
    },
  });

  pi.registerTool({
    name: "browser_click",
    outputSchema: OBJECT_RESULT,
    label: "浏览器点击",
    description:
      "点击页面元素：优先传 ref 或 selector（都来自 browser_snapshot 的 elements），也可以用 text 按可见文字匹配。定位失败会抛错，错误中带 candidates（页面上可点击的文字）供你改用。",
    promptSnippet: "点击网页元素",
    parameters: Type.Object({
      tabId: TAB_ID(false),
      ref: Type.Optional(Type.String({ description: "最新快照中的不透明 ref 字符串，例如 sAbCdEf12345:e3；须完整原样传回，不要解析、截短或拼接" })),
      selector: Type.Optional(Type.String({ description: "CSS selector，例如 #submit 或 body > div:nth-of-type(2) > a" })),
      text: Type.Optional(Type.String({ description: "元素可见文字，作为兜底匹配" })),
    }),
    async execute(_id, params, signal) {
      return call("click", { tabId: params.tabId, ref: params.ref, selector: params.selector, text: params.text }, signal);
    },
  });

  pi.registerTool({
    name: "browser_type",
    outputSchema: OBJECT_RESULT,
    label: "浏览器输入",
    description:
      "向输入框、文本域、contenteditable 或 select 填入文字（会自动聚焦并触发 input/change 事件，配合 React 等框架的受控输入）。目标优先用 ref，其次 selector。",
    promptSnippet: "在网页输入框中填写文字",
    parameters: Type.Object({
      tabId: TAB_ID(false),
      ref: Type.Optional(Type.String({ description: "最新快照中的不透明 ref 字符串，例如 sAbCdEf12345:e3；须完整原样传回，不要解析、截短或拼接" })),
      selector: Type.Optional(Type.String({ description: "CSS selector" })),
      text: Type.String({ description: "要填入的文字；select 传选项文字或 value" }),
    }),
    async execute(_id, params, signal) {
      return call("type", { tabId: params.tabId, ref: params.ref, selector: params.selector, text: params.text }, signal);
    },
  });

  pi.registerTool({
    name: "browser_press",
    outputSchema: OBJECT_RESULT,
    label: "浏览器按键",
    description: "向当前焦点元素发送键盘按键，例如 Enter、Tab、Escape（Enter 常用于提交搜索框）。",
    promptSnippet: "发送浏览器键盘按键",
    parameters: Type.Object({ tabId: TAB_ID(false), key: Type.String() }),
    async execute(_id, params, signal) {
      return call("press", { tabId: params.tabId, key: params.key }, signal);
    },
  });

  pi.registerTool({
    name: "browser_wait",
    label: "等待浏览器页面",
    description: "等待页面条件满足再继续脚本：selector 对应可见元素、页面正文包含 text、地址包含 url；至少传一个，多个条件须同时满足。默认 10 秒，最多 60 秒；超时抛错，停止后续步骤。返回 matched、url、title，可接 browser_snapshot 读取新页面。",
    promptSnippet: "等待网页元素、文字或地址出现",
    outputSchema: Type.Object({ tabId: Type.String(), matched: Type.Boolean(), url: Type.String(), title: Type.String() }, { additionalProperties: true }),
    parameters: Type.Object({
      tabId: TAB_ID(false),
      selector: Type.Optional(Type.String({ minLength: 1 })),
      text: Type.Optional(Type.String({ minLength: 1 })),
      url: Type.Optional(Type.String({ minLength: 1 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })),
    }),
    async execute(_id, params, signal) {
      if (!params.selector && !params.text && !params.url) throw new Error("browser_wait requires selector, text or url");
      const timeoutMs = params.timeoutMs ?? 10_000;
      const deadline = Date.now() + timeoutMs;
      const waitSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
      let tabId = params.tabId;
      let last: Record<string, unknown> | undefined;
      try {
        do {
          waitSignal.throwIfAborted();
          const reply = await call("check", { ...params, tabId, timeoutMs: Math.max(1, deadline - Date.now()) }, waitSignal);
          waitSignal.throwIfAborted();
          last = reply.structuredContent as Record<string, unknown>;
          // Pin the first resolved tab, even if the user opens another during the wait.
          if (typeof last?.tabId === "string") tabId = last.tabId;
          if (last?.matched === true) return reply;
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await delay(Math.min(200, remaining), undefined, { signal: waitSignal });
        } while (Date.now() < deadline);
      } catch (error) {
        // The deadline also cancels an in-flight bridge request, not just the poll delay.
        if (signal?.aborted || !waitSignal.aborted) throw error;
      }
      throw new Error(`browser_wait timed out: ${JSON.stringify({ selector: params.selector, text: params.text, url: params.url, last })}`);
    },
  });

  pi.registerTool({
    name: "browser_history",
    outputSchema: OBJECT_RESULT,
    label: "浏览器历史",
    description: "在标签页中后退、前进或刷新（没有可用的历史记录时会直接说明）。",
    promptSnippet: "控制浏览器历史和刷新",
    parameters: Type.Object({
      tabId: TAB_ID(false),
      action: Type.Union([Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload")]),
    }),
    async execute(_id, params, signal) {
      return call(params.action, { tabId: params.tabId, timeoutMs: LOAD_TIMEOUT }, signal);
    },
  });
}
