# SQLite 存储迁移设计

状态：**阶段 0–3 已实施**（2026-10-18）：`db.ts` + `db-schema.ts`（schema 到 v8），档 A（思考耗时、记忆
账本、检查点）、档 B（会话目录）、档 C（排队消息、定时任务、DAG）都已落在 `<userData>/fastvibe.db` 上，
各自的旧 JSON 由对应 store 在第一次打开时导入并改名保留。档 D（用量账本、决策轨迹）**未做**，见第 11 节
的实施记录。配置类文件不动，第 10 节记录了已确认的决定。

## 1. 为什么做，以及不为什么

直接结论先写在前面，免得读完才发现期望不对：

- **不是为了快。** 实测的几个 JSON 文件里，最大的会话目录只有 27 KB，整份重写它是亚毫秒的事。
  迁移不会让「感觉更快」，不要用这个当验收标准。
- **要解决的是三件事：**
  1. **整份重写 + 多进程互相覆盖。** 同一个数据目录上可以同时有安装版和 `pnpm dev`（开发态跳过单实例锁）。
     `conversations.json` 已经为此写了一套「合并写」（`#adoptFromDisk` / `#knownIds`，提交 `834ed48`），
     那是在文件格式上手搓事务。
  2. **只在退出时才落盘的状态。** `checkpoints.json` 只在 `stop()` 里整份写一次
     （`process-manager.ts` 的 `saveCheckpoints`），进程崩溃或被杀，所有「重试前回退文件」的检查点都没了。
  3. **只能全量扫描。** 用量统计要把整个账本读进内存再按日期过滤；会话搜索是逐个转写文件扫描。
- **配置类文件不迁**：`settings.json`、`providers.json`、`mcp.json`、`account.json` 等都在 12 KB 以下，
  迁过去没有性能收益，反而要处理「设置整份发给每个渲染窗口并跨窗口同步」「凭据文件保持独立的 0600」
  「用户可能手改」这些约束。理由和清单见第 3 节。

## 2. 现状（实测）

作者机器上的 `~/Library/Application Support/FastVibe/`，2026-10-18：

| 文件 | 大小 | 内容 | 写法 | 已知问题 |
|---|---|---|---|---|
| `conversations.json` | 27 KB | 42 个会话、5 个项目 | 40ms 去抖，整份写 + rename | 两进程互相覆盖，靠合并写补救 |
| `runtime/engine/checkpoints.json` | 784 KB | 13 个检查点、35 个文件 | **仅退出时**整份写 | 崩溃即丢；内容含工作区源码 |
| `runtime/engine/reasoning.json` | 268 KB | 思考块起止时间，上限 5000 条 | 500ms 去抖，整份写 | 每次写 268 KB |
| `runtime/engine/memory-state.json` | 295 KB | 记忆整理账本 | 整份原子写 | 同上 |
| `runtime/engine/message-queue.json` | 7.7 KB | 排队消息、暂停原因、修订号 | 整份原子写，0600 | 小，但是崩溃一致性要求高 |
| `dag.json` | 34 B（用过会涨） | 每会话一张任务图 | 40ms 去抖，整份写 | 图越大每次写越多 |
| `runtime/engine/scheduled-tasks.json` | 48 B | 定时任务 + 最近 500 次运行 | 整份写 | 同上 |
| `runtime/engine/usage-ledger.jsonl` | 4.7 MB / 18,772 行 | 每轮用量 | 追加，进程内 Map 去重 | 统计页全量读取再过滤 |
| `runtime/engine/decision-trace.jsonl` | 10.9 MB / 2,314 行 | 决策轨迹，保留最新 2000 行 | 追加，超 3000 行整份重写 | 每 1000 次追加重写一次 10 MB |

## 3. 范围

### 3.1 迁移

按**收益和风险**分四档，实施顺序也按这个来（第 7 节）。

| 档 | 存储 | 收益 | 说明 |
|---|---|---|---|
| A | 检查点、思考耗时、记忆状态 | 高 | 体积大、整份重写；检查点还能顺带解决崩溃丢失。与其他代码耦合少 |
| B | 会话目录（项目 + 会话 + activeId） | 中 | 并发正确性；可以删掉合并写。**所有人都依赖它**，风险最高 |
| C | 排队消息、DAG 图、定时任务 | 中低 | 事务性和行级更新；体积小 |
| D | 用量账本、决策轨迹 | 低 | 见 3.3，做不做可以到最后再定 |

