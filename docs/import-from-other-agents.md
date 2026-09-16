# 从其他 Agent 导入会话：格式调研与实现设计

> 对应 roadmap-2026-09-16.md 第二阶段 **P2「CLI 导入与迁移」**：只读发现 / 显式导入会话及非秘密配置，复制到 FastVibe 根，说明冲突与不支持项。
>
> 结论基于本机真实数据逆向（`~/.claude` 9.1 MB / `~/.codex` 4.8 GB / `~/.local/share/opencode` 3.4 GB / `~/.pi` 3.7 MB / `~/.gemini` 191 MB），以及 SDK 与主进程源码。凡未验证的推断均标注 `UNVERIFIED`。

---

## 1. 结论

**可行。** FastVibe 的会话本来就是 pi SDK 的 v3 会话文件（JSONL），而四个主流 agent 的会话都是「JSONL / JSON + 索引」结构，全部可以无损降级到同一套中间表示再写出。真正的工作量不在解析，而在**契约的十几条硬性规则**和**产品边界**（只读、选择性导入、大语料、上下文超限）。

| 来源 | 存储 | 可枚举索引 | 导入难度 | 建议 |
| --- | --- | --- | --- | --- |
| **pi coding agent** | `~/.pi/agent/sessions/**/*.jsonl`（与目标同格式） | 目录扫描 | ★ | **v1 必做**（近恒等映射；迁移成本最低，roadmap 的原始动机） |
| **Claude Code** | `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` | 目录扫描 | ★★ | **v1 必做**（格式最清晰，含 thinking / usage / 项目路径） |
| **Codex CLI** | `~/.codex/sessions/**/rollout-*.jsonl` + `state_5.sqlite:threads` | SQLite `threads` 表（理想） | ★★★ | **v1 必做**（三代格式要兼容；`exec` 工具是程序化包装） |
| **opencode** | `opencode.db`（SQLite：session/message/part） | `session` 表 | ★★★ | **v2**（SQLite + JSON 双份历史，需只读打开） |
| **Gemini CLI** | `~/.gemini/tmp/<projectKey>/chats/session-*.json` | 目录 + `projects.json` | ★★ | **v2**（字段少，一次成型） |
| **Cursor** | `state.vscdb → cursorDiskKV`（`composerData:<uuid>`） | `composerHeaders` 表 | ★★★★ | **不建议**（本机几乎为空；新版历史多在服务端） |
| Antigravity | `~/.gemini/antigravity/**` protobuf | 无 | ★★★★★ | 不做 |

**核心判断**：不要为每个来源写一个「直接生成会话文件」的转换器，而是 `源 adapter → 中间表示(IR) → 唯一写出器`。写出器只有一份，且它能被单元测试锁死；adapter 各写各的、可以独立增删。

---

## 2. 目标契约：一份合法会话文件由什么构成

导入的本质就是「写一个文件 + 在 `conversations.json` 注册一条记录」，之后 `SessionManager.open()` 就能把它当成普通会话打开、继续对话、计入使用统计。契约来自以下代码：

- `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`（读取/写入/迁移）
- `src/main/pi/process-manager.ts:986,1098`（路径推导与打开）
- `src/main/engine/map-messages.ts`（渲染）
- `src/main/engine/usage-ledger.ts:49`（统计）
- `src/shared/types.ts:635`（`Conversation`）

### 2.1 位置与命名

```
<userData>/runtime/engine/agent/sessions/--<cwd 去掉前导 /、把 / 和 : 换成 ->--/<ISO-dashes>_<sessionId>.jsonl
```

`--…--` 的编码规则与 SDK `getDefaultSessionDirPath`（session-manager.js:242）逐字一致：`--${cwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--`。**目录名不是契约**（`SessionManager.open` 接受任意路径，绝对路径存在 `conversations.json` 里），但请沿用，否则「按会话目录去找」的既有代码和 `usage-stats` 之外的人工排查会困惑。

### 2.2 文件结构

```jsonc
{"type":"session","version":3,"id":"<uuid>","timestamp":"2026-09-16T08:00:00.000Z","cwd":"/repo"}
{"type":"message","id":"<稳定唯一>","parentId":null,"timestamp":"...","message":{ ... user ... }}
{"type":"message","id":"…","parentId":"<上一条 id>","timestamp":"…","message":{ ... assistant ... }}
{"type":"message","id":"…","parentId":"…","timestamp":"…","message":{ ... toolResult ... }}
```

条目类型（`session-manager.d.ts`）：`message | model_change | thinking_level_change | compaction | branch_summary | custom | custom_message | label | session_info`。导入只会用到 `message`、`model_change`、`compaction`、`session_info`。

### 2.3 消息形状（pi-ai `Message`，`pi-ai/dist/types.d.ts:237-347`）

