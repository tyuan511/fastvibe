import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type BrowserRequest = {
  action: string;
  tabId?: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  script?: string;
};

type BrowserBridge = (request: BrowserRequest) => Promise<unknown>;

function bridge(): BrowserBridge {
  const handler = (globalThis as Record<string, unknown>).__fastvibeBrowserRequest;
  if (typeof handler !== "function") throw new Error("内置浏览器桥接尚未就绪");
  return handler as BrowserBridge;
}

async function call(action: string, params: Omit<BrowserRequest, "action"> = {}): Promise<any> {
  const result = await bridge()({ action, ...params });
  return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }], details: result };
}

/** Browser-use tools backed by FastVibe's side-pane Electron webview. */
export default function browserUse(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "browser_open",
    label: "打开浏览器",
    description: "打开或复用 FastVibe 内置浏览器标签页。返回 tabId，后续操作都应传入它。",
    promptSnippet: "打开内置浏览器并访问网址",
    parameters: Type.Object({ url: Type.Optional(Type.String({ description: "网址，可省略" })) }),
    async execute(_id, params) { return call("open", { url: params.url }); },
  });

  pi.registerTool({
    name: "browser_list_tabs",
    label: "浏览器标签页",
    description: "列出内置浏览器当前可控制的标签页。",
    promptSnippet: "查看浏览器标签页",
    parameters: Type.Object({}),
    async execute() { return call("list"); },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "浏览器导航",
    description: "在指定标签页打开网址。",
    promptSnippet: "浏览器访问网址",
    parameters: Type.Object({ tabId: Type.String(), url: Type.String() }),
    async execute(_id, params) { return call("navigate", params); },
  });

  pi.registerTool({
    name: "browser_search",
    label: "浏览器搜索",
    description: "使用内置浏览器搜索引擎搜索关键词，并在完成后返回当前页面地址。",
    promptSnippet: "在内置浏览器中搜索关键词",
    parameters: Type.Object({ tabId: Type.String(), query: Type.String() }),
    async execute(_id, params) { return call("search", { tabId: params.tabId, text: params.query }); },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "浏览器页面快照",
    description: "读取当前页面标题、URL、可见文本和可交互元素。每次点击或导航后先重新快照。",
    promptSnippet: "读取网页内容和可交互元素",
    parameters: Type.Object({ tabId: Type.Optional(Type.String()) }),
    async execute(_id, params) { return call("snapshot", params); },
  });

  pi.registerTool({
    name: "browser_click",
    label: "浏览器点击",
    description: "点击页面上的 CSS selector，或按可见文字匹配按钮/链接。",
    promptSnippet: "点击网页元素",
    parameters: Type.Object({ tabId: Type.String(), selector: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }),
    async execute(_id, params) { return call("click", params); },
  });

  pi.registerTool({
    name: "browser_type",
    label: "浏览器输入",
    description: "向 input/textarea/select 目标填入文字，并触发 input/change 事件。",
    promptSnippet: "在网页输入框中填写文字",
    parameters: Type.Object({ tabId: Type.String(), selector: Type.String(), text: Type.String() }),
    async execute(_id, params) { return call("type", params); },
  });

  pi.registerTool({
    name: "browser_press",
    label: "浏览器按键",
    description: "向当前焦点元素发送键盘按键，例如 Enter、Tab、Escape。",
    promptSnippet: "发送浏览器键盘按键",
    parameters: Type.Object({ tabId: Type.String(), key: Type.String() }),
    async execute(_id, params) { return call("press", params); },
  });

  pi.registerTool({
    name: "browser_history",
    label: "浏览器历史",
    description: "在标签页中后退、前进或刷新。",
    promptSnippet: "控制浏览器历史和刷新",
    parameters: Type.Object({ tabId: Type.String(), action: Type.Union([Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload")]) }),
    async execute(_id, params) { return call(params.action, { tabId: params.tabId }); },
  });
}
