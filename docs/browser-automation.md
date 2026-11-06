# 浏览器自动化

本文说明 FastVibe 对 `agent-browser` 思路的集成方式。当前继续使用 FastVibe 管理的浏览器和 `browser_*` 工具，没有引入外部 CLI、daemon 或另一份浏览器 profile。工程接入约束见 [扩展与工具桥接](engineering/extensions.md)。

## 两种后端

- 内嵌浏览器：侧边栏的 Electron `<webview>`，标签页、会话归属、后台停放和页面重建由 renderer 管理。
- 系统浏览器：FastVibe 启动的独立 Chrome/Edge 等 Chromium 窗口，使用 FastVibe 专用 profile，经 CDP 连接。

公共请求仍为 `src/shared/types.ts` 的 `BrowserRequest`。工具名、可选 `tabId`、默认复用标签页及 `newTab: true` 保持兼容。现有 Cookie 导入分别写入内嵌 partition 或系统 profile。

## 快照与模型上下文

`browser_snapshot` 的结果有三个消费面：

| 消费面 | 内容 |
| --- | --- |
| `content` | 模型阅读的紧凑语义文本，包含页面位置、角色、名称、Ref、必要的控件状态和正文 |
| `structuredContent` | Codemode 直接读取的对象，保留 `tabId/url/title/text/elementCount/truncated/elements` |
| `details` | 界面与诊断使用的完整结果 |

快照额外提供 `snapshotId`、`source`、`complete` 和 `nodes`。`elements` 仍保留 `ref/selector/tag/text/name/href` 等字段，脚本继续使用 `page.elements.find(...)`，不应解析模型文本。新增可选信息包括 accessible name、控件状态、当前非敏感值和语义层级。

默认 `snapshotMode: "dom"` 保持 DOM 语义快照；`snapshotMode: "accessibility"` 则通过 CDP 读取 Chromium 的 Accessibility 树。后者使用 `backendDOMNodeId`、私有 execution context 与 `Runtime.callFunctionOn` 绑定精确 DOM 节点，交互仍走共用输入执行层，不通过名称猜测同名控件。

两种模式都有节点数、语义深度和正文长度预算。`complete: false` 表示观测有截断或未展开的边界，`truncated` 表示输出预算截断；`source`、`capabilities`、`limitations` 和预算信息用于解释当前观测范围，不能把未显示的控件当成不存在。AX 虚拟节点可以提供语义信息，没有精确 DOM 地址的节点不分配可操作 Ref。

密码与文件输入框不输出其值。DOM 模式检测但不展开 iframe 和 open shadow root；AX 模式支持可证明身份的主 frame / open shadow DOM 节点，跨 frame 内容仍作为边界报告。跨域 OOPIF 的独立 session、frame 坐标和输入路由尚未接入，不能通过这些 Ref 操作 iframe 内部。没有像素识别或 canvas 内容理解。

## 按区域读取

`browser_snapshot` 新增参数：

| 参数 | 行为 |
| --- | --- |
| `snapshotMode` | `dom`（默认）或 `accessibility` |
| `selector` | CSS selector 必须匹配一个区域；零匹配、多匹配或非法选择器直接失败 |
| `rootRef` | 用最近快照中的精确节点作为区域根，与 `selector` 互斥 |
| `maxDepth` | 限制语义层级，范围 1–50，默认 50 |
| `maxElements` | 限制返回的语义节点数（含容器），范围 1–500，默认 150 |

正文也仅读取选中区域。达到深度或节点预算时保留可下钻容器的 Ref 和 `childrenCount`；模型文本以 `[scope]` 区分用于读取区域的容器，以 `[truncated]` 标出尚未展示的子树。容器 Ref 不能当作可交互按钮点击。

例如先读取浅层结构，再定位目标区域：

```js
const page = await tools.browser_snapshot({ tabId, snapshotMode: 'accessibility', maxDepth: 2 });
// 根据本次 nodes 中的目标容器选择 ref，而不是根据名称编造 ref。
const walk = nodes => nodes.flatMap(node => [node, ...walk(node.children ?? [])]);
const region = walk(page.nodes).find(node => node.role === 'region' && node.name === 'Settings');
if (!region?.ref) return page;
return await tools.browser_snapshot({ tabId, snapshotMode: 'accessibility', rootRef: region.ref, maxDepth: 5 });
```

每次成功快照都会替换整个 Ref 命名空间，下钻也会使旧 Ref（包括传入的根 Ref）失效。AX 输出区域化降低返回上下文，但底层仍可能读取完整主 frame AX 树，不能据此承诺等比例降低扫描耗时。

## Ref 生命周期