### 3.2 不迁

| 不迁 | 原因 |
|---|---|
| `settings.json`、`providers.json`、`mcp.json`、`decision.json`、`browser-library.json`、`project-bindings.json`、`window-state.json`、`ssh-hosts.json`、`subagents.json`、`memory.json` | 配置，≤ 12 KB，没有收益。`settings.json` 是整份发给每个渲染窗口的，改成行存储反而要拼回整份 |
| `account.json`、`remote-access.json`、`agent/oauth.json`、`gateway-credentials.json`、`rtc-device.json`、`server-identity.json`、`agent/.env` | 凭据：保持各自独立的 0600 文件。放进共享数据库会让「一个文件读写权限」变成「所有凭据的读写权限」，也打破「凭据从不经任何方法返回」的隔离 |
| `agent/sessions/*.jsonl`（会话转写） | 格式归 pi SDK 所有（v3 的 `parentId` 链），我们只是读写方；追加写本来就适合 JSONL |
| `models-dev.json`、`memories/`、`dag.json.results/`、`tool-images/`、`office-preview/` | 下载的快照或大块产物，文件就是合适的形态 |
| SDK 自己的 `sessions` 搜索 | 全文检索要另做（FTS5 + 转写入库），不在本次范围，见第 9 节 |

### 3.3 档 D 为什么收益低

- **用量账本**：进程内 `Map` 已经按 `sessionId + entryId` 去重，首次使用时读一遍。18,772 行的解析是
  几十毫秒量级。SQLite 的好处是 `WHERE at >= ?` 可以只取统计窗口，但统计页还要把转写里的轮次合并进来，
  不是纯 SQL 能表达的，收益有限。
- **决策轨迹**：写多读少，保留 2000 条。好处只有「裁剪不再整份重写 10 MB」和能按 `request_id` 查。

两者都放最后，到时候看前三档的实际效果再决定。

## 4. 总体设计

### 4.1 一个数据库，一个模块

- 位置：`<userData>/fastvibe.db`（`FastVibePaths.databaseFile`）。SSH Agent 用它自己的 `--data-dir`，
  同一个相对位置。
- 引擎：Node 内置的 **`node:sqlite`**（`DatabaseSync`），同步 API，和现有 store 的同步写法一致。
  主进程里已经在用（`cc-switch.ts`、`browser-profiles.ts`），SSH Agent 的预检也已经要求远端 Node 能
  `require('node:sqlite')`（`ssh-manager.ts` 的 `usable_node`），所以**没有新增运行时要求**。
- **所有访问只走 `src/main/engine/db.ts`。** `node:sqlite` 仍在开发中，不同 Node 版本之间 API 可能变化；
  收口之后换成 `better-sqlite3` 只改这一个文件。store 不直接 import `node:sqlite`。
- 一个进程一个连接，按路径缓存。不在 worker 线程里用。

`db.ts` 对外只有这些：

```ts
openDatabase(file): Db            // 缓存；建库、PRAGMA、跑 schema 迁移
db.run(sql, ...params) / db.get(...) / db.all(...)
db.transaction(fn)                // BEGIN IMMEDIATE … COMMIT，异常回滚；不支持嵌套
importLegacy(db, { name, file, load })   // 旧 JSON 一次性导入，见 4.4
closeDatabases()                  // 退出时 wal_checkpoint(TRUNCATE) 后关闭
```

### 4.2 PRAGMA

| PRAGMA | 值 | 为什么 |
|---|---|---|
| `journal_mode` | `WAL` | 读写不互斥；两个进程（安装版 + dev）同时开着也能用 |
| `synchronous` | `NORMAL` | WAL 下掉电最多丢最后几个事务，不会损坏；`FULL` 对这里的写入频率没必要 |
| `busy_timeout` | `5000` | 另一个进程在写时等一会儿，而不是立刻抛 `SQLITE_BUSY` |
| `foreign_keys` | `ON` | 检查点文件等子表靠 `ON DELETE CASCADE` |
| `auto_vacuum` | `INCREMENTAL`，**只能在建表前设置** | 检查点会存源码内容，删掉之后要能把文件缩回来；启动时跑一次 `incremental_vacuum` |

