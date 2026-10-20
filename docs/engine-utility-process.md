# 把引擎移出主进程（`utilityProcess`）：评估，未实施

状态：**没有做**。这份文档记下查到的事实、真正的难点和动手的判定条件，免得下一个人从零再查一遍。

## 为什么还没做

主进程一个线程同时承载：agent 引擎（每个会话的流、压缩、工具）、事件分发、git、远程服务器、WebRTC、窗口 IPC。
理论上一段长的同步代码会拖住所有这些。但**没有数据说明这在实际使用里发生得多频繁**——直到
`[loop]` 日志（`watchEventLoop`，`engine/startup-timeline.ts`）加进来，日志里才有这一项。
先看数据，再决定值不值得做下面这件大事。

## 已经查实的事实

- **引擎本身已经不依赖 Electron。** 从 `pi/process-manager.ts` 出发可达 116 个模块，其中没有一个直接
  `import "electron"`。`src/agent/` 用 583 行把同一个引擎跑成无头服务（SSH 主机上的 Agent 就是它）。
  所以「引擎在子进程里跑」本身不需要拆引擎。
- **缝在主进程这一侧。** 桌面端直接调用引擎：`engine.*` 在 `index.ts`、`ipc/desktop-handlers.ts`、
  `ipc/engine-handlers.ts`、`ipc/dag-handlers.ts`、`ipc/schedule-handlers.ts`、`engine/ai-language.ts`、
  `engine/pi-global-sync.ts` 里共 137 个不同方法、168 处调用。远程网关的 `localDispatch` / `localSnapshot`
  是现成的单点入口，事件走 `engine.onEvent` 等订阅。
- **无头 Agent 已经证明引擎可以脱离 Electron 运行**，所以风险不在「能不能」，在下面这些行为差异。

## 真正的难点（按风险排序）

1. **同步访问器。** `engine.listWorkspace()`、`engine.status`、`engine.hasEnabledSchedules()` 等在主进程里是同步调用。
   跨进程只能是异步，每个同步调用点要么改成 await，要么由主进程维护一份随事件更新的镜像。这是工作量的大头，
   也是最容易引入「读到旧值」的地方。
2. **网络代理。** 桌面端的 Node 请求经 `installNodeProxy` 向 Chromium 会话问代理（`defaultSession.resolveProxy`），
   包括系统代理和 PAC。子进程没有这个会话；无头 Agent 只认环境变量代理（`configureAgentHttpProxy`）。
   直接搬会让配置了系统代理的用户的供应商请求绕过代理。解法是把「这个 URL 走哪个代理」做成回主进程的 RPC。
3. **浏览器与电脑操控桥。** `browser_*` 工具通过 `browser:request` 找渲染进程里的 `<webview>`，`computer_*` 走 cua 桥，
   这些在主进程内是一次函数调用，搬走后要多一跳 RPC，且超时与取消语义要重新核对。
4. **SQLite 只能有一个写者。** 目录、检查点、记忆账本、排队消息都在 `fastvibe.db`，设计是「一个进程一个连接」。
   搬走后所有读写 `fastvibe.db` 的代码必须都在子进程里，主进程不能再 `openDatabase`
   （`index.ts` 里现在就有，用于 `MemoryManager`）。
5. **`MemoryManager` 由主进程构造后注入引擎。** 要一起移走，`memory:*` 的变更事件也得走同一条通道。
6. **事件量。** 流式 delta 已经在源头节流（`ToolDeltaThrottle`），但跨进程要结构化克隆；大转写快照会是
   MB 级的消息。需要沿用 `server/backpressure.ts` 的思路，不能靠丢事件缓解。
7. **macOS 文件夹授权。** `folder-consent` 故意在主线程 stat 受保护目录，因为系统只记得自己弹的文件夹对话框
   来自哪个进程。子进程里 stat 是否归到同一个应用，**没验证过**，需要在打包后的应用上实测。
8. **终端（node-pty）** 可以留在主进程，不是阻塞项。

## 判定条件

- 观察一周正常使用的 `main.log`。`[loop] event loop stalled up to N ms` 每小时出现不到几次、最大值在 300 ms 以内：
  不值得做，把精力放在定位那几次卡顿的同步代码上，用 `worker_threads` 或拆分就能解决。
- 常见 500 ms 以上、且和流式输出、会话切换同时出现：值得做，按下面的顺序分阶段。
- 同时看 `[startup]` 行：它能告诉你启动路径上还有哪一段值得压缩，比移进程便宜得多。

## 分阶段（每一步都能单独发布、单独回退）

1. **数据**：`[loop]` 与 `[startup]`（已完成）。
2. **只读通道**：子进程只跑引擎，主进程仍保留自己的实例；子进程只服务一个新开的、默认关闭的「实验」开关，
   用来验证消息体积、背压和代理 RPC，不碰用户数据。
3. **单写者切换**：`fastvibe.db` 的所有使用方移入子进程，主进程改用代理对象；同步访问器改成镜像。
4. **桥接**：浏览器桥、电脑操控桥、代理解析各自改成回主进程的 RPC。
5. **默认开启**，保留一个环境变量开关回到进程内引擎，直到至少一个发布周期没有回归。

没有第 2 步的验证，不要进第 3 步：第 3 步之后用户数据只有一个写者，回退成本很高。