```jsonc
// user
{"role":"user","content":"…" | [{"type":"text","text":"…"},{"type":"image","data":"<base64>","mimeType":"image/png"}],"timestamp":1789546514888}

// assistant（字段齐全才好统计与显示）
{"role":"assistant","content":[
    {"type":"thinking","thinking":"…"},                                  // 不要带外来的 signature
    {"type":"text","text":"…"},
    {"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"ls"}}
  ],
  "api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5",
  "usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,
           "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
  "stopReason":"stop","timestamp":1789546510000}

// toolResult（独立条目，role 是 camelCase 的 toolResult）
{"role":"toolResult","toolCallId":"call_1","toolName":"bash",
 "content":[{"type":"text","text":"<输出>"}],"isError":false,"timestamp":…}
```

`timestamp` 是**毫秒数字**（不是 ISO）；`entry.timestamp` 是 ISO 字符串，两者都要给。

### 2.4 会让导入静默失败的十件事（硬性规则）

| # | 规则 | 依据 |
| --- | --- | --- |
| R1 | **第一行必须是 `{"type":"session",…}`**，且 `id` 是非空字符串。否则 `loadEntriesFromFile` 直接返回 `[]`，`SessionManager` 认为文件非法并抛错 | session-manager.js:311-317, 626-630 |
| R2 | `version` 写 **3**。缺省按 v1 处理，migration 会**重写整份文件并重发所有条目的 id** | session-manager.js:75-85 |
| R3 | 条目按**时间顺序写入文件**，`parentId` 串成线性链、最后一行即 leaf。`_buildIndex` 用文件顺序取 `leafId`，`getBranch()` 从 leaf 回溯 | session-manager.js `_buildIndex` / :958 |
| R4 | 每条 `message` 条目都要有**唯一非空 `id`**；`usage-stats` 用 `sessionId + entry.id` 去重，空 id 的回合直接丢弃 | usage-ledger.ts:92-94 |
| R5 | `assistant` 要带 `api/provider/model/usage/stopReason`；`usage` 缺字段按 0 计（不报错，但统计会失真） | types.d.ts:307-329 |
| R6 | **每个 `toolCall` 必须有配对的 `toolResult` 条目，且紧跟在承载它的那条 assistant 之后**（中间不能插入 user/assistant）。SDK 对条目内容不做修补（只把 `content == null` 补成 `[]`），悬空 tool_use 会在下一次真实请求里被 provider 拒绝（Anthropic 400） | session-manager.js:166-189；实测见 §9 |
| R7 | **外来 thinking 的 `signature` 必须剥掉**。有 signature 时 pi 会原样回传 `signature`（anthropic-messages.js:996-1023），外来签名会被拒绝或语义错误；无 signature 的 thinking 会被安全降级成 `text` 发送 | anthropic-messages.js:985-1023 |
| R8 | 会话文件**复制**进 FastVibe 根，不做软链/引用。删除会话会 `unlink(sessionFile)`（process-manager.ts:747-752），引用会毁掉用户原始数据；同时绝不写 `~/.pi`、`~/.claude` 等外部目录（独立数据目录约束） | process-manager.ts:371-373,747-752 |
| R9 | `cwd` 必须**真实存在**才能绑项目；否则退回 `runtime/engine/scratch`，不能把不存在的路径交给 bash 工具当工作目录 | process-manager.ts:1097 |
| R10 | **上下文不是无上限的**。`session.messages`（`buildSessionContext`）= 送进 LLM 的全部历史；一个 2000 条消息的导入会话首轮就会超窗 | session-manager.js:232-237 |

### 2.5 写出后会自然获得的能力

- **渲染**：`mapMessages` 认 `thinking` / `toolCall`(及 `tool_use` 等别名) / 独立 `toolResult`，thinking 时长缺失时只少一个「用时」标签（`applyThinkingTimings`，主进程计时补不回来）。
- **继续对话**：它就是普通会话，`SessionManager` 已 `flushed=true`，下一轮按 append 追加，不会重写头部（`_persist` 只在「还没有 assistant」时才憋着不写，session-manager.js:740+）。
- **使用统计**：`listSessionFiles` 递归扫整个 `sessionsDir`，`parseSessionTurns` 按 `message.role === "assistant"` + `usage` 聚合 → 导入即计入。代价重算不依赖存储价格，历史会被当前价目表重新定价。
- **标题**：侧栏读 `conversations.json` 的 `title`；`session_info` 条目的 `name` 是引擎侧会话名（`session.sessionName`）。两者都写。
- **分支**：导入的线性链天然支持从任意点 edit/retry（`navigateTree`），无需额外工作。

---

## 3. 中间表示（IR）与 adapter 边界