数据库文件创建后 `chmod 0600`。`-wal` / `-shm` 应当继承主文件权限，但**不假设**，测试里直接断言三个文件
的权限（理由：检查点含工作区源码，决策轨迹原本就是 0600，因为它记录了用户浏览过什么）。

### 4.3 表的约定：列为查询而存在，其余整体 JSON

每张表是「主键 + 少数用于查询/排序/清理的列 + 一个 `data TEXT`（完整对象的 JSON）」。
这样 `Conversation`、`DagNode`、`ScheduledTask` 这些类型以后加字段**不需要 schema 迁移**，
而 store 的内存模型和对外 API 保持原样。需要按字段查询时再把那个字段提成列并加索引。

时间一律 `INTEGER`（epoch ms，JS 的 double 装得下）。不用 `node:sqlite` 的 BigInt 模式。

### 4.4 Schema 版本与旧文件导入

**Schema 版本**用 `PRAGMA user_version`，迁移是代码里有序的函数数组，每步一个事务。
库的版本**高于**应用已知的版本（用户装了旧版本的应用）时拒绝打开并给出可读的错误，不尝试降级。

**旧 JSON 导入**，每个 store 在**第一次打开时**各做一次，不在应用启动时统一做：

1. 库里没有这个 store 的导入记录（`legacy_imports` 表，`name` 为主键），且旧文件存在。
2. 用该 store **现有的**读取/规范化代码解析旧文件。会话目录的 v0（裸数组）、v1（`cwd` 即项目）迁移逻辑
   因此原样复用，不重写一遍。
3. **同一个事务里**写入所有行 + 写入 `legacy_imports` 记录，并在**提交前**校验：导入函数声明写了多少行，
   `SELECT COUNT(*)` 必须对得上。对不上就抛错回滚，旧文件原样不动。要么全进去，要么都没进去。
4. 事务提交后把旧文件改名为 `<name>.migrated-<时间戳>`。**不删除**（已确认）。
5. 旧文件读不出来（损坏）：改名为 `<name>.corrupt-<时间戳>`（与今天会话目录的行为一致），记录导入完成、
   从空开始。`.corrupt-*` 是留给人看的，应用不再读取。

两个要点：

- **幂等。** 第 3 步和第 4 步之间崩溃，下次打开发现已有导入记录，就只补做改名，不会二次导入。
- **改名而不是原地保留**，是为了避免脑裂：原地保留的话，用户回退到旧版本后旧版本会继续写旧 JSON，
  再升级时新版本因为已有导入记录而忽略这些改动。改名的代价是回退到旧版本后看到的是空状态
  （数据都在，只是旧版本找不到）。`.migrated-*` 应用不会自动清理，何时清理以后再定。

### 4.5 写入策略：保持内存模型，只写变化的行

不重写 store 的业务逻辑。每个 store 继续持有内存模型、继续用原来的去抖，**只把 `#flush()` 里的
「序列化整份 + rename」换成「在一个事务里 upsert 变化的行」**。

变化的判定不去改几十个 mutation 调用点：flush 时把每一行的序列化结果与上次落盘的
（`#persisted: Map<id, string>`）比较，不同才写。删除同理：上次落盘有、现在内存里没有，就 `DELETE`。

## 5. 各存储的表

以下是草图，字段以实施时的 TypeScript 类型为准。

### 5.1 会话目录（档 B）

```sql
CREATE TABLE projects (
  cwd        TEXT PRIMARY KEY,
  position   INTEGER NOT NULL,      -- 侧栏顺序（用户可拖动），不是按 updated_at 排
  data       TEXT NOT NULL
);
CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,
  project    TEXT,
  kind       TEXT,                  -- NULL | 'side-chat' | …
  parent_id  TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX conversations_project ON conversations(project);
CREATE INDEX conversations_session ON conversations(session_id);
CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT);   -- activeId
```

行为上的变化：