Ref 是不透明字符串，调用者必须原样传回，不拼接、不解析、不假定是 `e0`。每次快照生成新的命名空间，内部 Map 保存 Ref 对应的原始 DOM 对象。页面上的 `data-fv-ref` 仅作标记，不参与权威寻址。自动化脚本运行在私有 isolated world：两种后端能附加 CDP 时，通过 `Page.createIsolatedWorld` 获取命名 execution context；Electron guest 只有在 debugger 不可用且使用 DOM 模式时才退到专用 world 1001。AX 不可用会明确报错，不伪装成原生无障碍快照。快照、条件探测和输入共用当前隔离环境；world 切换或重新附加后，宿主也会阻止旧 Ref 恢复有效。

- 再次快照会使上一轮 Ref 失效。
- 页面导航、重载或 guest 重建后，旧 Ref 失效。
- 原节点被移除或替换后，旧 Ref 失效；克隆其属性不能冒用身份。
- 传入 Ref 时只使用该 Ref。解析失败返回 `STALE_REF`，不会静默改用 selector 或文字命中另一个目标。
- 未传 Ref 才采用 selector / 文字定位。错误、超时及恢复后先重新观测，再决定是否重试。

`browser_wait` 的探测不生成快照，因此不会重置 Ref。页面变化后仍应重新快照，不应依赖旧节点碰巧尚未移除。

## 原生输入

原生输入由共用的 `src/main/engine/browser-input.ts` 执行，经通道适配到 Chromium CDP `Input` 域和 Electron guest 的原生文本插入能力。它是浏览器输入注入，不是系统物理硬件事件，也不保证通过网站反自动化验证。

- 点击：定位当前元素、滚动、检查可见性/禁用/遮挡，计算 CSS viewport 坐标，再投递鼠标事件。
- 按键：使用 Chromium 键盘事件，支持命名键和修饰键；不支持的键在投递前拒绝。
- 填值：保留 `browser_type` 的替换语义，对普通文本框、textarea 和 contenteditable 选中当前内容后输入，再读取结果确认。系统 Chrome 使用 `Input.insertText`；内嵌 guest 使用 Electron `insertText()`，结果标记为 `electron-input`，避免停放 guest 中 CDP 文本插入投向宿主渲染目标。内嵌动作临时启用页面焦点仿真，并在成功、失败和中止后关闭，不激活 OS 窗口。
- select、checkbox、radio 使用原有语义填值，结果明确标记 `page-script-fallback`。

原生点击的投递成功只表示 Chromium 接收了事件，不代表业务提交完成。应接 `browser_wait` 或重新快照观察结果。输入返回的 `verification` 也只说明其明确检查过的条件。

动作开始后发生连接断开或超时，可能已经生效。结果必须保留 `delivery` 和 `retry` 信息，不能自动改用脚本再点一次。Stop/超时在异步边界阻止后续输入，已投递动作不能撤销；按键和鼠标的释放清理仍需完成。

## 验证与后续

针对性验证入口：

```bash
FASTVIBE_TEST_CHROME='/path/to/chrome' node --test test/browser-script.test.ts test/browser-snapshot-options.test.ts test/browser-cdp-input.test.ts test/browser-snapshot-chromium.test.ts test/browser-accessibility.test.ts test/browser-accessibility-chromium.test.ts
FASTVIBE_TEST_ELECTRON=1 node --test test/browser-guest-input.test.ts
node --test test/server-policy.test.ts test/browser-workspace.test.ts
pnpm check:scripts
pnpm typecheck
git diff --check
```

真实 Chromium 测试使用独立临时 profile 和本地 fixture，不使用用户的浏览器配置。运行方式及实际覆盖以测试文件为准。单元测试中的桥替身只能证明协议与调用顺序，不能替代 Electron guest 的真实输入验证。

当前 fixture 已加入区域、shadow 和 iframe 案例。最后一轮整体验证使用 `gpt-tokenizer@4.1.0`（`o200k_base`），结果如下：

| 指标 | 旧字段整页 JSON | 当前整页 compact | 目标区域 compact |
| --- | ---: | ---: | ---: |
| UTF-8 字节 | 4,481 | 3,290 | 776 |
| Token | 1,310 | 1,085 | 237 |

该 fixture 的整页格式压缩减少约 17% token；区域读取相对当前整页减少约 78% token。前者和后者是不同的比较，不能把区域收益解释为整页格式压缩保证，也不能将新增案例后的结果与首轮较小 fixture 直接比较。随机 Ref 会使 token 数波动；测试提供可选 `FASTVIBE_TEST_TOKENIZER` 指向已安装模块，无需增加产品依赖。

真实回归覆盖 DOM/AX 两种来源、深层 scope、同名按钮、旧 Ref、open shadow 精确输入、密码/文件值抑制、CSS 隐藏正文过滤、iframe 边界、Stop 和临时远程对象释放。Electron 测试同时验证隐藏停放 webview 的输入及窗口焦点不变。

下一阶段独立评估：iframe / OOPIF 的独立 CDP session 与输入坐标、closed shadow root 的支持边界、注释截图和录制。每项都需要两种后端的行为验证后才能作为默认能力。