```ts
type ImportedSession = {
  source: "pi" | "claude-code" | "codex" | "opencode" | "gemini";
  sourceId: string;          // 外来会话 id，用于去重/幂等
  title?: string;
  cwd?: string;              // 外来工作目录，可能已不存在
  createdAt: number;         // ms
  updatedAt: number;         // ms
  items: ImportedItem[];     // 严格时序
};

type ImportedItem =
  | { kind: "user"; text: string; images?: { data: string; mimeType: string }[]; at: number }
  | { kind: "assistant"; text: string; thinking: string[]; toolCalls: ImportedToolCall[];
      model?: string; provider?: string; usage?: ImportedUsage; at: number }
  | { kind: "toolResult"; callId: string; name: string; text: string; isError: boolean; at: number }
  | { kind: "note"; note: "compaction" | "model-switch"; text?: string; at: number };

type ImportedToolCall = { id: string; name: string; args: unknown };
type ImportedUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
```

adapter 的接口只有一个方法：

```ts
interface ImportSource {
  scan(): Promise<ImportCandidate[]>;        // 只读、可中断、不解析全部内容
  read(candidate): Promise<ImportedSession>; // 解析单个会话
}
```

`ImportCandidate` 至少含 `{ source, sourceId, title, cwd, updatedAt, messageCount?, bytes? }`，用于列表与体积提示。**`scan()` 必须廉价**：优先读索引（Codex 的 `threads` 表、opencode 的 `session` 表），只在必要时解析文件头。

写出器 `writeImportedSession(ir): Promise<Conversation>`：

1. cwd 存在 → 编码目录，否则 scratch（R9）；
2. 逐条把 IR 转成 v3 条目，维护 `prevId` 链（R3），id 用 `crypto.randomUUID()` 或 `nameIndex` 风格稳定 id；
3. 为悬空 `toolCall` 合成 `isError:true` + 「该工具调用在原 agent 中未返回结果」的 `toolResult`（R6）；
4. 剥离 thinking 签名（R7）；
5. 若 IR 含 compaction note，写一条 `compaction` 条目（`summary` + `firstKeptEntryId` + `tokensBefore`），否则线性消息；
6. 追加 `session_info`（title）；
7. 原子写：`<file>.tmp` → `rename`；
8. 注册 `Conversation`：`{ id: randomUUID(), title, cwd, project?, sessionFile, sessionId, createdAt, updatedAt, preview: 首条用户消息前 200 字 }`；
9. （可选）把该会话的回合 `capture()` 进 `usage-ledger.jsonl`，避免将来删会话时统计回退。

**幂等**：`conversations.json` 记录里加 `importedFrom?: { source, sourceId }`，重复导入时提示「已导入」而不是制造重复副本（类似 `cc-switch.ts` 的 fingerprint 去重思路）。

---

## 4. 各来源格式档案

### 4.1 pi coding agent（近恒等）

- 根：`~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl`；一个会话一个文件，无索引。
- 格式与目标**完全相同**（v3，含 `message` / `model_change` / `thinking_level_change` / `compaction`），实测样本 58 行、header `version:3`。
- 映射：条目级搬运，只做三件事：重新发 id 链（或保留原 id——同一 `parentId` 链可以直接搬）、`cwd` 存在性检查、注册 catalog。
- 坑：
  - 旧版本可能是 v1/v2（`hookMessage` role），**不要自己写迁移逻辑**，让 SDK migration 处理即可（R2 否则会重发 id）；但导入时把 `version` 标成 3 更省事。
  - `~/.pi/agent/auth.json`、`models.json` 属于凭证，不属于会话导入范围（凭证走已有的 CC Switch 路径）。

### 4.2 Claude Code

- 根：`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`；目录名编码与 FastVibe 一致（`/Users/a/b` → `-Users-a-b`），**前缀单横线而非双横线**。子目录 `memory/` 与导入无关。
- 另有桌面版清单：`~/Library/Application Support/Claude/claude-code-sessions/<ws>/<worktreeHash>/local_*.json`（`UNVERIFIED`：结构与 CLI JSONL 的关系未确认，倾向不作为 v1 来源）。
- 顶层 `type` 分布（实测 12 个文件 / 9.1 MB）：`assistant` 1439、`user` 852、`attachment` 564、`last-prompt` 216、`ai-title` 208、`custom-title` 116、`atis-latch` 116、`queue-operation` 112、`system` 29、`mode` 28、`bridge-session` 26。
- **只要 `assistant` + `user`**；其余是 UI/书签状态。`ai-title` / `custom-title` 可作标题来源（`{type, sessionId, aiTitle|customTitle}`），`last-prompt` 可作 preview。

映射：