- 「合并写」（`#adoptFromDisk`、`#knownIds`、`#knownProjects`）不再需要：别的进程新增的会话本来就在表里，
  不会被整份覆盖。flush 里「采纳别人新增的行」简化成一次 `SELECT` 找出本进程没见过的 id。
- **删除更准确了。** 今天进程 B 内存里还有会话 X，进程 A 刚删掉它，B 下一次 flush 会把 X 写回来
  （整份覆盖）。按行比较之后，B 只会写它自己改过的行。
- 同一个会话两个进程都改，仍然是后写者赢（行级），语义不变。
- 内存里的排序、`list()` / `listAll()` / `findEmpty()` 保持原样，42 个会话没有理由改成 SQL 查询。

### 5.2 检查点（档 A）

```sql
CREATE TABLE checkpoints (
  conversation_id TEXT PRIMARY KEY,
  cwd             TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  head            TEXT,
  repos           TEXT                       -- JSON: CheckpointRepo[]
);
CREATE TABLE checkpoint_files (
  conversation_id TEXT NOT NULL REFERENCES checkpoints(conversation_id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  path            TEXT NOT NULL,
  data            TEXT NOT NULL,             -- JSON，含 content / binary(base64) / created / opaque / bytes
  PRIMARY KEY (conversation_id, seq)
);
```

- 一个会话仍然只保留一个检查点：`captureCheckpoint` 在一个事务里「删旧 + 写新」，`clearCheckpoint` 删行。
- **行为变化：捕获时就落盘，不再只在退出时。** 这是本次迁移里唯一有用户可感知差异的地方
  （崩溃后「重试」仍能提示回退文件）。代价是单个检查点最多 32 MB（`MAX_TOTAL_BYTES`），同步写在主线程；
  需要实测，见第 8 节。若不可接受，退路是只在回合结束时写一次。
- 二进制仍存 base64 文本，**不顺手改成 BLOB**：内存里的 `TurnCheckpoint` 形状不变，迁移只改存储。
  改 BLOB 可以省 1/3 空间，但那是另一个改动。

### 5.3 思考耗时（档 A）

```sql
CREATE TABLE reasoning_blocks (
  entry_id TEXT PRIMARY KEY,
  seq      INTEGER NOT NULL,                 -- 单调递增，用于「最老的先淘汰」
  bounds   TEXT NOT NULL                     -- JSON: [[start,end],…]
);
CREATE INDEX reasoning_seq ON reasoning_blocks(seq);
```

上限 5000 条：写入后 `DELETE FROM reasoning_blocks WHERE seq <= (SELECT MAX(seq) FROM reasoning_blocks) - 5000`。
重新写入已有 key 时更新 `seq`（与今天「重新插入保持顺序」的语义一致）。

### 5.4 记忆状态（档 A）

`MemoryStateFile` 的 `outputs` / `empty` / `failures` 三个以会话 id 为键的 map，各一张
`(conversation_id PRIMARY KEY, data TEXT)` 的表；`lastRunAt`、`error` 放 `memory_meta(key, value)`。
`memory.json`（开关和模型选择）是配置，不迁。清除记忆（`removeLegacyMemory`、「清除」按钮）
要同时清这几张表，而不是只删文件夹。

### 5.5 排队消息（档 C）

```sql
CREATE TABLE queue_items (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  position        INTEGER NOT NULL,          -- 同一会话内的顺序（用户可拖动重排）
  data            TEXT NOT NULL              -- StoredQueuedPrompt，含 claimed / sending / queuedAt
);
CREATE INDEX queue_conv ON queue_items(conversation_id, position);
CREATE TABLE queue_state (
  conversation_id TEXT PRIMARY KEY,
  revision        INTEGER NOT NULL,
  pause           TEXT                       -- NULL | 'stopped' | 'error'
);
```

- **崩溃后的规范化保持不变。** `normalizeQueueFile` 里「进程在确认前死了，claimed 的行保持 claimed、
  其余变回 pending，并暂停该会话」这套规则是业务语义，不是文件格式，原样保留，只是输入从文件变成表。
