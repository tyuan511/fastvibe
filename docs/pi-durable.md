# 从 Pi Durable 可参考的点

Pi Durable（`@earendil-works/pi-durable`）是 Earendil 在 2026-10-01 与 Pi 1.0 一起发出的实验性 harness，说明见 [Pi Durable](https://earendil.com/posts/pi-durable/)。它不替换 `@earendil-works/pi-coding-agent`，API 也会变。FastVibe 不迁过去。

帖子把现在的 coding agent 定义成「一个人、一个终端、进程死了就看一眼再让它继续」。Durable 要的是另一类应用：任意 JS 运行时、多个界面同时看、对话可以很长、进程崩了接着跑、多个人能改同一条对话。FastVibe 已经在 coding agent 上自己补了其中大部分：多会话、snapshot + `seq`、`canResume`、fork、压缩、handoff、todo、子 agent、steer。下面只记还能在现有引擎上改的行为，不换 harness，也不改转写格式。

## 值得做

### 1. 停在工具上的运行要能继续，而且默认不重跑工具

`canResumeRun`（`src/main/engine/resume.ts`）只把两种形状当成可继续：最后一条是失败的助手回复（`error` / `aborted` / `length`），或最后一条是用户消息 / 工具结果。助手消息里还挂着未完成的工具调用时，它认为这轮已经按意图做完，composer 不给「继续」。进程死在 `bash` / `write` 中间就是这种形状。

`continueTurn`（`src/main/pi/process-manager.ts`）会把被中断的那次助手回复从下一次请求里拿掉，再进运行循环。模型因此可能把同一个工具再叫一遍，包括会改文件、会执行命令的那些。文件回退是另一条路：写入前抓了原文，重试时问用户要不要还原。模型这边没有对应的「这刀没砍完」。

Durable 的做法：工具意图先落盘；重启后续跑时，只有标明可以重放的才重跑（读文件、搜索），其余把已经写出的输出标成已中断，交给模型决定。

要改的是：未完成的工具调用也要能继续；读和搜索可以重跑，写入和命令默认补一条已中断的结果，不要静默再执行一次。

### 2. 同一次提交只进转写一次

手机断线重试、排队消息的立即发送、`engine:prompt` 在运行中被连接掐断，都出过「界面把草稿收回来了，运行其实还在」或同一句发出去两遍。App protocol 已有幂等键（`src/main/app-server/app-server.ts`）。桌面和远程走的 `prompt` 没有。

Durable 用客户端带来的 `requestId`：崩了之后用同一个 id 再提交，拿回原来那次，而不是再问一遍。

用户消息带上这个 id，写进转写；同一个 id 再来时返回已有的那次提交。

### 3. 压缩尽量发生在空闲时

压缩现在自己占一个忙状态（`#compacting`）。SDK 在压缩过程中拒绝新的提示（`Cannot submit a prompt while compaction is in progress`）。手动压缩会先中止当前运行。压缩没有并进「运行中」，是为了让队列和 steer 不要把它当成一轮还活着的运行，这个区分保持。

Durable 在快到窗口上限时于后台写摘要，只有下一轮放不下才等。SDK 做不到边跑边压。能做的是：用量过一条软阈值且会话空闲时先压，用户再发送就不用等那一下。

### 4. 问过的问题，重启后用记下的答案

阻塞式提问按会话排队，存在内存里。进程没了，问题没了，工具那一头还在等的 promise 也没了。没有人再看得到那条问题，工具也不会自己结束。

Durable 的 hook memo 是第一次写入算数：重启读到的是同一个决定，不会再问一遍。

至少把「问过什么、答过没有」写到会话旁边。重启后能把原来的面板再摆出来，或者把已有的答案交回那个工具。

### 5. 子 agent 随进程消失时，父工具要收到已中断

子会话是内存里的 `SessionManager`，跑完才把转写缓存下来。崩在半路，父会话里的那次调用没有结果，后面续不上。

Durable 把子 agent 做成普通会话，用 `requestId` 找回同一次提交，所以它能从断点继续。这里不必自动拉起来重跑：副作用和工具一样。补一条已中断的结果，让父会话能继续，就够了。

### 6. 系统提示的稳定前缀不要每轮重写

语言要求和长期记忆是在每轮开始前整段追加的。todo、记忆摘要一变，前缀就变，提示缓存从这里失效。

Durable 把系统提示拆成段落，变化记在转写里变化发生的那个位置；支持中途改系统提示的模型只发送变化的那段。

先量缓存命中。稳定规则留在前缀，todo 和记忆这类每轮都变的内容挪到单独的上下文里。

### 7. 交接后的新会话要能搜源会话

`/handoff` 开一个新对话，把摘要发出去，源对话还留着。新会话不知道源会话的 id。Durable 的 handoff 不删历史，并给一个能搜交接之前的工具。

已有 `conversation_search`。交接正文里带上源会话 id，新会话就能搜，不必把两份转写合成一份。

## 先不做

- **换 harness。** Durable 是实验包，不是完整的 coding agent。扩展、MCP、codemode、模型配置、用量账本、远程协议都绑在现在的 SDK 上。
- **Fork 不复制历史。** Durable 的 fork 是共享到某个点为止的视图。`writeForkSession`（`src/main/engine/session-fork.ts`）整份复制，用量靠 `fastvibeUsageSessionId` 去重。SDK 认的是一份线性 v3 转写；改成共享前缀要动读取、搜索、导入和计费。
- **让后台任务躲过「停止」。** Durable 的后台任务，普通中止碰不到。这里的停止就是停掉这个会话，以及它的子 agent 和 DAG。
- **会话留在本机、工具跑到另一台机器。** 那是 Durable 的 execution environment。SSH Agent 是整份运行时在远端，不是这一层能挪的。

## 已经对齐、不用再做

多人同时看同一条对话：先给当前视图，再推变更，不重放已经积进转写的流式增量。这就是 snapshot + `seq`，以及 `message_update` 不进 `turnEvents`。Durable 的 `viewState()` 再 `subscribe` 是同一件事；他们自己也说，若要 coding agent 那种事件流，字节会更多。