| 外来 | IR / 目标 |
| --- | --- |
| `user.message.content: string` | `user.text` |
| `user` + `content[]` 含 `tool_result`（实测 786 条，带 `toolUseResult`、`sourceToolAssistantUUID`） | `toolResult` 条目（`tool_use_id` → `callId`，`content` → text，`is_error` → `isError`） |
| `user` + `isMeta: true`（4 条） | **丢弃**（注入内容） |
| `user` 里 `<command-name>` / `<local-command-stdout>` 包装 | 丢弃或降级为 note（`UNVERIFIED`：本机样本未见，标准 CLI 会写） |
| `assistant.message.content[]`：`text` / `thinking{thinking,signature}` / `tool_use{id,name,input}` / `image{source}` | `text` / `thinking`（**剥 signature**）/ `toolCall{id,name,arguments:input}` / `image{data,mimeType}` |
| `assistant.message.usage`：`input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens` | `usage.input/output/cacheRead/cacheWrite`；`total = 四项之和` |
| `assistant.message.model` | `assistant.model` |
| 顶层 `cwd` / `sessionId` / `timestamp` / `uuid` / `parentUuid` | IR `cwd` / `sourceId` / `at` / 条目 id 来源 / 排序链 |
| `system.subtype=stop_hook_summary` 等 | 丢弃 |
| 顶层 `type=summary`（本机样本无） | 可作 compaction note |

**头号坑：一个 API 响应被拆成多行。** 实测 1439 条 assistant 条目只对应 **795 个 `message.id`**——同一 `message.id`（同 `requestId`）下 `thinking` 与 `tool_use` 各占一行。adapter 必须**按 `message.id`（或 `requestId`）聚合**成一个 assistant 消息，用 `parentUuid` 链/文件顺序确定块顺序；否则会得到一串只有半截内容的 assistant 消息。

其它坑：`isSidechain: true` 是子 agent 轨迹（同一文件内混排，v1 建议跳过并在 UI 注明）；`attachment.edited_text_file` 是文件变更事件（可丢弃）；`usage` 含 `iterations[]` 与 `cache_creation` 细分（取顶层四项即可）；`stop_reason` 可能为 `null`，`stopReason` 一律写 `"stop"`；行内偶见非 JSON 行 → 逐行 try/catch 跳过。

### 4.3 Codex CLI

- 根：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（1167 个）+ `~/.codex/archived_sessions/*.jsonl`（983 个）。
- **枚举用 `state_5.sqlite` 的 `threads` 表**（本机 894 线程）——这是唯一现成的索引，字段正好齐全：
  `id, rollout_path, created_at/updated_at(秒), created_at_ms/updated_at_ms, cwd, title, preview, name, first_user_message, model, reasoning_effort, model_provider, git_branch, git_sha, tokens_used, archived, source, cli_version, thread_source`。
  回退（DB 缺失/版本不同）：扫 `rollout-*.jsonl` + `session_index.jsonl`（`{id, thread_name, updated_at}` 1017 行）+ `history.jsonl`（`{session_id, ts, text}` 220 行）。
- **同一份数据有三代格式**，同一时刻的库可能混装，adapter 必须都能读：

| 代次 | 内容载体 | 工具调用 |
| --- | --- | --- |
| 旧（≤2026-05，见 `archived_sessions`） | `response_item` | `function_call{name:exec_command\|write_stdin\|update_plan\|wait, call_id, arguments:"<JSON 字符串>"}` + `function_call_output{call_id, output:"<字符串>"}` |
| 中（当前主用） | `response_item` | `custom_tool_call{name:exec\|apply_patch, call_id, input:"<字符串>"}` + `custom_tool_call_output{call_id, output:"字符串\|数组"}` |
| 新（同时写 SQLite） | `thread_history_1.sqlite:thread_items.item_json` | camelCase item：`commandExecution{command,cwd,status,aggregatedOutput}` / `fileChange{changes[{path,kind,diff}]}` / `mcpToolCall` / `dynamicToolCall` / `webSearch` |

- 顶层类型：`session_meta`（首个 `session_meta` 是 fork 头、第二个才是本线程——**多个 session_meta 在文件头部**）、`response_item`、`event_msg`、`turn_context`、`world_state`、`token_usage_record`。
  - `response_item.payload.type`：`message`（role `user/assistant/developer/system`）/ `reasoning{summary[],encrypted_content}` / `function_call(_output)` / `custom_tool_call(_output)` / `local_shell_call`（`UNVERIFIED`：本机样本未出现）。
  - `event_msg.payload.type`：`user_message` / `agent_message` / `agent_reasoning` / `token_count` / `task_started` / `task_complete` / `turn_aborted` / `item_completed` / `thread_settings_applied` / `exec_command_begin|end`。

映射（**只以 `response_item` 为准**）：