- 构造函数目前接受一个可注入的 `writer`（测试里用 `"unused"` 路径 + 假 writer）。迁移后测试改用
  `:memory:` 数据库，这个注入点可以去掉。

### 5.6 DAG 图（档 C）

```sql
CREATE TABLE dag_graphs (
  conversation_id TEXT PRIMARY KEY,
  revision        INTEGER NOT NULL,
  paused          INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE TABLE dag_nodes (
  conversation_id TEXT NOT NULL REFERENCES dag_graphs(conversation_id) ON DELETE CASCADE,
  id              TEXT NOT NULL,             -- T-0001
  seq             INTEGER NOT NULL,
  data            TEXT NOT NULL,
  PRIMARY KEY (conversation_id, id)
);
CREATE TABLE dag_meta (key TEXT PRIMARY KEY, value INTEGER);   -- 全局编号计数器 seq，只增不减
```

- **编号计数器必须在同一个事务里自增**，与「只看现有节点推算会在删除后把最大号再发出去」那条约束一致。
- 每个节点的完整输出（`dag.json.results/<会话>/<运行>.txt`）**继续是文件**：它们可能很大，
  而且先写文件、成功后才发布「完成」是现有的顺序保证，不改。
- 启动时「未结束的节点标为 cancelled 并暂停该图」的逻辑保持，只是读自表。

### 5.7 定时任务（档 C）

`scheduled_tasks(id PRIMARY KEY, data)`、`scheduled_runs(id PRIMARY KEY, task_id, started_at, status, data)`、
`schedule_meta(key, value)`（`revision`）。最近 500 次运行的裁剪（`MAX_RUNS`，保留 `queued` / `running`）
变成一条 `DELETE`。

### 5.8 用量账本与决策轨迹（档 D）

```sql
CREATE TABLE usage_turns (
  session_id  TEXT NOT NULL,
  entry_id    TEXT NOT NULL,
  at          INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
  tokens INTEGER, cost REAL, tool_calls INTEGER,
  PRIMARY KEY (session_id, entry_id)
) WITHOUT ROWID;
CREATE INDEX usage_at ON usage_turns(at);

CREATE TABLE decision_trace (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  request_id TEXT,
  data       TEXT NOT NULL
);
```

- 账本**仍然只存原始用量，不存价格**；统计时按当前价格表重新计价，这条约束不变。
- 决策轨迹保留最新 2000 条：`DELETE … WHERE id <= MAX(id) - 2000`，不再重写整个文件。

## 6. SSH Agent

Agent 和桌面端跑同一份引擎代码，数据目录是它自己的（`--data-dir`），桌面端通过调用表访问它，
**两端各自迁移各自的数据**，不需要对 schema 版本达成一致。

需要确认或处理的：

- `scripts/build-agent-runtime.mjs` 打出来的 Agent 运行时里，`node:sqlite` 是 Node 内置模块，没有原生依赖要打包。
  实施前要在一台真实的远端上跑一次。
- 预检已经要求 Node ≥ 22.5 且能 `require('node:sqlite')`。**22.5 到 22.12 的 `node:sqlite` 需要
  `--experimental-sqlite` 标志**，不带标志 `require` 会抛，所以预检已经把它们挡在外面——但这意味着
  Agent 机器上的 Node 版本下限实际是 22.13。文档（`docs/agent-runtime.md`）里应当写明。
- **先发布带本改动的 `agent-runtime-v*`，再发桌面端**？不需要：Agent 的迁移在 Agent 自己第一次启动时做。
  但「Agent 新、桌面旧」或反过来都应当能连（调用表没变）。实施时各测一次。

## 7. 分阶段实施

每个阶段独立可发布；没迁的 store 继续用 JSON，互不影响。

| 阶段 | 内容 | 退出标准 |
|---|---|---|
| 0 | `db.ts`（打开、PRAGMA、版本、事务、导入、关闭）+ 单元测试 | 第 8 节的 DB 层测试全过；`pnpm typecheck` 过 |
| 1 | 档 A：思考耗时 → 记忆状态 → 检查点 | 三个 store 的现有测试改成用 `:memory:` 库后全过；检查点崩溃恢复测试 |
| 2 | 档 B：会话目录 | `conversation-catalog-merge.test.ts` 的场景（第二个连接当作第二个进程）改写后全过；用真实数据副本演练 |
| 3 | 档 C：排队消息 → 定时任务 → DAG | 现有 `message-queue` / `send-queued-now` / `scheduled-tasks` / `dag*` 测试全过 |
| 4 | 档 D：用量账本、决策轨迹（**可选**） | 阶段 3 之后再评估是否值得做 |

