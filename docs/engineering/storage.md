# 持久化、转写与用量

涉及数据库迁移、目录按行写入、导入、检查点、转写修复与用量去重时阅读。

关联入口：[SQLite 设计与测量](../sqlite-storage.md)、[会话导入格式](../import-from-other-agents.md)、[Pi 引擎模式](../pi-engine-modes.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## SQLite 存储（`src/main/engine/db.ts`，设计见 `docs/sqlite-storage.md`）

> 本节保留存储迁移时的范围和测量；其中 DAG 表与旧文件属于历史范围，当前编排能力见 [Agent Team 与历史 DAG 边界](automation.md)。保留迁移编号和历史资料不代表保留旧工具接口。

「数据类」状态（会话目录、检查点、思考耗时、记忆账本、排队消息、DAG、定时任务）都在一个
`<userData>/fastvibe.db` 里；「配置类」（`settings.json`、`providers.json`、`mcp.json`、`memory.json`…）
和凭据文件仍是各自的 JSON——前者要整份发给每个渲染窗口，后者要保持独立 0600 与「不经任何方法返回」。
会话转写仍然是 JSONL：格式归 pi SDK 所有。迁移动机不是快，是整份重写造成的多进程互相覆盖、
只在退出时落盘的状态（检查点）崩溃即丢，以及「只能全量扫描」。

- **只有 `db.ts` 可以 import `node:sqlite`。** 这个模块还是 development status，跨 Node 版本 API 会变；
  收口之后换成 `better-sqlite3` 只改这一个文件。store 拿到的是 `Db`（`run` / `get` / `all` / `exec` /
  `transaction`），除了 SQL 本身不认识 SQLite。
- **一个进程一个连接，按路径缓存**（`openDatabase`）。测试要「第二个进程」时用 `openDatabaseConnection`
  拿一条独立连接；`closeDatabases()` 在退出路径上（桌面 `requestShutdown`、无头 Agent `stop()`）
  先 `wal_checkpoint(TRUNCATE)` 再关。`:memory:` 永不缓存——两个调用各要一个内存库时它们确实是两个库。
  独立连接可显式传 `migrations` 以验收临时 Shadow 库；省略时仍运行生产迁移。Vivi M2 的
  [隔离 Store](../vivi-development.md#m2隔离-shadow-store-已落地) 只接受内存库或系统临时目录，
  不把分支 schema 注册到生产迁移，也不通过缓存连接改变当前用户库。
- **PRAGMA 的顺序有坑**：`auto_vacuum = INCREMENTAL` 必须在 `journal_mode = WAL` *之前*设——实测新建的库
  反过来设会被接受然后无声忽略（`PRAGMA auto_vacuum` 一直读回 0）。其余是 `synchronous=NORMAL`、
  `busy_timeout=5000`（另一个进程在写时等一会儿，而不是立刻抛 `SQLITE_BUSY`）、`foreign_keys=ON`。
- **文件从第一个字节起 0600**，`-wal` / `-shm` 从主文件继承权限——但*不假设*：`test/db.test.ts` 直接断言
  三个文件，因为检查点存的是工作区源码。
- **表的形状是「主键 + 少数派生列 + 一个 `data TEXT`（整份对象的 JSON）」**，所以给 `Conversation`、
  `DagNode`、`ScheduledTask` 加字段不需要 schema 迁移。派生列只在真被查/排序时才存在，而且
  **按行比较要把派生列一起算**（`RowWriter` 比的是 JSON 加列的指纹）：项目拖拽顺序只活在
  `projects.position` 里，只比 JSON 会静默丢掉一次重排。时间是 epoch ms 的 INTEGER，不用 BigInt。
- **schema 版本用 `PRAGMA user_version`**，迁移是 `db-schema.ts` 里有序的函数数组，一步一个事务，
  并且在事务*内*重读版本号：两个进程同时第一次建库时，后进的那个要跳过而不是撞上
  `CREATE TABLE … already exists`。库版本高于本应用已知版本时**拒绝打开**并给出可读错误，不猜怎么降级。
  已使用的迁移编号不能删除或复用：第 9 步对应已移除的草稿功能，保留空迁移兼容已有 schema 9，
  不删除旧表，也不回写较低的 `user_version`。
- **旧 JSON 由每个 store 在自己第一次打开时导入**（`importLegacyJson`），用该 store 现有的读取/规范化代码，
  所以会话目录的 v0/v1 迁移不必重写第二遍。导入与写行在同一个事务里，提交前比对「写入方声明的行数」与
  `SELECT COUNT(*)`，对不上就整笔回滚、旧文件原样不动。提交后把旧文件**改名**成 `.migrated-<时间戳>`
  （不删，也不原地留着：原地留着的话回退到旧版本会继续写它，再升级时新版本因为已有导入记录而忽略这些改动）。
  读不出来的改名 `.corrupt-<时间戳>` 并从空开始、记为已完成。**幂等**：崩溃在提交与改名之间，下次只补改名。
  唯一的例外是排队消息——它拒绝「读不出来就当空」，因为紧接着的一次写入会把没人读到过的提示词真丢掉，
  所以那条路径是 `unreadable: "throw"`，让这次启动失败而不是悄悄清空。
- **损坏的库改名 `.corrupt-*` 并报错**，不静默重建：一个库现在装着十几个文件各自曾经的东西，
  而且不做滚动备份（已确认）；转写不在库里，所以对话正文不会丢。
- **store 的内存模型与业务逻辑不变**，只把 `#flush()` 里「整份序列化 + rename」换成「一个事务里 upsert
  变化的行 + 删掉没了的行」。写入器（`RowWriter`）自己不写事务：原子单位归 store（整次 flush、或一个检查点
  的删旧+写新），而导入器已经持有事务时再开一层会直接抛（`db.transaction` 不嵌套）。
- 退出路径上 `PiProcessManager.flush()` 不再「顺便存一下检查点」：**检查点在捕获时就落盘**，这是本次唯一
  有用户可感知差别的变化（崩溃后「重试」仍会提示回退文件）。实测存储写入：35 文件 × 8 KB 0.4ms、
  32 MB 上限 79ms、200 文件 20 MB 52ms（`node scripts/bench-sqlite.mjs`）；`capture()` 里每文件一次的
  `git rev-parse --show-toplevel` 是迁移之前就有的开销，不是这次加的。
- **收益跟着数据集体积走，不跟操作走**（`node scripts/compare-storage-backends.mjs`，旧 store 用
  `git show HEAD:` 的真代码在同一份副本上对照）：250–400 KB 的文件一次动作少写 13–51×（思考耗时
  序列化从 254 KB 到 130 B），**小于 ~10 KB 的文件反而多写**——SQLite 的落盘粒度是 4 KB 页，排队消息
  8 KB → 16 KB、定时任务 282 B → 12 KB。稳态启动慢 3.6ms、第一次多 37ms（导入），库文件比 7 个 JSON
  大 0.46 MB。所以别把这套改动当性能优化验收：真正的收益是崩溃不丢检查点与两个进程不互相覆盖，
  完整表格在 `docs/sqlite-storage.md` §11。
- 无头 Agent 跑同一份引擎代码、用在自己的 `--data-dir` 上的库，两端各自迁移各自的数据，不需要对 schema
  版本达成一致。`node:sqlite` 是 Node 内置，打包没有原生依赖要带；但预检那句 `require("node:sqlite")`
  让 Agent 机器的实际下限变成 **22.13**（22.5–22.12 需要 `--experimental-sqlite` 标志）。
- 演练与回归：`node scripts/drill-sqlite-import.mjs` 把真实 userData **复制到临时目录**后跑一遍导入并比对
  行数/往返（不碰正在运行的数据目录）；`test/db.test.ts`、`test/reasoning-store.test.ts`、
  `test/memory-state.test.ts`、`test/checkpoint-store.test.ts` 和各 store 的导入用例钉住上面每一条。

## 目录落盘是按行比较，不是整份覆盖（`ConversationCatalog.#flush`）

同一个数据目录上可以同时有两个进程：安装版旁边再开一个 `pnpm dev`（开发态跳过单实例锁）。
`conversations.json` 时代每次 flush 都从内存整份写出，后写的一方只留下它自己认识的会话，另一方新建的
会话从侧栏消失，转写文件却还在磁盘上——用户看到的是「正在运行的会话不见了」，于是要在文件格式上手搓
一套「合并写」。现在状态在 `fastvibe.db` 的表里，这个问题被按行写入取代：

- **落盘前先吸收表里的新会话。** `#adoptFromTable` 一次 `SELECT` 找出本进程从未见过的 id 并进内存；
  「持有过」仍记在 `#knownIds` / `#knownProjects`，所以本进程自己删掉的会话不会被读回来。
- **只写变化的行。** `RowWriter` 比较整份序列化结果与上次落盘的字节（含派生列），不同才
  `INSERT … ON CONFLICT DO UPDATE`；内存里没了的行是一条 `DELETE`。所以进程 B 内存里还留着 A
  刚删掉的会话 X 时，B 的 flush 不会把 X 写回去——B 没改它就没有写入。两边都改同一会话仍是后写者赢。
- **`projects.position` 是被比较的一部分。** 拖拽顺序只存在于列里、对象没变，所以「这行变了没有」
  必须把派生列一起算，否则一次重排会静默丢失。
- **activeId 的空是显式的。** `catalog_meta` 里写 `''` 表示「没有打开的会话」，行缺失才是「没记过」，
  后者才退回最新一条——和文件时代 `undefined` 被 JSON 丢掉的行为区分开。
- 读不出来的旧文件先改名留一份（`conversations.json.corrupt-<时间戳>`）再从空开始；数据库本身损坏时
  见 SQLite 存储那一节的 `.corrupt-*`。
- 这挡不住两个进程同时*运行*同一个会话（转写会被交错追加）；开发实例和安装版共用数据目录本身仍是风险。
- 测试：`test/conversation-catalog-merge.test.ts`（第二个连接当作第二个进程）、
  `test/conversation-catalog-import.test.ts`（v0 / v1 旧文件的导入）。

## 从其他 Agent 导入（设置 → 导入）

设置 → 导入 lists the sibling coding agents on this machine — **pi coding agent, Claude Code,
Codex, opencode** — one row each (brand mark, name, an 导入 button). Picking a row opens a
multi-select picker of that agent's sessions; nothing is imported until the user confirms.
`docs/import-from-other-agents.md` is the format dossier behind every adapter.

- **An absent agent gets no row.** `scanImportSources` skips any source whose data root does
  not exist, so a machine without pi or opencode installed shows only the two rows that can
  actually do something — a row whose only possible message is 「未找到数据目录」 is noise. A
  source that *is* installed but holds no sessions still gets a row (it says 没有找到会话):
  that is a state the user would otherwise go hunting for in the file system. If every source
  is absent the pane says so once instead of listing four disabled rows.

- **One adapter per source, one writer for all of them** (`src/main/engine/import/`):
  `sources/*.ts` translate a foreign store into the intermediate form in `types.ts` and stop;
  `writer.ts` is the only place that knows the pi v3 transcript contract, and
  `runner.ts` drives scan → read → write → register. Adding an agent means one adapter file
  plus a line in `adapters.ts` — nothing else in the app learns how many sources exist.
- **The writer is where the contract lives, and it is not negotiable.** The first line must
  be the `session` header with `version: 3` (otherwise the SDK rejects the file, or a
  migration pass rewrites every entry id); entries form a linear `parentId` chain in file
  order, because the reader takes the *last* entry as the leaf; and a tool result is written
  **immediately after** the assistant that made the call. That last one is not cosmetic: the
  first converter appended results at the end of the file, the SDK still built a context with
  no errors, and the failure only appeared when the user continued the chat and the provider
  rejected a `tool_use` with no `tool_result`. A call with no recorded output gets a
  synthesised error result for the same reason. Foreign thinking blocks are written **without**
  their signature — replaying another provider's signature is rejected, and an unsigned
  thinking block is what makes pi fall back to plain text.
- **Import copies, never links.** A deleted conversation unlinks its `sessionFile`, so a chat
  pointing at `~/.claude` would destroy the user's real data. Every foreign root is opened
  read-only (Codex/opencode SQLite via `node:sqlite` `{ readOnly: true }`; the opencode DB is
  copied aside only when a live WAL refuses the read) and each session is converted into
  FastVibe's own `runtime/engine/agent/sessions`.
- **Candidates are only as expensive as they must be.** The picker must open instantly, so
  `importCandidates` skips what it cannot get cheaply: Codex leaves `messageCount` undefined
  rather than counting 1000+ rollouts (that alone cost 4.5s), and opencode reports a message
  count instead of summing `LENGTH(data)` over 81k part blobs (2.6s). Codex is enumerated from
  `state_*.sqlite:threads`, opencode from its own DB, the other two by directory listing.
- **Per-session outcomes, never all-or-nothing.** These stores are full of pruned rollouts and
  half-written files, so a failure is collected and shown as a reason next to that row. The
  report also lists what a conversion dropped (injected context, subagent sidechains,
  compaction markers — never written as real `compaction` entries, which would hide earlier
  messages from both the model and the thread).
- **Archived sessions are folded, not dropped.** `threads.archived` (Codex, plus the
  `archived_sessions/` directory on the walk fallback) and `session.time_archived` (opencode)
  travel through the adapter as `archived` and reach the picker as one boolean — on the
  author's corpus 62 of 88 Codex threads are archived, so listing them beside live work buries
  it. The picker hides them behind a 显示已归档 switch and badges the rows; the source row
  carries `archivedCount` so the count is visible while they are hidden. The select-all
  checkbox carries the count in its own label (`全选（已选/可见）`, not a separate 已选
  readout) and is scoped to the rows on screen; folding the archived away also drops them
  from the selection, so that number always matches what would actually be imported. pi and
  Claude Code have no such notion and their switch stays disabled.
- **The catalog write is flushed before success is reported.** `ConversationCatalog` coalesces
  writes on a 40 ms debounce, so `importSessions` calls `flush()` once at the end — after the
  pane says 已导入, the chats survive a crash.
- **`importedFrom: { source, sourceId }`** on the `Conversation` is the re-import key: the
  picker marks sessions already taken, and the same session imported twice is visible as such
  rather than silently duplicated. Imported chats are registered **not activated**
  (`activate: false`) so a twelve-session import does not walk the user through twelve tabs,
  and `titleManual` protects the name that came from the other agent.
- **Icons** are the four brands from LobeHub (`components/agent-brand-icon.tsx`), inlined as
  `currentColor` paths rather than `<img>` so they follow the active theme.

## 同步配置到全局 pi（引擎模式切换的一步）

One direction, and not a shared data root. `syncFastVibeConfigToPi`
(`src/main/engine/sync-pi-config.ts`) writes connected providers, the default model,
thinking level and MCP into the target pi agent directory in pi's own format. It
used to be the manual 设置 → 关于 → 同步配置 button with a merge / replace choice;
that button is gone with the 引擎模式 switch, which calls this function in `merge`
while migrating to 全局 pi (`pi-engine-switch.ts`), so there is one path and no
second copy of the rules. Sessions, UI preferences and FastVibe's own runtime stay
put. API keys are written as pi config literals — `escapePiConfigSecret`, because a
raw `$` is interpolated and a leading `!` is a shell command. The target directory
is copied under `engine-backups/` before anything changes, and a file that is not
valid JSON stops the switch before it writes.

## Usage statistics (使用统计)

用量页展示按当前价格估算的费用、输入/输出/缓存构成，以及按项目/会话的费用来源。分组在原有去重之后计算，继承的分叉历史仍记在原始 session 上；删除的会话保留用量，缺失目录元数据时归入「已删除或其他会话」。SSH Agent 使用相同聚合器。

Settings → 使用统计 (`components/settings/usage-settings.tsx`) is fed by
`collectUsageStats` (`src/main/engine/usage-stats.ts`) over the `stats:usage` channel.

- **Two sources, one union.** The pane is rebuilt from the engine's session
  transcripts, *plus* `usage-ledger.jsonl`. Deleting a conversation unlinks its
  transcript (`PiProcessManager.deleteConversation`), which used to silently rewrite
  history; the ledger is what keeps it. A live transcript is the primary source and the
  ledger only adds turns whose file is gone; the two are deduplicated by
  `sessionId` + entry id (`turnKey`). Retry/edit branches in place (`navigateTree`),
  keeping that key stable. Independent conversation forks (`engine:fork`,
  `engine/session-fork.ts`) instead create a new v3 transcript and session id, copying
  only the selected branch. Inherited assistant entries carry `fastvibeUsageSessionId`
  (preserved through repeated forks), so `parseSessionTurns` uses the original usage
  identity and never bills copied history twice. New turns use the new session id.
  Forks preserve entry ids for reasoning timing, include pending tool results at the
  chosen reply boundary, and never rewind workspace files. An unfinished tool exchange
  does not block a fork: the copy pairs each call with its existing result and supplies
  an explicit error result only where none exists, without executing any tools. Results
  are placed after their owning assistant before the next assistant, as required by
  pi-ai's `transformMessages`; roundtrip tests cover both SDK loading and that conversion.
  They are ordinary catalog
  conversations with a nonempty preview, not side chats or disposable empty drafts;
  creation stays inactive until `#ensureSession` finishes. Isolated worktree forks are
  refused because deleting the source would otherwise destroy the fork's shared cwd.
- **The ledger stores raw usage, never a price.** `UsageLedger` (`usage-ledger.ts`)
  appends one line per finalized assistant turn (tokens, model, engine-reported cost,
  timestamp, tool-call count) as the turn lands, and `capture()` folds a whole
  transcript in before it is unlinked (pre-ledger history included). `usage-stats.ts`
  re-prices every turn at read time against the *current* price table, so a provider
  edit re-prices the ledger and the transcripts alike; storing a price would freeze it.
- **The ledger is a supplement, not the source of truth.** Tokens and cost are always
  recomputed from raw fields, and `parseSessionTurns` is memoised on `mtimeMs` + `size`.
  **Parses are kept between launches** in `runtime/engine/usage-parse-cache.json` (`ParseCacheFile`, keyed by
  path and valid for exactly the `mtimeMs` + `size` it was made at; 294 MB: first read ~1 s, afterwards 8 ms, and
  only a transcript that grew is parsed again). It is a file of its own rather than a table in `fastvibe.db`
  on purpose: it is derived and deletable, and a new table is a schema step, which makes every older build refuse
  to open the shared database. A missing, torn or foreign-version file is an empty cache.
  Tool results and prompts — nearly all of a transcript's bytes — are skipped by their
  envelope without being parsed (`carriesNoUsage`: the entry's *first* `"message":` key, never
  a match further in, where a tool call's arguments can hold the same words).
  If the ledger is missing or corrupt, statistics simply fall back to the transcripts —
  they are never *less* correct than before, only less complete after a deletion.
- Appends are synchronous (one line per turn) so a capture that precedes an `unlink` is
  durable before the file disappears; `flush()` is a no-op kept for the shutdown path.

## 重试与文件回退（checkpoint）

「重试这一轮」回退的是**对话**（`navigateTree`），工作区文件原本留在原地，于是重试是在
上一轮已经改过的代码上重跑——第二次看到一个半应用的编辑，或者一个因为文件已有新内容
而变成空操作的 `write`。两者都是静默的。

- **捕获发生在写入之前，而且捕获时就落盘。** 引擎在 `tool_execution_start`（工具真正执行**之前**）用
  `readBefore` **同步**读一遍原文，每个文件每回合只读一次（第二次再读就是第一次编辑的
  产物了），然后串行落盘（`CheckpointStore.capture` 里有 `git rev-parse`，并发会乱序覆盖）。
  以前 `checkpoints.json` 只在 `stop()` 里整份写一次，崩溃或被杀就把所有检查点带走了——而那正是
  这个功能存在的场合。现在一个检查点是一个事务里的「删旧 + 写新」，`clear` 靠 `ON DELETE CASCADE`
  带走文件行，不给会话留下读到别人内容的孤儿行。
- **回合边界由 `#beginTurn` 划，不由 `agent_start` 划。** 一个用户回合会发多次 `agent_start`：
  重试、压缩后继续、`agent_end` 排队的继续、goal 模式的下一轮。在那里清空累加器会把
  本回合写过的文件重新读成「原文」，并在一个只读回合后把上一回合的文件表当成本回合的。
  `continueTurn` 不划界（它是同一个回合的续跑）。
- **回退是问出来、不是自动的。** `retryRewind` 弹窗列出文件；「保留文件改动」**也照常重试**
  （它回答的是文件那个问题，不是要不要重试）。用户可能在提示词与重试之间自己动过这些文件，
  所以不能静默还原。
- **回退不全时必须说出来。** 二进制/过大/未被 git 跟踪的文件没有可回退的内容
  （`restoreCheckpoint` 记进 `skipped`），于是拼一个半还原的工作区再重试——正是这个功能
  要防的事。

## 会话转写落盘（`engine/transcript-file.ts`）

读取方把文件**最后一行**当作叶子，沿 `parentId` 往回走；只要中间有一条的父记录不在文件里，
重新打开就只剩断点之后那一段（前面的内容其实还在磁盘上）。常驻内存时看不出来，所以用户是在
归档 → 恢复（会话已被空闲回收，重新从磁盘读）或重启之后才发现「只剩一条消息」。

- **`#persist` 只在 SDK 还没落盘时写一次**（`flushed === false`，即还没有回复的首轮）。之后 SDK
  每条记录都即时追加，没有东西需要写。它曾经在每次提问、会话回收和退出时调用 SDK 的
  `_rewriteFile()`——截断后逐条重写——拿着旧副本的写入方（例如共用数据目录的开发版和安装版）
  会抹掉别人刚追加的记录，写到一半崩溃或出错又会留下一个前缀，后续追加指向不存在的父记录。
  不要把整文件重写加回来。
- **剩下那一次写是原子的**（`writeTranscriptEntries`：临时文件 → fsync → rename）。
- **打开只读一遍文件**：`prepareTranscriptForOpen` 读一次、解析一次，接续断链和补结果都在这份条目上做，有改动才原子写一次；
  解析出的条目交给 `openSessionFile`（`engine/session-open.ts`），SDK 不再自己读文件。它用的是 SDK `open` 内部也用的
  预加载构造函数（对 TypeScript 是 private），`test/transcript-file.test.ts` 钉住两条路径载入的是同一个会话——升级 pi
  要保留这项测试。以前是三遍（修复、补结果、SDK）：82 MB 的会话 440–520 ms → 150–170 ms。
- **打开时修复**：`#ensureSession` 在 `SessionManager.open` 之前跑 `repairTranscriptFile`，把父记录缺失的
  条目接到文件中的前一条上（只重写那几行，坏行原样保留，不会接成环），并在日志里记一条
  `[transcript] relinked …`。对话搜索（`loadConversationTranscriptBranch`）在内存里做同样的接续，不写盘。
- **打开时补结果**：进程死在工具执行中途，转写以 `assistant(stopReason: "toolUse")` 结尾，它请求的调用没有任何
  结果（助手消息在工具运行之前就已落盘）。`closeOrphanToolCalls` 紧接着 relink 之后，给当前分支末尾那条
  助手里**没有结果的调用**各追加一条 `isError` 的 `toolResult`，文案说「可能已部分执行，先核对现场」。
  这样转写以 `toolResult` 结尾，`canResumeRun` 本来就判为可继续，composer 出现「继续」，模型也被如实告知，
  而不是在下一次请求里只读到提供方投影合成的 `"No result provided"`。只补分支末尾：后面跟着用户消息的
  是被有意打断、投影已处理；以 `error` / `aborted` / `length` 结束的回复从未执行过它的工具，不碰。
  它只在**本进程首次加载这个会话时**跑，运行中的会话不会被回收（`#sweepSessions` 跳过有运行的），所以不会
  给一个还在执行的工具抢先写结果。与开发版共用 userData 时，另一个进程正在跑同一会话仍是已知风险。
  不做「读/搜索类工具自动重放」：模型看到已中断的结果后会自己重新读。

## Pi engine modes

The embedded SDK can use either FastVibe's isolated pi configuration or the user's global pi configuration. Settings → About → Engine switches the mode. A switch requires no running conversations, parked extension prompts, or sub-agents; it backs up the target configuration, migrates models, credentials, defaults, MCP, and resource directories, then restarts. Conversation transcripts, SQLite state, queues, checkpoints, DAGs, and schedules stay in FastVibe's data directory. The source configuration is retained so switching back is possible.