| 外来 | IR |
| --- | --- |
| `response_item/message` role=`user` 且非 `<permissions instructions>` / `<recommended_plugins>` / `<multi_agent_mode>` 等注入块 | `user`（注入块按前缀白名单丢弃） |
| role=`assistant`（带 `phase: commentary`） | `assistant.text` |
| role=`developer`/`system` | **丢弃** |
| `response_item/reasoning.summary[]` | `assistant.thinking`（`encrypted_content` 丢弃、不写 signature） |
| `function_call` / `custom_tool_call` | `toolCall{id:call_id, name, arguments: JSON.parse(arguments) 或 {script: input}}` |
| `*_output` | `toolResult{callId, text: output 拼接}` |
| `event_msg/token_count.info.last_token_usage` | `usage{input: input_tokens, output: output_tokens, cacheRead: cached_input_tokens, cacheWrite: cache_write_input_tokens}` → **必须用 `last_token_usage`，`total_token_usage` 是累计值，直接取会重复计数** |
| `threads.title/name`、`threads.cwd`、`git_branch` | IR title / cwd（git 信息可写进标题旁注） |
| `compacted` / `event_msg/context_compacted` | `note: compaction` |
| `turn_context` / `world_state` / `session_meta.base_instructions` | 丢弃 |

其它坑：**同一时间戳重复出现在成百行上**（`session_meta` 之后的整段会带同一个 `timestamp`），排序必须用**文件行序**而不是时间戳；**双流重复**——`event_msg/agent_message` 与 `response_item/message(assistant)` 内容相同，`event_msg/user_message` 同理，只取一路；`item_completed` 是第三代事件流，与 `response_item` 并存，naive 导入会把一轮说两遍；最新 `exec` 的 `input` 是 **JS 程序字符串**（`const r = await tools.exec_command({cmd:"…",workdir:"…"}); text(r.output);`），需要正则/启发式提取 `cmd`，提取失败就显示为「exec（脚本）」；`thread_items` 与 rollout 并存，**同一线程只取一处**。

### 4.4 opencode

- 数据根：`~/.local/share/opencode`。`~/.opencode` 只是 CLI 安装目录（node_modules/bin），**不含数据**。
- **两代存储并存**：`opencode.db`（SQLite，2.8 GB：557 session / 20094 message / 81036 part，**当前权威**）与 `storage/{session,message,part,project}/*.json`（237/4004/14855，旧格式遗留）。

DB 结构（drizzle）：

```sql
project(id, worktree, vcs, name, sandboxes, time_created, time_updated)
session(id, project_id, parent_id, slug, directory, title, version, time_created, time_updated,
        cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
        model, agent, metadata, summary_*, revert, time_archived)
message(id, session_id, time_created, time_updated, data)   -- data 是 JSON
part(id, message_id, session_id, time_created, time_updated, data)  -- data 是 JSON
```

- `message.data`：user = `{role:"user", time:{created}}`（**没有正文**）；assistant = `{role:"assistant", system[], mode, path, cost, tokens{input,output,reasoning,cache{read,write}}, modelID, providerID, time{created,completed}, error}`。
- `part.data` 的 `type` 分布：`tool` 23123、`step-finish` 18271、`step-start` 18246、`reasoning` 13858、`text` 4849、`patch` 2609、`file` 52、`agent` 5、`compaction` 4、`subtask` 2。
  - `text{text}`；`reasoning{text, time{start,end}}`；`step-finish{reason, snapshot, cost, tokens{input,output,reasoning,cache{read,write}}}`；
  - `tool{callID, tool, state{status,input,output,title,metadata,time}}`，`status ∈ pending|running|completed|error`，输出在 `state.output`；
  - `patch{hash, files[]}`（文件变更汇总）。
- 顺序：会话按 `time_created`；消息按 `(time_created, id)`；**消息内的 part 按 `time_created`（等价于 rowid）**——实测 part id 前缀虽含时间但仍以 `time_created` 最稳。
- 映射：user 的正文来自其 `part(type=text)`；assistant 文本/推理/工具来自其 parts；`step-finish` 给 `usage`；`session.title/directory/project_id` 给标题/cwd/项目；`session.parent_id != null` 是子 agent 会话（v1 跳过）。`usage.cacheRead = tokens.cache.read`、`cacheWrite = tokens.cache.write`。
- 坑：
  - `opencode.db` 可能在 opencode 运行时被锁 → 用只读方式打开（`file:…?immutable=1` 或先复制 db + `-wal` 到临时目录），并对 `SQLITE_BUSY` 做一次重试。
  - 旧 `storage/` 与 DB 的会话 id 有重叠但**内容不一定一致**；以 DB 为准，storage 仅在 DB 缺失时兜底。
  - 大体积来自 `event` 表（与导入无关，不要 `select *`）。
  - `permission[]`、`revert`、`summary.*`、`snapshot` 与 FastVibe 的权限模型不对应，丢弃并在导入报告里列出。