顺序理由：先做耦合最少、收益最清楚的档 A，把 DB 层在真实使用里磨一遍；会话目录风险最大，放在
DB 层已经被验证之后；档 C 的 store 体积小，主要价值是事务，最后做。

## 8. 测试

**现有测试要改。** 约 25 个测试文件按文件路径构造 store 并「重新打开同一个文件」来验证持久化
（`new DagStore(file)`、`new ConversationCatalog(file, scratch)` 等）。改法是机械的：测试用一个
`openTestDb(dir)` 辅助函数，「重新打开」变成「在同一个库文件上再建一个 store」。
store 的**公开方法签名不变**，所以只动构造和夹具，不动断言。

**新增：**

- DB 层：PRAGMA 生效；`user_version` 迁移按序执行；库版本高于应用时拒绝打开；事务异常回滚；
  数据库及 `-wal` / `-shm` 的权限是 0600。
- 旧文件导入（每个 store 一份）：正常文件；v0 / v1 的会话目录；损坏文件（产生 `.corrupt-*`、从空开始）；
  导入幂等（重复打开不重复导入）；导入事务中途失败不留半截数据；提交前行数校验失败则回滚、
  旧文件原样不动；提交后、改名前崩溃，下次打开只补改名不重导；导入后旧文件被改名而不是删除。
- 并发：同一个库文件上两个连接，复现 `conversation-catalog-merge.test.ts` 的场景，外加
  「A 删除、B 不改它」不会被 B 写回。
- 检查点：捕获后**不经过 `stop()`**，新连接就能读到（崩溃恢复）；`clearCheckpoint` 删干净子表。
- 真实数据演练：一个脚本，把一份真实 userData **复制到临时目录**后跑导入，比对行数和
  往返序列化结果（不碰正在运行的数据目录）。
- 性能基线（不是验收门槛，用于发现回归）：32 MB 检查点的同步写耗时；会话目录 flush 耗时；
  启动时各 store 的打开耗时。

## 9. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **故障面集中** | 以前 `reasoning.json` 坏了只丢思考耗时，会话目录不受影响。合进一个库之后，库损坏影响所有 store；不做滚动备份（已确认） | `SQLITE_CORRUPT` 时把库改名为 `.corrupt-*` 并给出可读错误，而不是静默清空；迁移时保留的 `.migrated-*` 是迁移那一刻的恢复来源（之后新写的数据不在里面）；转写文件不在库里，会话正文不会丢，丢的是目录、检查点这类元数据 |
| 回退到旧版本 | 旧版本找不到被改名的 JSON，看到空状态，并开始写新的 JSON | 发布说明里写明恢复方法：退出应用，删除 `fastvibe.db*`，把 `.migrated-*` 改回原名。升级之后产生的新数据会丢 |
| `node:sqlite` 的稳定性 | 仍在开发中 | 收口在 `db.ts`；Electron 升级时跑 DB 层测试 |
| Electron 44 打包后可用性 | 主进程里已有 `cc-switch.ts` 在用，说明可用，但没在打包产物里验证过本改动 | 阶段 0 在 `electron-builder --dir` 产物里跑一次 |
| 主线程同步写 | 检查点最大 32 MB | 8 节的基线；退路是回合结束时写一次 |
| 数据库文件只增不减 | 检查点删除后留下空闲页 | `auto_vacuum=INCREMENTAL` + 启动时 `incremental_vacuum` |
| 两个进程的 schema 迁移竞争 | dev 实例和安装版同时第一次打开新库 | 迁移用 `BEGIN IMMEDIATE`；第二个等 `busy_timeout`，进去后发现版本已是最新就跳过 |
| 同一会话被两个进程同时*运行* | 与本次无关，转写仍会被交错追加 | 已知风险，不在此解决 |

## 10. 决定与待确认

