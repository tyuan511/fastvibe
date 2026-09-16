import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type BrowserRequest = {
  action: string;
  tabId?: string;
  url?: string;
  selector?: string;
  ref?: string;
  text?: string;
  key?: string;
  script?: string;
  newTab?: boolean;
  timeoutMs?: number;
  conversationId?: string;
};

type BrowserBridge = (request: BrowserRequest) => Promise<unknown>;

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

/** Browser-use tools backed by FastVibe's side-pane Electron webview. */
export default function browserUse(pi: ExtensionAPI): void {
  // Closed over at factory time: the host stamps the conversation around reload,
  // and execute() must not read the global later (another session may have loaded).
  const conversationId = boundConversationId();
  async function call(action: string, params: Omit<BrowserRequest, "action"> = {}): Promise<any> {
    const result = await bridge()({ action, ...params, conversationId });
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }], details: result };
  }
  pi.registerTool({
    name: "browser_open",
    label: "打开浏览器",
    description:
      "打开内置浏览器标签页并访问网址，返回 tabId（后续操作的默认目标）。默认复用已经打开的标签页——它会被导航到新网址，不会重复新建；只有确实需要同时保留两个页面时才传 newTab: true。",
    promptSnippet: "打开内置浏览器并访问网址",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "网址或搜索词，可省略" })),
      newTab: Type.Optional(Type.Boolean({ description: "在新标签页中打开，保留当前页面" })),
    }),
    async execute(_id, params) {
      return call("open", { url: params.url, newTab: params.newTab, timeoutMs: LOAD_TIMEOUT });
    },
  });

  pi.registerTool({
    name: "browser_list_tabs",
    label: "浏览器标签页",
    description: "列出内置浏览器当前可控制的标签页（tabId、网址、标题）。",
    promptSnippet: "查看浏览器标签页",
    parameters: Type.Object({}),
    async execute() {
      return call("list");
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "浏览器导航",
    description: "在当前标签页打开网址（等待页面加载完成后再返回）。",
    promptSnippet: "浏览器访问网址",
    parameters: Type.Object({ tabId: TAB_ID(false), url: Type.String() }),
    async execute(_id, params) {
      return call("navigate", { tabId: params.tabId, url: params.url, timeoutMs: LOAD_TIMEOUT });
    },
  });

  pi.registerTool({
    name: "browser_search",
    label: "浏览器搜索",
    description: "用内置浏览器搜索引擎搜索关键词，加载完成后返回当前页面地址。",
    promptSnippet: "在内置浏览器中搜索关键词",
    parameters: Type.Object({ tabId: TAB_ID(false), query: Type.String() }),
    async execute(_id, params) {
      return call("search", { tabId: params.tabId, text: params.query, timeoutMs: LOAD_TIMEOUT });
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "浏览器页面快照",
    description:
      "读取当前页面：elements[] 列出可交互元素（每个带 ref 与 selector）、text 是可读正文。点击和输入优先使用元素上的 ref（其次 selector），比用文字匹配可靠得多。每次导航或点击后重新快照。",
    promptSnippet: "读取网页内容和可交互元素",
    parameters: Type.Object({ tabId: TAB_ID(false) }),
    async execute(_id, params) {
      return call("snapshot", { tabId: params.tabId, timeoutMs: LOAD_TIMEOUT });
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "浏览器点击",
    description:
      "点击页面元素：优先传 ref 或 selector（都来自 browser_snapshot 的 elements），也可以用 text 按可见文字匹配。找不到时会返回 candidates（页面上可点击的文字）供你改用。",
    promptSnippet: "点击网页元素",
    parameters: Type.Object({
      tabId: TAB_ID(false),
      ref: Type.Optional(Type.String({ description: "快照中的元素 ref，例如 e3" })),
      selector: Type.Optional(Type.String({ description: "CSS selector，例如 #submit 或 body > div:nth-of-type(2) > a" })),
      text: Type.Optional(Type.String({ description: "元素可见文字，作为兜底匹配" })),
    }),
    async execute(_id, params) {
      return call("click", { tabId: params.tabId, ref: params.ref, selector: params.selector, text: params.text });
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "浏览器输入",
    description:
      "向输入框、文本域、contenteditable 或 select 填入文字（会自动聚焦并触发 input/change 事件，配合 React 等框架的受控输入）。目标优先用 ref，其次 selector。",
    promptSnippet: "在网页输入框中填写文字",
    parameters: Type.Object({
      tabId: TAB_ID(false),
      ref: Type.Optional(Type.String({ description: "快照中的元素 ref，例如 e3" })),
      selector: Type.Optional(Type.String({ description: "CSS selector" })),
      text: Type.String({ description: "要填入的文字；select 传选项文字或 value" }),
    }),
    async execute(_id, params) {
      return call("type", { tabId: params.tabId, ref: params.ref, selector: params.selector, text: params.text });
    },
  });

  pi.registerTool({
    name: "browser_press",
    label: "浏览器按键",
    description: "向当前焦点元素发送键盘按键，例如 Enter、Tab、Escape（Enter 常用于提交搜索框）。",
    promptSnippet: "发送浏览器键盘按键",
    parameters: Type.Object({ tabId: TAB_ID(false), key: Type.String() }),
    async execute(_id, params) {
      return call("press", { tabId: params.tabId, key: params.key });
    },
  });

  pi.registerTool({
    name: "browser_history",
    label: "浏览器历史",
    description: "在标签页中后退、前进或刷新（没有可用的历史记录时会直接说明）。",
    promptSnippet: "控制浏览器历史和刷新",
    parameters: Type.Object({
      tabId: TAB_ID(false),
      action: Type.Union([Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload")]),
    }),
    async execute(_id, params) {
      return call(params.action, { tabId: params.tabId, timeoutMs: LOAD_TIMEOUT });
    },
  });
}