### 4.5 Gemini CLI

- 根：`~/.gemini/tmp/<projectKey>/chats/session-<ts>-<hash>.json`；`projectKey` 由 `~/.gemini/projects.json` 的 `{cwd: name}` 反查，查不到就是哈希目录（cwd 不可知）。
- 结构：`{sessionId, projectHash, startTime, lastUpdated, messages[]}`；
  - `messages[].type ∈ user|gemini|info|error`；`user{content}`；`gemini{content, thoughts[{subject,description,timestamp}], model, tokens}`；`info/error{content}`。
  - 映射：`user→user`；`gemini→assistant`（`thoughts[].description` → thinking）；`info/error` 丢弃；`tokens` → usage（`UNVERIFIED`：字段细分未在本机样本中观察到）；`toolCalls`（工具调用字段名 `UNVERIFIED`，本机 3 个样本均无工具调用）→ 需在实现时用真实数据补齐。
  - 无 usage 的会话 tokens 记为 0，统计里会显示为 0 成本——需在导入报告里说明。

### 4.6 Cursor（不建议）

- `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`：`ItemTable` + `composerHeaders(composerId, workspaceId, createdAt, isSubagent, value)` + `cursorDiskKV`（`composerData:<uuid>` 是 JSON，`bubbleId:<composerId>:<bubbleId>` 是逐条消息）。
- 本机实测 `cursorDiskKV` 只有 5 行、`composerHeaders` 只有 3 行，且唯一的 `composerData` 是 `empty-state-draft`（空会话）——该安装的聊天历史不落在本地（云端/其他 profile）。键名与结构未文档化，且随版本变动；投入产出比最差，**明确列为不支持**并在 UI 说明原因。

---

## 5. 跨来源共性坑（实现时逐条对照）

1. **双流/重复**：Codex `event_msg` vs `response_item`；Claude Code 同一 `message.id` 多行；opencode message 与 part 分开。→ 每个 adapter 显式声明「哪一路是唯一真相」并写测试。
2. **注入内容伪装成用户消息**：Claude Code `isMeta`、Codex `<permissions instructions>` / developer role、opencode `[analyze-mode]` 前缀。→ 白名单过滤 + 在导入报告里告诉用户「跳过了 N 条系统注入」。
3. **子 agent / sidechain**：Claude `isSidechain`、Codex `forked_from_id`/`parent_thread_id`/`subAgentActivity`、opencode `parent_id`、pi `subagent` 扩展的工具卡。v1 一律**跳过并在报告里计数**，不要拼进主线（会打乱因果顺序）。
4. **压缩**：Claude `system.compact_boundary`、Codex `compacted`/`context_compacted`、opencode `compaction` part、pi `compaction` 条目。→ 有能力就映射成 `compaction` 条目，否则在压缩点插一条 note，避免「历史忽然不连续」。
5. **thinking 签名**（R7）：一律剥离。pi 对无签名 thinking 的处理是「转成 text 发送」，安全。
6. **悬空工具调用**（R6）：都会出现（用户中途打断、进程被杀）。必须合成 toolResult。
7. **时间戳**：ISO 字符串 / 秒 / 毫秒三种；`message.timestamp` 必须是毫秒数字，`entry.timestamp` 必须 ISO。Codex 有大量重复时间戳 → 排序用文件行序。
8. **大文件**：单条工具输出可达数百 KB～MB（本机 opencode 3.4 GB、Codex 4.8 GB）。→ 流式逐行解析（不要 `JSON.parse(整个文件)`）、单条输出按阈值截断并在文本里注明「已截断 N 字节」、`scan()` 阶段不读内容。
9. **非 UTF-8 / 损坏行 / 无尾换行**：逐行 try/catch；写出时必须**每条一行 + 结尾换行**（`_persist` 直接 append，没有尾换行会把两条记录粘成一行非法 JSON）。
10. **上下文超限**（R10）：导入长会话后首轮就可能爆窗。→ 导入前用「估算 token」提示，超阈值时建议：只导入最近 N 轮、或自动在尾部写一条 `compaction` 摘要条目（摘要可让模型生成，成本计入用户）。
11. **cwd 不存在**（R9）：外来会话的项目路径常已删除。→ 落到 scratch，并在标题后缀或 preview 里标注原路径。
12. **图片/附件**：Claude Code 的 base64 image、Codex 的附件目录、opencode `file` part。→ 只支持内联 base64 图片（`{type:"image",data,mimeType}`），其余在报告里列为「未导入」。
13. **隐私**：不导入凭证类文件（`auth.json`、`config.toml` 密钥、`.env`）。凭证导入已有独立通路（`src/main/engine/cc-switch.ts` 从 `~/.cc-switch/cc-switch.db` 读 provider），不要混进会话导入。日志里不打印消息正文。
14. **只读**：所有外部根以只读方式打开，绝不创建/修改/加锁（SQLite 需复制或 immutable 打开）。