**已确认（2026-10-18）：**

1. **数据库位置**：`<userData>/fastvibe.db`，与 `conversations.json` 同级。
2. **旧 JSON 导入成功后不删除**，改名为 `<name>.migrated-<时间戳>` 保留；提交前校验行数（4.4）。
   （曾倾向于直接删除，后改为保留：删除没有后悔药，而旧文件占的空间很小。）
3. **检查点改为捕获时落盘**，不再只在退出时写。同步写入的耗时要在阶段 1 实测（第 8 节），
   不可接受时的退路是只在回合结束时写一次。
4. **不做滚动备份。** 随之而来的风险见第 9 节。

**仍待确认：**

- **是否做档 D**（用量账本、决策轨迹）：阶段 3 之后再定。

## 11. 实施记录（2026-10-18，阶段 0–3）

做完之后与设计不同或值得记下的几点：

- **`auto_vacuum = INCREMENTAL` 必须在 `journal_mode = WAL` 之前设。** 实测新建的库反过来设会被接受
  然后无声忽略（`PRAGMA auto_vacuum` 一直读回 0），因为 WAL 那条先写了文件头。§4.2 的「只能在建表前
  设置」还不够准确：真正的问题是它得在 WAL 之前。
- **按行比较把派生列一起算。** `RowWriter` 最初只比 `data` 的 JSON，于是「拖拽重排项目」这种*对象没变、
  只有 `position` 变*的改动会被判为「没变」而静默丢失。现在比的是 JSON + 列的指纹，
  `test/db.test.ts` 与 `test/conversation-catalog-merge.test.ts` 各钉一条。
- **排队消息拒绝「读不出来就当空」。** §4.4 的通用规则（损坏 → `.corrupt-*` → 从空开始）对它是错的：
  紧接着的一次写入会把没人读到过的提示词覆盖掉，而它原来就是「抛错、文件留在原地」。所以
  `importLegacyJson` 多一个 `unreadable: "throw"`，只有这一个 store 用。
- **写入器不开事务。** 原子单位归 store（整次 flush、一个检查点的删旧+写新），而 `importLegacyJson`
  已经持有事务——两个地方一开始都在这上面踩过（嵌套 `BEGIN` 被吞掉后报「导入了 0 行」）。
- **`catalog_meta.activeId` 用空串表示「没有打开的会话」**，行缺失才是「从来没记过」。文件时代
  `undefined` 会被 JSON 丢掉，所以「用户关掉了活动会话」和「老目录没这个字段」在磁盘上长得一样，
  重新打开就退回最新一条。表里两者可以分开。
- **`dag_nodes.position` / `scheduled_runs.position` / `queue_items.position`** 都是草图里没有的列，
  理由相同：这三个数组的顺序是界面上看得见的（列表顺序、drain 顺序、`queued()` 反着读）。
  项目的裁剪（`MAX_RUNS`）不需要一条特殊 `DELETE`——从内存里没了就是一行 `DELETE`，去抖之后的差别
  比较本来就做这件事。
- **记忆账本的表按 §5.4 建**，`MemoryStateFile` 这个内存对象和它上面所有业务规则一行没改；
  「清除」现在连表一起清。
- **实测（`node scripts/bench-sqlite.mjs`，Author Mac，2026-10-18）**：检查点的存储写入
  35 文件 × 8 KB **0.42 ms**、16 × 2 MB（32 MB 上限）**79 ms**、200 × 100 KB（20 MB）**52 ms**、
  1 × 2 MB 3.5 ms；会话目录 flush（50 会话 / 5 项目）**0.12 ms**；建库 + 8 步迁移 + 打开 7 个 store
  **2 ms**。决定 3 因此成立：捕获时落盘的代价可以接受，不需要退回到「只在回合结束时写一次」。
  注意 `captureCheckpoint` 的总耗时里大头是每文件一次 `git rev-parse --show-toplevel`（约 5–8 ms），
  那是迁移前就有的开销。
- **收益实测**（`node scripts/compare-storage-backends.mjs`：同一份真实 userData 副本上，旧 store 用
  `git show HEAD:` 取出的迁移前真代码跑，新 store 跑表；落盘字节新路径取 `wal_checkpoint(TRUNCATE)`
  之后的 WAL 增量，即 SQLite 这次动作真的写了多少页）。Author Mac，2026-10-18：

  | 一次用户动作 | 旧耗时 / 落盘 | 新耗时 / 落盘 |
  |---|---|---|
  | 思考耗时写 1 条（表里 5000 条，文件 254 KB） | 2.9ms / 254 KB | 2.3ms / 20 KB（序列化 130 B） |
  | 记忆账本 usageCount+1（文件 409 KB） | 1.2ms / 409 KB | 0.5ms / 8 KB（序列化 24 KB） |
  | 会话目录改一个标题（44 会话，文件 28 KB） | 0.29ms / 28 KB | 0.19ms / 24 KB（序列化 476 B） |
  | 排队消息一次改动（文件 8 KB） | 0.17ms / 8 KB | 0.08ms / **16 KB** |
  | 定时任务一次改动（文件 282 B） | 0.13ms / 282 B | 0.03ms / **12 KB** |
  | DAG 改一个节点 output（合成 100 节点） | 0.34ms / 24 KB | 0.26ms / 16 KB |
  | 检查点（17 会话 / 55 文件 / 1.13 MB） | 捕获 0ms＋退出 4ms / 1.33 MB | 捕获 0.2ms（最大会话 0.3ms）/ 125 KB |
  | 稳态启动读全部状态 | 5.6ms | 9.2ms |
  | 第一次启动（含导入 5316 行） | — | 37ms（一次性） |
  | 磁盘占用 | 2.02 MB（7 个文件） | 2.48 MB（一个库） |

  读法：**「不是为了快」这句是对的，但也不是没有差别。** 收益按数据集体积走——
  思考耗时和记忆账本这种 250–400 KB 的文件，一次动作少写 13–51×，外推 100 次落盘是
  24.8 MB → 0.4 MB；小时级文件（队列 8 KB、定时任务 282 B）反而**多写**，因为 SQLite 的粒度是
  4 KB 页，这是它的固定开销，换来的是每次改动是一个事务而不是「temp+rename 整份」。耗时都在
  0.03–3 ms，本来就不在关键路径上。启动稳态慢 3.6ms（多读 7 张表 + 预热写入器），第一次多 37ms
  导入。库文件比 JSON 大 0.46 MB（页 + 索引 + `data` 里保留整份对象）。
  真正量不出来的收益是另外两条：崩溃不再丢检查点（旧版退出时那 1.33 MB 全没）、
  两个进程不再互相覆盖（`test/conversation-catalog-merge.test.ts` 里那条「A 删了 B 不会写回」）。

- **真实数据演练**（`node scripts/drill-sqlite-import.mjs`，复制到临时目录再跑）：本机 42→50 个会话、
  1.4 MB 检查点、260 KB 思考耗时（裁到 5000 条）、373 KB 记忆账本、162 行队列、DAG、定时任务，
  七个 store 全部导入成功，行数与逐条往返一致，旧文件都改名保留。
- **验证过的运行路径**：`pnpm build` 后 `node out/main/agent.js --headless --data-dir=…` 起来时建出
  `fastvibe.db`（0600，含 -wal / -shm），schema 到 v8。`electron-builder --dir` 产物里还没跑过一次
  （§9 的那条缓解项），发版前补。

档 D 没做的理由仍然是 §3.3；如果之后要做，`usage_turns` / `decision_trace` 两张表已经在这份设计里，
账本的「只存原始用量、按当前价格重新计价」那条约束不变。

## 12. 完成之后要同步的文档

已改（2026-10-18）：数据目录树、新增 `### SQLite 存储` 一节、「目录落盘是按行比较」（原「是合并，
不是整份覆盖」）、「重试与文件回退」的检查点落盘时机、「思考耗时」、「长期记忆」、「子 agent 任务编排」、
「定时任务」、「排队消息的立即发送」。`test/conversation-catalog-merge.test.ts` 的说明随之改写。
「使用统计」里的 `usage-ledger.jsonl` 仍然描述文件——那是档 D，没做。`docs/agent-runtime.md` 补上了
Node 22.13 的下限。