---

## 6. 产品流程与 UI

**入口**：`设置 → 迁移 / 导入`（新增 section，加入 `SETTINGS_SECTIONS` 后路由自动生效，无需改 `App.tsx`）。

**四步**：

1. **发现**（只读）：并行扫描各来源根，产出 `来源 / 会话数 / 最近时间 / 占用体积 / 不可用原因（未安装、格式过新…）`。失败不报错、逐项给状态（与「首启路径上没有错误」一致）。
2. **选择**：按来源分组的会话列表（标题、cwd、时间、消息数、估算 token、是否已导入）。支持「最近 N 个 / 全选 / 按项目筛选」，默认**不勾选**。
3. **导入**：串行执行（避免瞬时磁盘 IO 峰值），逐条进度；单个失败不影响其余，失败项给出原因。
4. **报告**：成功 N / 跳过 M / 失败 K，逐项列出跳过原因（注入消息、子 agent、附件、未知工具）与原 cwd 是否已被替换为 scratch。报告可复制。

**边界**：
- 导入是**新增会话**，不修改、不删除来源数据；不覆盖同名会话（id 为新 UUID）。
- 幂等：用 `conversations.json` 里的 `importedFrom` 标记；再次导入提示「已导入（可强制重复）」。
- 大语料：默认上限（如按体积/条数）避免一次拉入 GB 级数据；超出时引导按项目/时间筛选。
- 导入的会话在侧栏可加「来源」徽标（如 `Claude Code`），并在转录中把原 cwd 与「缺失的工具输出」说明清楚——用户必须能分辨哪些内容是历史、哪些是 FastVibe 的推断。

---

## 7. 实施分期与验收

| 阶段 | 内容 | 出口 |
| --- | --- | --- |
| **I1**（先做） | IR + 写出器 + `pi` / `claude-code` adapter + 设置页「发现→选择→导入→报告」+ 单测（fixture 每个来源 1 个真实会话） | 导入后可打开、继续对话、计入使用统计；`pnpm typecheck` 通过 |
| **I2** | `codex`（三代格式）+ `opencode`（DB 优先、JSON 兜底）+ `gemini` | 同上，含 SQLite 只读与锁重试 |
| **I3** | 去重幂等、来源徽标、compaction 映射、token 超限引导、导入报告导出 | 边界可解释 |
| **不做** | Cursor / Antigravity / 凭证类文件 | UI 中「不支持」并说明原因 |

**验收清单**（每条都能自动测）：

- 写出的文件被 `SessionManager.open()` 打开无异常，`version` 仍为 3，条目 id 唯一且 `parentId` 线性。
- `getBranch()` 的消息数与 IR 的 user+assistant+toolResult 数一致（无截断、无重复）。
- 每个 `toolCall` 都有配对 `toolResult`（含合成的），且**顺序为 assistant→toolResult 就地相邻**（断言子序列，不是断言集合）。
- 任一 thinking 无 `thinkingSignature`；`usage-stats` 能统计到该会话的回合，金额非 NaN。
- 原来源目录在导入前后**字节级不变**（hash 校验），且不含对来源路径的引用。
- cwd 不存在时落到 scratch，且 `conversation.project` 为空。
- 重复导入不产生第二个副本。

---

## 8. 契约验证（已跑通）

用一真实 Claude Code 会话（`~/.claude/projects/…/3e13ca73-4fe8-4819-9ebe-351fffb5c013.jsonl`，134 行）按 §3 的写出器转成 v3 文件，再用 SDK 自身的读取路径加载：

```
loadEntriesFromFile: 52 entries; header: {"type":"session","version":3,"id":"…"}
sessionId: … | sessionName: imported test          ← session_info 生效
branch entries: 51 | ctx messages: 50              ← 无截断、无重复
roles: [user, assistant, toolResult, assistant, toolResult, …]   ← 工具结果紧跟其调用
assistant blockTypes: [thinking, toolCall]
any thinking with signature?: false                ← R7
 dangling toolCalls: 0                              ← R6
 usage sample: {input:2, output:448, cacheRead:30014, cacheWrite:12227, totalTokens:42691}
append 一轮后: 54 entries; version 仍为 3; 末行仍可解析   ← 继续对话不会重写头部
```

结论与两个实测教训：

1. **R1–R7、R10 成立**：header 合法即不会被 migration 重写；线性链、配对工具结果、无签名 thinking 都能得到干净上下文。
2. **工具结果必须就地插入**（R6）。第一版转换把 20 个 `toolResult` 统一追加到文件尾部，SDK 照样能构建上下文（`ctx messages: 50`、`dangling: 0`），但消息序列退化成「assistant(toolCall) ×9 → toolResult ×20」——**读取端不报错，直到用户继续对话时被 provider 拒绝**。这类错误不会在导入时暴露，因此必须靠 adapter 单测锁死顺序，而不是靠人工试。
3. 工具结果的**时间戳早于/晚于**其调用都不影响解析，顺序只由**文件行序**决定——这同时说明「按时间戳排序」在 Codex 那种时间戳重复的语料上必然出错（§5.7）。

---

## 9. 未验证 / 待补

- Claude Code 桌面版 `claude-code-sessions/<ws>/<hash>/local_*.json` 与 CLI JSONL 的关系与结构。
- Claude Code 标准 CLI 的 `type: "summary"`、`system.subtype: "compact_boundary"`、`<command-name>` 包装消息（本机为桌面变体，样本中未出现）。
- Gemini CLI 的 `toolCalls` 字段名与 `tokens` 细分（本机 3 个极短样本均无工具调用）。
- Codex `local_shell_call`、`patch_apply_*` 事件、`item_completed` 与 `response_item` 的完整对应关系；`thread_items`（第三代）是否已完全取代 rollout 作为真相源。
- opencode `session_message` / `session_input` 表的语义（是否也已承载正文）。
- 各来源在 **旧版本** 下的字段漂移程度（建议用旧备份样本补 fixture）。
- 未在真实 FastVibe 运行中验证渲染与使用统计的端到端表现（仅验证了 SDK 读取路径，§8）。

> 本文只新增调研文档：未安装依赖、未运行应用、未修改任何业务代码；验证脚本只读取 `~/.claude` 并在 `/tmp` 写出测试文件，外部数据未被改动。

---

## 10. 实施记录（已完成）

四个来源（pi / Claude Code / Codex / opencode）已按本问实施，代码在 `src/main/engine/import/`，三处与本问初稿不同：

1. **工具结果的顺序由写出器保证，不由 adapter 保证**（R6）。初稿把 `toolResult` 写成独立的 IR 条目，意味着每个 adapter 必须自己把它插到正确位置——而这正是最容易静默出错的地方。现在 `ImportedToolCall` 自带 `result`，IR 里根本没有"独立的工具结果"这种东西：**顺序错误在写出口变为了不可能**，adapter 无法弄错。
2. **`messageCount` / `bytes` 改为可选**。picker 打开必须是毫秒级，而"统计一个来源的消息数"在两个来源上恰好很贵：Codex 要读 1000+ 个 rollout（4.6s），opencode 要对 81k 个 part blob 求 `LENGTH(data)` 和（2.6s）。现在 Codex 只给大小（扫描 48ms）、opencode 只给消息数（扫描 67ms），其余两者都给。
3. **opencode 先直读，失败才复制**。初稿的"每次操作都复制 2.8GB 数据库"在批量导入时每次 `read()` 都付一次代价；现在优先对活动文件只读打开（普通读不受 WAL 影响），仅在 `SQLITE_BUSY` 时复制一次并在整次导入中复用（`dispose()` 清理）。

实测（本机语料，`ALL PASS`）：

| 来源 | 候选 | 扫描 | 典型导入 | 统计回合 |
| --- | --- | --- | --- | --- |
| pi | 6 | 13ms | 54 条消息 | 24 |
| Claude Code | 12 | 60ms | 464 条消息 | 232 |
| Codex | 1006 | 48ms | 3652 条消息（26.9 MB） | 1796 |
| opencode | 557 | 67ms | 1745 条消息 | 867 |

每个导入都通过了 §7 的全部断言：header `version: 3`、id 唯一、`parentId` 线性链、`ctx` 消息数与写入数一致、0 悬空工具调用、0 签名、工具结果与其调用相邻、末行可解析、可继续对话（append 后仍为 v3）、计入使用统计、写出的文件全在 FastVibe 目录内、`conversations.json` 重载后 `importedFrom` 仍在、重复扫描会标记已导入。

新增两条当时未预料到的产品约束：

- **导入必须立即落盘**：`ConversationCatalog` 的写入有 40ms 防抖，因此导入结束时显式 `flush()`——否则"已导入"的提示之后进程被杀，新会话就丢了。
- **超大会话要在选择阶段就说**：Codex 真实存在 3000+ 条消息、26.9 MB 的单会谈，导入后首轮必然超窗。picker 对 `>800 条消息`或`>15 MB` 的候选加一行"会话较长，导入后建议先压缩上下文"。
