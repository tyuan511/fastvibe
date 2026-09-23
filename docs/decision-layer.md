# 决策层：协议、配置与产品形态设计

> 目标：给 FastVibe 加一个**统一的可配置决策层**。第一版只服务 browser use：用答案空间受代码约束的决策模型，替代主模型逐步判断“下一步做什么、操作哪个元素”；后续再服务子 agent 角色选择和 agent team 协作调度。
>
> 代码基线 `973f375`（v0.9.0），调研日期 2026-09-22；2026-09-23 按 `cebc1cb`（v0.10.2）复核现有 browser 实现、权限沙箱与 App Server 能力分类，并按 TypeSafe API 参考核对线格式（§3.7、§7.1.1–7.1.4、§10 切片 0）。协议形状来自 TypeSafe 的 System One / Jev（`docs.typesafe.ai`，`browser-use/jev-ultrafast` 为参考实现）；交接机制补充参考 `shitianfang/jev-use@358819d`。以下均为设计，未实现或实测的能力不作产品承诺。

---

## 1. 结论

**可行，且比“接入 TypeSafe”更值得做**——因为我们要的是一个决策**层**，不是一个决策**服务**。

| 做 | 不做 |
| --- | --- |
| 定义我们自己的决策协议（`state + questions → answers`） | 把 Jev 当供应商/模型接进 pi-ai |
| 一个无会话语义的运行时 + 可插拔后端 | 为每个消费者各写一套“问模型要 JSON”的代码 |
| 设置中统一配置“大模型 / 决策模型 / 启用场景” | 把 `apiKeyEnv`、endpoint、后端内部字段直接暴露给用户 |
| 第一步支持 Jev，凭证由用户在决策引擎设置里填写 | 让 browser use 变成必须先配置多个新账号 |
| 一次请求扇出多个问题，答案空间由代码枚举 | 让模型发明动作、选择器、坐标 |
| 明确区分“有答案”和“可据此行动”，不确定时有限交接 | 把每次交接当服务故障，或盲目执行低置信度答案 |
| 决策 trace 作为一等公民 | 先做调度，再补可解释性 |
| 第一版只启用 browser use，保留未来 binding | 同时实现 browser、subagent、team 三套 consumer |

**核心判断**：Jev 值得抄的只有它的**形状**（state 是数据、问题由代码枚举、一次扇出、答案带概率），其余都是它家模型的实现细节。我们定义自己的协议，在第一版用 Jev 作为决策模型；以后可以接本机规则、普通 chat 模型或自建决策服务，而不改变 consumer。

**已确认不可行的一条**：Jev 不能作为供应商接入。TypeSafe 官方文档 `introduction/coding-agents.md` 明确写了 “Jev is **not** a drop-in replacement for the LLM behind Claude Code, Cursor, opencode… There is no `model: "jev-latest"` setting that turns your coding agent into a Jev-powered agent”。协议层面也如此：`POST /v1/systemone` 不是对话/补全协议，现有常用 api（`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`）不能直接处理它，而它**不生成文本**——`TYPE_TEXT` 那一步做不了，`jev-ultrafast` 为此硬编码了第二个模型。

TypeSafe 虽然提供 `GET /v1/models`，也不代表它兼容现有供应商解析器或对话协议。因此 v1 的 Jev 配置只出现在设置 → 决策引擎，不作为普通对话模型进入 composer。这里的限制是“不能直接作为现有对话模型”，不是说产品不能管理决策服务。

---

## 2. 要抄的形状（四条，且只有四条）

| 形状 | 内容 | 为什么它是对的 |
| --- | --- | --- |
| **state 是数据，不是对话** | 没有 `messages`、没有 role、没有 streaming；state 是 JSON 值 | 减少无关上下文，便于 hash 和重放；实际速度和价格还取决于模型、服务与网络，协议本身不保证加速 |
| **问题由代码枚举** | `criteria` 由调用方给出，模型只能在其中选 | 模型输出只允许引用代码提供的候选；外部响应仍须运行时校验，不能只依赖 TypeScript 类型 |
| **一次请求扇出多个问题** | 一次提交多种假设下的问题；Jev 支持独立求值，其他后端须实测延迟 | “操作 + 该操作的目标”可以一次请求完成 |
| **答案带概率与 confidence** | 调用方分支、排序、升级 | 让“不确定”成为一等状态，而不是被压成一个字符串 |

**不要抄的**：`jev-latest` 这类浮动别名作为永久锁定策略（官方明说 answers 会随版本变）、TypeSafe 的具体 prompt 措辞、以及“Jev 是大模型”的产品定位。

---

## 3. 我们的协议

### 3.1 类型（`src/main/engine/decision/protocol.ts`）

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DecisionState = JsonValue;

type QuestionMeta = {
  instructions?: string;
  /** 该问题是 speculative head；只有条件成立时才要求它的答案。 */
  requiredWhen?: { question: string; equals: string };
};

export type Question =
  | ({ type: "choice"; criteria: Record<string, string> } & QuestionMeta)
  | ({ type: "score"; criteria: string[]; min?: number; max?: number } & QuestionMeta)
  | ({ type: "noul" } & QuestionMeta);

export type DecisionConfidence =
  | { value: number; source: "reported" }
  | {
      value: number;
      source: "estimated";
      method: "top-two-margin" | "binary-distance";
    };

export type Answer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: DecisionConfidence }
  | { type: "score"; score: number; probabilities?: Record<string, number>; confidence?: DecisionConfidence }
  | { type: "noul"; noul: number; confidence?: DecisionConfidence };

/** 切片 4 才成为 HTTP body；切片 1 先作为进程内契约。 */
export type DecideRequest = {
  version: 1;
  binding?: string;          // "browser.step"，后端可据此选择自己的 prompt
  state: DecisionState;
  questions: Record<string, Question>;
  model?: string;
};

export type DecideResponse = {
  version: 1;
  backend: string;
  answers: Record<string, Answer>;
  usage?: { inputTokens?: number; outputTokens?: number };
};

/** 与 decide 分开的文本能力；它不是决策协议的一部分。 */
export type TextResolveRequest = {
  binding: string;           // "browser.text"
  state: DecisionState;
  instructions: string;
  maxLength: number;
};
```

`JsonValue` 显式限定可序列化 JSON，支持对象数组（如 elements/recentActions），同时拒绝函数、undefined 和非有限数值；不能只依靠宽泛的 `unknown` 类型约束输入。

`DecideResponse` 是 adapter 归一化后的响应，**不是执行许可**。binding 的宿主策略再产生如下结果；此 envelope 不原样发送给 Jev：

```ts
export type HandoffReason =
  | "writing"
  | "open_ended"
  | "oversized"
  | "unsure"
  | "unreachable"
  | "invalid_response";

export type DecisionOutcome =
  | {
      status: "decided";
      answers: Record<string, Answer>;
      activeQuestionIds: string[];
    }
  | {
      status: "handoff";
      reason: HandoffReason;
      partialAnswers?: Record<string, Answer>;
      affectedQuestionIds?: string[];
    }
  | { status: "cancelled" }
  | { status: "exhausted"; reason: "budget" | "deadline" };
```

- `decided` 只说明必要答案通过校验及该 binding 的采纳策略；执行仍要检查新鲜度、权限与取消。
- `handoff` 是需要交还控制权的结果；`partialAnswers` 仅作判断线索，不是可执行命令，也不代表部分动作已经发生。
- `cancelled/exhausted` 是终止信号，不能 fallback 到另一个模型继续运行。这里的 deadline 指整个 run 的截止时间，不是单个后端请求的超时；所有模型阶段共享该终止语义。
- 后端/model、请求 id、usage 和时延留在运行记录中，不因 handoff 丢弃；动作执行状态由 consumer 另记。

### 3.2 比 Jev 多的三样

#### 3.2.1 `probabilities` 必须可选

我们至少会有三种后端：

- 本机规则引擎（纯代码）：给不出概率；
- 普通 chat 模型：即使输出概率，也不能假定它校准过；
- Jev 或自建决策模型：可能提供校准概率。

把概率设为必填，等于宣布只有第三种后端能实现这个层。但“有一个数”也不等于可信：

- `reported` 仅指 adapter 在服务响应中实际读到的值，不是“已经证明校准”。普通 chat 模型自述的信心不自动等同 Jev 的 reported confidence。
- `estimated` 必须注明算法。choice 可用前两名概率差 `top-two-margin`；noul 可用 `2 × |p - 0.5|`（`binary-distance`）。两者只是决策信号，不是任务正确率。
- 缺失就是缺失，不能伪造为 0 或 1；noul 的 `P(yes)` 与“离不确定有多远”必须分开。
- `score` 暂不从分布估算 confidence，保留 provider reported 或缺失；有序尺度不能套用 choice 的解释。
- **Jev 的 reported confidence 本身就是分布形状统计量**（官方 `confidence.md`：由概率集中程度计算，三选项时约为 `(3 × 最大概率 − 1) / 2`），不是“置信度为 x 时正确率为 x”的校准值；noul 答案官方不返回 confidence 和 probabilities。因此 reported 与 estimated 在 Jev 上信息量相近，真正的“可采纳”信号只能来自本机评测（§10 切片 0）。官方给出的 <0.5 / 0.5–0.9 / >0.9 三档只作起点参考，且明说“阈值取决于领域”。

binding 的采纳策略需区分模型版本、问题类型、候选规模与 confidence 来源；v1 不增加阈值设置项，也不直接复制 jev-use 的 0.5/0.4。用本机评测确定内部策略版本并写入 trace。缺少可信采纳信号的模型判断走 `handoff: unsure`，不是默认放行；代码确定的单候选目标不伪造模型 confidence。

#### 3.2.2 文本解析是独立能力，不藏在 `decide()` 里

Jev 只做结构化决策，不生成文本。浏览器输入城市、关键词、日期时，需要一个大模型根据目标和字段上下文生成值。

这一步不放进 `decide()`，也不在 `Question` 里加 `resolve: "text"`：否则一次 `decide()` 可能偷偷产生第二次网络调用，预算、fallback、计量、trace 和失败语义都会变得不清楚。

改为明确分开的能力：

- `decide(request: DecideRequest, context: DecisionRuntimeContext)`：采纳策略处理后返回 `DecisionOutcome`，不自行调用大模型；
- `resolveText(request: TextResolveRequest, context: DecisionRuntimeContext)`：生成字段值，由 browser consumer 显式调用；
- `reviewStep(request: BrowserReviewRequest, context: DecisionRuntimeContext)`：用同一大模型审议当前浏览器步骤；是 browser consumer 的专用能力，不是通用决策协议的隐式第二次请求。

第一版的**大模型**承担文本生成和有限接管，默认跟随主模型，也可选择已配置供应商的任意模型。两种能力复用同一配置、凭证和运行预算，不增加第三个模型，也不改变主会话模型。

#### 3.2.3 `binding` 字段

`browser.step` / `browser.text` / `subagent.role` 是消费者能力名。远端后端可以据此选择自己的 prompt 与规则，但不需要客户端把内部 prompt 泄漏出去。它只是路由名，不是用户数据。

### 3.3 校验：会让消费方静默做错的规则

协议校验在层里，不在 consumer 里。任何**必需答案**不通过就产生 `handoff: invalid_response`，不钳制、不补默认值。问题能否发出在调用前筛查，答案是否值得采纳则在合法性校验之后判断；这三件事不能混成一个布尔值。

| 规则 | 说明 |
| --- | --- |
| choice 必须属于 criteria | 模型不能发明一个动作；不能钳制到“最近的”选项 |
| `requiredWhen` 只决定答案是否必需 | speculative target 可以缺失；只有 operation 选中了它的条件时，目标答案才必须存在 |
| 只执行选中 operation 对应的 head | 未选中的 target head 即使返回，也不能触发动作 |
| 有 probabilities 时必须自洽 | key 集合等于 criteria、数值有限且在 0..1、总和容差 2%、argmax 等于 choice |
| choice 候选数有上限 | 发往 Jev 的 choice criteria ≤ 255（官方上限）；超出由 consumer 裁剪或分层提问，runtime 不静默截断 |
| score 必须在题目声明的范围内 | criteria 2–10 项（Jev 上限；其他后端可放宽，但 v1 协议统一按 10 校验），默认范围为 0..criteria.length-1（可为期望值小数）；显式 min/max 必须有限且 min < max。adapter 负责尺度映射，不能静默截断 |
| noul 必须在 0..1 | 它表示一个命题成立的置信值，不是自由文本 |
| 缺少 operation 或已提交且被选中的 target → invalid_response | 单候选目标由 consumer 代码确定且不提交该 target 问题，见 §7.1；其余缺答案不能补默认值 |
| `usage` 先归一化再计量 | 不同后端字段名不同，不能直接信任原始响应 |
| state 超限必须记录截断 | 必须记录字段、截断前后大小；不能让“没看到按钮”变成无法解释的问题 |

校验必须有协议级测试，尤其是：依赖条件、缺少未选 head、缺少选中 head、概率不一致和非法 score。`requiredWhen` v1 只能引用一个无条件 choice 问题中的合法选项，不允许循环或多级依赖；它是宿主校验元数据，不原样发给 Jev。未知问题 id 拒绝；未选 head 不校验业务有效性、不执行。所需答案的 type 必须与题目一致，confidence.value 如存在必须有限且在 0..1，并携带合法 source/method。score/noul 暂仅作协议预留，v1 browser consumer 只用 choice。

### 3.4 这个协议不是什么

- **不是对话协议**：不自动附带整段主对话；允许 consumer 明确提供必要的历史摘要或 recentActions。
- **不是工具协议**：它不执行任何东西；执行在 consumer 里。
- **不是业务编排协议**：它可以报告交接原因，但不能自行调用另一个 agent、执行动作或调度团队；如何接管属于 consumer。

### 3.5 调用前筛查与交接原因

参考 jev-use 的 `screenQuestions / route`，先用代码判断任务是否适合决策模型，不为明显不适合的输入花一次请求：

| 原因 | 判断时点 | v1 browser consumer 的处理 |
| --- | --- | --- |
| `writing` | 调用前，已有合法输入目标且明确需要生成文本 | consumer 直接调用 resolveText；若没有输入目标则交回主 agent，不能当作可执行 TYPE_TEXT |
| `open_ended` | 调用前，没有可枚举的合法动作空间 | 交回主 agent；不能让大模型随意造 selector 补齐缺失能力 |
| `oversized` | 调用前，完整有效载荷超限 | consumer 重建有界 state，仍不满足则交回；不把同一超大输入盲目转发给大模型 |
| `unsure` | 调用后，必要答案合法但不满足采纳策略 | 以最新观测和部分答案进行一次有限的大模型审议 |
| `unreachable` | 调用后，连接/认证/额度/超时等失败 | 记录具体故障；可在剩余预算内有限接管，或直接交回主 agent |
| `invalid_response` | 调用后，所需答案违反协议 | 不执行该答案；大模型只能从原始合法候选重新审议 |

`writing` 来自宿主的能力路由，不是 Jev 返回的 operation；正常 browser.step 的 TYPE_TEXT 先决定目标，再进入同一 writing 路径。共享交接原因词表并不意味着把字段生成重新提交给 Jev。

业务调用方构造了非法问题（重复 id、循环依赖、非法条件）是实现错误，应在请求前失败并报诊断，不能当作开放问题无限转模型。

筛查覆盖 **state + instructions + criteria 等完整请求**，同时检查后端整体与单题上下文限制。中文不能简单按字符数除以 4 估 token；使用可用 tokenizer 或保守字节/长度上限并记录估算方式。候选裁剪由 consumer 负责，保持 ref 与 criteria 对应。

空候选不提供该操作；单候选目标可由代码暂存，只有 operation 已明确选中对应动作后才解析它，不凭“页面只有一个按钮”直接点击。

### 3.6 只评估当前真正需要的答案

browser 的处理顺序必须是：

1. 校验 operation 并评估其采纳信号；它本身不确定时，不执行任何 target。
2. 根据已采纳的 operation 计算 `activeQuestionIds`；如 CLICK，通常需要 operation 和 click_target。单候选目标已在构造问题前剥离到 consumer 的 localTargets，不算缺失答案。
3. 仅校验、评估这些必要答案。未选中的 type/select head 缺失或低 confidence 不能让本来明确的点击升级。
4. 必要目标不满足策略才 handoff；不把每个投机 head 的 `escalate` 做全局 OR。

概率接近的多个目标可能都合理，但不能通过随意降低阈值换取更多自动执行。评测同时记录采纳率、交接率、误操作率与候选分布，尤其检查某类答案是否从未被选中。

### 3.7 Jev adapter 线格式映射

以下按 TypeSafe API 参考（`docs.typesafe.ai/api.md`、`models`、`confidence.md`、`primitives/choice.md`，2026-09-23 读取）整理；实现前需重新核实，协议版本变化须体现在 adapter 版本号与 trace 中。

| 我们的字段 | Jev `POST https://api.typesafe.ai/v1/systemone` | adapter 规则 |
| --- | --- | --- |
| 鉴权 | `Authorization: Bearer <key>` | key 只在 Main 读取；日志与错误文案不回显 header |
| `state: JsonValue` | `state`: string / object / array | 原样发送 canonical JSON；不转成大段拼接字符串，便于 hash 对齐 |
| `model` | `model`（如 `jev-latest`，当前指向 `jev-1.13.0`） | trace 记录**响应**里的 `model`，不是请求别名 |
| `Question.instructions?` | `instructions` **必填**（string / object / array） | 缺省时由 binding 提供固定默认说明；不能发空串 |
| `choice.criteria` | `criteria`: map，≤255 项 | 候选 id 保持代码生成的短 id；描述放 value，不把 selector 当描述 |
| `score.criteria` | `criteria`: 2–10 个等级描述 | 响应 `score` 为加权期望值，另有 `legend`；按 §3.3 校验范围 |
| `noul` | 可选 `criteria.true/false` 说明 | 响应只有 `noul`（0..1），无 confidence / probabilities |
| `requiredWhen` | —（不发送） | 宿主元数据，只在本地校验时使用 |
| `binding` | —（不发送） | 只用于本地选择 instructions 模板和采纳策略 |
| `usage` | `usage.input_tokens` / `usage.output_tokens` | 归一化为 `inputTokens/outputTokens`；官方口径 output 不计费 |

请求上限：单次请求 64k tokens，其中 `state` + 最长问题 ≤ 32k；速率 1,200 次/分钟、250k tokens/秒（账号级，实际以返回为准）。筛查（§3.5）按这两个上限做 `oversized` 判断，估算方式写入 trace。

错误映射：

| HTTP | 含义 | 归类 | 重试 |
| --- | --- | --- | --- |
| 401 | key 缺失或无效 | `unreachable`（子类 auth） | 否；设置页状态改为“key 无效” |
| 422 | 请求校验失败 | 实现错误，按 `invalid_request` 诊断记录；本次步骤 `unreachable` | 否 |
| 429 | 限流 | `unreachable`（子类 rate_limit） | 是，指数退避，受 §4.3 单次超时约束 |
| 529 | 服务过载 | `unreachable`（子类 overloaded） | 是，同上 |
| 其他 5xx / 网络错误 | 服务或网络故障 | `unreachable` | 是，同上 |
| 200 但答案非法 | 违反 §3.3 | `invalid_response` | 否 |

官方文档也提到 `GET /v1/models`，但 API 参考未给出其字段；“测试连接”只以 2xx/401 区分连通与鉴权，不解析返回体。

成本量级（官方价，读时定价）：输入 $0.042 / 百万 tokens，输出免费。按 jev-use 报告里约 15k 输入 tokens/步估算，单步约 $0.0006，决策层的主要成本会来自大模型的文本生成与审议，而不是 Jev；计量与评测应按此分开统计。

---

## 4. 分层

```
src/main/engine/decision/
  protocol.ts        # 类型、canonicalize、校验；纯模块，可测
  dispatch.ts        # 调用前筛查、confidence 归一化与 binding 采纳策略；不执行业务
  executor.ts        # 后端调用、超时、重试、fallback；不持有业务会话
  runtime.ts         # budget、cache、trace、broadcast；只持有短生命周期运行元数据
  bindings.ts        # binding 名称、版本和保留命名空间
  backends/
    rules.ts         # 纯代码，无网络
    jev.ts           # Jev / TypeSafe systemone 适配器（第一版）
    chat.ts          # 未来：普通 chat 模型的结构化输出适配器
    system-one.ts    # 未来：自建决策服务适配器
  text.ts            # TextResolver，复用 providers 里的大模型
  # browser 的 reviewStep 留在 browser consumer，不放进通用 backend registry
  store.ts           # decision.json 读写
  trace.ts           # decision-trace.jsonl append-only
```

### 4.1 无会话语义约束（不是“所有对象都不能有状态”）

决策语义必须保持无会话状态：

```ts
type DecisionRuntimeContext = {
  budgetKey?: string;       // 由 consumer 生成，例如 browser run id
  signal?: AbortSignal;
  route?: {
    conversationId?: string;
    runId?: string;
    tabId?: string;
    owner?: string;
  };
};
```

- `state`、`questions` 和 binding 参与后端请求与缓存 key；
- `budgetKey`、`signal`、conversation/tab/owner 只用于运行路由、取消、预算、trace 和权限，不进入模型 state，也不进入决策语义；
- runtime 可以按 `budgetKey` 保存短生命周期计数，但不能把会话历史变成决策层的隐式输入。

这既保留了未来跨会话调度的能力，也符合 FastVibe 现有 browser bridge 的路由要求：browser 请求仍然需要 `conversationId`、`tabId` 和 owner，但这些不是模型判断的内容。

**不允许决策层组合业务决策。** dispatch 可以依据 binding 注册的策略给出 handoff，但不选择接管者、不启动大模型；consumer 决定接管、串行、任务重做或结束。runtime 负责网络重试、缓存、预算和未来显式 backend fallback，这些不改变业务动作。

### 4.2 正常交接、故障回退与终止必须分开

v1 固定使用 Jev adapter，不实现任意 fallback 链。流程是：

```text
筛查 → Jev 请求 → 必要答案校验/采纳 → DecisionOutcome
                                      ↓ handoff
                          browser consumer 决定有限接管或交回
```

- `writing/unsure` 是正常协作，不显示成“Jev 故障”；工具卡片可显示“由大模型生成 / 审议”。
- 配置缺失不提供 browser_task；运行中发生 `unreachable/invalid_response` 才显示降级原因，鉴权失败不盲目重试。
- 大模型有限接管是 consumer 的明确请求，沿用原 run 的预算；不是 runtime 偷偷换后端，也不改设置。
- `cancelled/exhausted`、撤销场景或清除 key 都必须收尾，不允许换模型继续。未收到结果的 mutation 保持 uncertain，不进入自动接管。
- 大模型也无法处理时，把当前观察、已执行动作和原因交回主 agent；禁止从原目标重新开始执行。

未来即使新增 backend fallback，也只能对尚未执行的决策请求尝试，受相同 deadline/预算和数据出站授权约束。

### 4.3 预算、超时、重试、缓存

| 机制 | 规则 |
| --- | --- |
| 单次请求超时 | 初始建议 8s，覆盖该请求的退避/重试总时长，不每次重置。若 run 仍有剩余时间，可作为 unreachable 交接 |
| 运行总 deadline | consumer 创建 run 时确定，所有 Jev/text/review 请求继承同一截止时间；先检查取消，再检查总预算/总 deadline。耗尽返回 exhausted，不进入 unreachable 或接管。实际请求时限取剩余 run 时间与单次上限的较小者 |
| 单轮预算 | consumer 为每次运行传 `budgetKey`，Jev、大模型填值、审议、修正和重试共同计数；初始上限为 200 次模型请求，另有总 deadline 和动作上限 |
| 接管预算 | v1 初始策略：每个步骤最多一次大模型审议、每轮最多三次审议/修正；失败后交回主 agent，不在 Jev 与大模型之间无限来回。这些是待评测内部值，不新增设置项 |
| 重试 | 429 / 529 / 其他 5xx / 网络错误最多退避重试 2 次；401 / 422 不重试（映射见 §3.7） |
| 重试安全性 | 决策不改变工作区或网页，但重试可能重复计费、给出不同答案；Abort 不重试，鉴权/参数错误不重试。浏览器变更不能因传输错误重试 |
| 缓存 | v1 不做跨运行决策缓存；仅允许同一 run、同一观测版本的未执行决策/文本复用。后续 key 须含 protocol/binding/config/model 版本、完整有效载荷和候选身份 |
| 缓存前提 | canonicalize 固定对象键顺序、保留数组顺序，拒绝非 JSON 值。不能为提高命中率删除 pageKey、node id 等新鲜度信息；命中也必须重新做执行前 guard |

### 4.4 trace（一等公民）

每次决策落一条 append-only 记录（`runtime/engine/decision-trace.jsonl`，与 `usage-ledger.jsonl` 同构）：

```jsonc
{
  "ts": "2026-09-22T…", "requestId": "…", "binding": "browser.step",
  "backend": "jev", "model": "jev-1.13.0", "budgetKey": "browser-run:…",
  "stateHash": "sha256:…", "stateBytesBefore": 9123, "stateBytesSent": 8123,
  "truncated": [{"field":"text","before":9123,"after":6000}],
  "questions": { "operation": { "type":"choice", "options":8 }, "click_target": { "type":"choice", "options":37 } },
  "answerSummary": { "operation": { "choice":"CLICK", "confidence":{"value":0.91,"source":"reported"} } },
  "activeQuestionIds": ["operation", "click_target"],
  "outcome": "decided", "handoffReason": null, "policyVersion": "browser.step/v1",
  "phase": "decide", "attempt": 1, "latencyMs": 178, "cacheHit": false,
  "usage": { "inputTokens": 15093, "outputTokens": 1054 }
}
```

三条硬规定：

1. **默认不落 state、criteria、instructions 或 text 全文。** 只落 hash、大小、选项数量和脱敏后的答案摘要；`answer.text` 只记录长度和 hash。
2. **调试全文必须显式开启、自动过期、0600 写入、可清理。** 不能因为一个长期设置就把网页内容永久写进磁盘。
3. **不落价格。** 只落原始 token + backend/model，读时再定价；cache hit、失败、重试也要有明确状态。

trace 还须区分 phase（decide/text/review）、confidence 来源与算法、候选数、采纳策略版本、受影响的问题、实际执行者及关联观测版本。一次未调用模型的预筛交接不产生模型费用；一次 Jev → 大模型接管保留两条独立请求记录。调试信息不是模型思维过程。

没有 trace，后面无法回答“为什么选了这个角色”“为什么这次没有点按钮”。它必须从切片 1 就存在，但第一版可以只提供日志与设置页摘要，不必一开始做完整 inspector。

---

## 5. 产品形态：设置 → 决策引擎

### 5.1 设置入口

新增设置 section：**设置 → 决策引擎**，section id 为 `decision`，加入 `SETTINGS_SECTIONS`。页面使用现有 `SettingsGroup` / `SettingsRow`，不另造一套表单布局。

这不是供应商设置的子项：大模型复用供应商模型，但 Jev 不是对话模型，必须在这里配置。

页面顺序：

1. 当前状态卡；
2. 大模型；
3. 决策模型；
4. 启用场景；
5. 数据与隐私说明。

### 5.2 大模型

**大模型**负责生成与有限接管：为 TYPE_TEXT 生成字段值；在 Jev 不确定或不可达时，审议当前步骤；根据新的页面证据修正输入。它不是另一个自主 agent，不能自行调用浏览器工具或扩大任务授权。三种工作复用这一处模型选择，不增加“接管模型”设置。

产品行为：

- 可选择已添加供应商中用户配置的任意模型；复用现有模型选择器，不另设预选白名单。缺失认证或不可用的条目标注状态并禁止新选入，已有失效选择保留供修复；
- 默认值为**跟随主模型**，内部保存为 `{ kind: "main" }`，而不是复制当前 provider/model；
- **主模型指发起本次 browser run 的主 agent 会话模型**，不是全局 `settings.defaultModel`，也不是最后激活窗口的模型。按明确的 `conversationId` 获取；会话确实没有模型时才尝试全局默认模型，仍不可用则提示配置；
- 每个 browser run 开始时解析并固定 provider/model 与配置版本；主会话中途切换模型只影响下一次 run。设置页可显示当前会话的解析结果，但不同会话各自跟随自己的模型；
- 用户也可以选择任意已连接供应商的具体模型 `{ kind: "model", provider, id }`；
- provider 被删除、模型失去认证或模型不再存在时，状态显示“模型不可用”，不静默改写用户选择；运行时按 fallback 规则回到当前 browser use 行为；
- 修改大模型不重启 engine，下一次 browser run 生效；不修改主对话的模型选择，也不生成主对话“模型切换”分隔线。

这里的“大模型”不是新增供应商，也不接受新的 API key。模型凭证继续由现有供应商设置管理。

### 5.3 决策模型

第一版只提供一个决策模型：**Jev**。

UI：

- 决策模型选择器显示 Jev；预留未来模型列表的扩展点，但 v1 不展示自建 endpoint 或任意 URL；
- API key 输入框为密码控件，提供保存、清除、测试连接；
- key 由 Main 写入 `runtime/engine/agent/.env`，renderer 只能读到“已配置 / 未配置”，永远不能读回原文；
- Jev endpoint 和 API 协议由内置 adapter 持有，用户不填写 `apiKeyEnv`、headers 或 URL；
- “测试连接”调用固定 Jev `GET /v1/models` 验证认证与连通性，不假定有 health 端点，也不发送网页或会话内容。成功只表示连接可用，不保证有推理额度或 browser 任务成功；
- Jev 的输入 token 计入决策层使用统计，output token 按 provider 返回值归一化。

状态显示：

| 状态 | 含义 | browser 行为 |
| --- | --- | --- |
| 未配置 | 没有 Jev key | 决策层不可用，使用现有 browser use |
| 待配置大模型 | Jev key 有，但大模型没有可用解析结果 | 决策层不可用，使用现有 browser use |
| 已就绪 | 本地配置检查通过；另展示上次连接测试时间/结果 | 可以尝试 browser 决策循环，不承诺实际推理一定成功 |
| 降级 | 本次 Jev 超时、限流或协议错误 | 剩余预算允许时有限接管，否则交回主 agent；显示具体原因 |

正常的 writing/unsure 交接不改变设置页的服务可用状态；运行卡片显示“由大模型生成 / 审议”，统计可分别查看正常交接与故障降级。

### 5.4 启用场景

页面提供一个**场景勾选区**。第一版只有一个可启用场景：

| 场景 | v1 | 使用的能力 | 默认值 |
| --- | --- | --- | --- |
| Browser use 优化 | 可勾选 | `browser.step` + `browser.text` + `browser.review`（消费方专用） | 关闭 |

后续的“子 agent 选择”“agent team 调度”暂不出现在 v1 的可选列表中，避免用户看到不能工作的半成品；它们只作为内部 binding 预留。

勾选行为：

- 勾选只保存用户意图；如果 Jev key 或大模型缺失，行内显示“待配置”，并提供跳转到对应设置行的入口；
- 运行时再次检查配置，不会因为勾选状态绕过认证或权限；
- 取消勾选后，不删除 key 或大模型选择；新任务回到现有工具路径。正在运行的 browser consumer 在下一个安全边界停止继续调用决策层，返回已执行动作与当前状态，不撤销或重放已经发生的动作；
- 开启场景、修改模型或替换 key 不重启 engine，新配置在下一次 browser run 生效；关闭场景和清除 key 属于撤销授权，阻止旧运行继续发起新的请求；
- browser use 的工具描述或工具结果应能告诉主 agent 当前场景是否启用，避免主 agent 误以为所有浏览器动作都由 Jev 接管。

### 5.5 数据与隐私提示

决策引擎页面必须明确说明：

> 启用 Browser use 优化后，任务目标、可见页面文本、控件信息和必要操作历史会发送给 Jev；生成输入内容、审议步骤或修正输入时，相关上下文也会发送给所选大模型的供应商。程序会排除密码、文件和隐藏输入字段，但页面正文仍可能包含隐私信息，请确认允许这些数据出站。

这不是一条藏在高级设置里的提示。用户勾选 Browser use 场景时，如果决策模型是远端 Jev，首次启用必须确认一次；之后页面仍保留可见的出站说明与关闭入口。

### 5.6 持久化形状（v1）

`decision.json` 放在 userData 根目录，与 `providers.json` / `mcp.json` 同级：

```jsonc
{
  "version": 1,
  "largeModel": { "kind": "main" },
  "decisionModel": { "kind": "jev", "model": "jev-latest" },
  "scenarios": { "browserUse": false },
  "consents": { "browserUse": { "version": 1, "accepted": false } },
  "trace": { "keep": 2000 }
}
```

v1 不把 backend registry、endpoint、`apiKeyEnv` 暴露给用户。未来支持自建决策服务时再扩展 schema，并由 Main 做固定 allowlist、HTTPS、重定向和凭证映射校验。

### 5.7 IPC 与同步

建议增加以下共享 IPC 方法，全部通过 `src/main/ipc/registry.ts` 的 `handle()` 注册，不能直接写 `ipcMain.handle`：

- `decision:get-config`：返回脱敏配置与状态；
- `decision:save-config`：保存大模型选择和场景开关；
- `decision:set-key`：设置或清除 Jev key，只接受 key 值，不返回 key；
- `decision:test`：测试固定 Jev endpoint，不带真实 state；
- `decision:changed`：配置变化的广播事件，不带秘密。

配置写入后使用现有 broadcast hub 同步窗口。renderer 只拿到 `hasKey`、模型可用性、启用场景和错误状态；`decision.json`、`.env` 原文不会进入 settings snapshot。`src/shared/api.ts` 是 Electron/Web 共用入口，不能只改 preload。

远程策略：`get-config` 允许读脱敏配置/状态；save-config、set-key、test 拒绝远程。`decision:changed` 仅广播同样的脱敏 DTO。主进程内部 decide/resolveText/reviewStep 不暴露为 renderer 可自由调用的通用网络 RPC；未来 trace 查询需单独分类，v1 不推送原始 trace。

配置读取：首次缺文件采用“大模型跟随主模型 + Jev 未配置 + Browser use 未勾选”；损坏或未知 version 保留原文件、报告状态并停用优化，不直接覆盖。保存校验后通过临时文件原子替换，串行化写入。旧安装只新增此默认配置，不改变现有 browser use 行为。

---

## 6. 配置与凭证边界

### 6.1 凭证：复用 `paths.agentEnv`，但不能让用户指定变量名

Jev key 可以继续写入现成的 `<userData>/runtime/engine/agent/.env`（0600），但不应把通用的 `apiKeyEnv` 暴露在配置文件里。第一版由 Main 固定使用内部变量名，例如 `FASTVIBE_JEV_API_KEY`，并通过专用 API 读取：

```ts
loadDecisionCredential(paths, "jev")
setDecisionCredential(paths, "jev", value)
```

不能让设置页或远程调用者传入任意环境变量名；否则“决策 key”接口会变成读取 `.env` 任意秘密的入口。只有“清除 API key”或明确确认的“重置决策引擎”才删除 Jev key；取消场景不会删 key，删除大模型选择也不影响供应商 key。共享 `.env` 的读改写必须和供应商凭证写入串行化并原子替换，避免两处同时保存互相覆盖。

### 6.2 未来后端与接入渠道

**模型与渠道分开。** jev-use 源码提供 TypeSafe、OpenRouter、Vercel 三种 Jev 接入：TypeSafe `/v1/systemone`、OpenRouter `/api/alpha/decisions`、Vercel evaluation-model 协议。后两者不是普通 chat completions；Vercel 的 confidence 还可能位于 providerMetadata，而非答案对象内。以上为该版本源码观察，未来接入时必须重新核实官方协议。

v1 产品仍只有“Jev + API key”（TypeSafe 直连），不新增网关选择器。内部记录 decision model 与 transport 分开，使以后可增加网关 adapter 而不修改 consumer；后端响应必须先归一化 confidence 来源、模型版本和 usage。现有供应商凭证可否复用需显式设计，不能因为同属一个域名就把 key 交给另一渠道。

协议可以支持以下后端，但不是 v1 产品入口：

```ts
type DecisionBackend =
  | { kind: "rules"; id: string }
  | { kind: "chat"; id: string; model: ModelRef }
  | { kind: "system-one"; id: string; baseUrl: string; credentialId: string; model: string }
  | { kind: "jev"; id: string; model: string };
```

未来自建 endpoint 必须由 Main 只接受已审核的 backend id，不能让 renderer 或远程客户端提交任意 URL、headers、代理或 credential 名称。v1 的 Jev adapter 使用固定 HTTPS endpoint，禁止跟随重定向携带凭证，保留系统 TLS 证书校验；不能仅凭初始 URL 固定就忽略响应重定向和日志泄密。

---

## 7. 消费者

### 7.1 `browser.step`（第一版唯一 consumer）

循环在 Main，观测/执行经 `browser:request` 往返渲染进程（现有 `src/main/pi/browser-bridge.ts` + `handleBrowserRequest`）。建议新增任务级工具 `browser_task({ goal, tabId? })`：主 agent 一次委派一个目标，Main 自行跑闭环，而不是每步再向主模型询问“是否调用 Jev”。只有场景已启用、配置可用时才对该会话提供工具；现有 browser_* 工具保留。

配置关闭或失败后，consumer 返回明确的 `blocked/degraded/cancelled/uncertain/completed` 状态、已执行动作和当前观察，让主 agent 从当前状态继续。**回退不是自动重跑原目标**；已经点击过提交的任务不能因为换了后端再提交一次。任务运行绑定 conversation/run/tab/owner，主会话停止必须取消其请求、等待和所属审批；宿主维护 busy 状态，切换窗口不能丢失归属。

```text
observe(渲染进程)
  → state = { url, title, text(视口内), elements[], recentActions[] }
  → questions = {
       operation:        Choice(本次可用操作 + WAIT / DONE / BLOCKED),
       click_target:     Choice(仅可点击元素, requiredWhen operation=CLICK),
       type_text_target: Choice(仅可编辑元素, requiredWhen operation=TYPE_TEXT),
       select_target:    Choice(控件与 option 的唯一组合 id, requiredWhen operation=SELECT),
     }
  → outcome = decide(request, context)
  → cancelled / exhausted：结束，不接管
  → handoff：按 §3.5 分派，不把所有原因统一送去 reviewStep
      writing + 已确认输入目标：resolveText（没有合法目标则交回主 agent）
      unsure/unreachable/invalid_response：预算允许才有限 reviewStep
      oversized：重建有界观测；open_ended：交回主 agent
  → decided：读取 activeQuestionIds 答案，目标也可由本次观测的单候选映射确定
  → 若 operation=TYPE_TEXT，进入同一 writing 分支，显式调用 resolveText
  → 再次检查权限 / 取消 / freshness guard
  → act(ref, text) → observe again
```

问题构建规则：没有合法目标的操作不进入 operation 的 criteria，对应 target 问题也不创建；不允许空 choice。SCROLL_UP/DOWN 只在当前视口可滚动时出现。SELECT 候选使用代码生成的唯一 id（如 `select:e7:option:2`），宿主映射到本次观测的 select node + option identity/value；不能只返回一个跨控件有歧义的 option 索引。所有动态候选由快照构建，模型不能自行拼接 id。单候选目标不构造 target 问题：`DecideRequest.questions` 和 `activeQuestionIds` 都不含它，因此不触发“缺少必要答案”校验。consumer 单独持有 `localTargets: Record<operation, { observationId, candidateId }>`，在 operation 已采纳后取本次观测的唯一目标。它不写入 answers、不伪造模型 confidence，trace 将目标来源标为 `deterministic`。新鲜度与权限校验照常执行；若此时唯一目标已变化则重新观察，不自动替换。

这里有三种上下文，必须分开：

- **决策语义上下文**：state、questions、binding，发给 Jev；
- **运行路由上下文**：conversationId、runId、tabId、AbortSignal，负责找到正确 browser tab 和取消运行，不发给模型；
- **安全上下文**：owner、permission mode、数据出境确认，负责判定是否允许这次运行。

这个循环依赖两件不在决策协议里的东西，但必须先有：

1. **观测与执行的新鲜度 guard。** 决策和变更之间隔着网络往返，页面可能已经变化。click/select 前比对 `pageKey + guard(node)`；执行前再校验 connected / 可见 / 非 disabled / 非 inert / 几何 / `elementFromPoint` 遮挡；不一致就**不重试变更**、重新观察再决策。
2. **快照排除敏感字段。** `password` / `file` / `hidden` 类型的输入值不得进入 state。

观测/执行不变量：

- `pageKey` 标识文档生命周期，稳定 node ref 绑定实际 DOM 节点；导航或节点替换使旧引用失效，不能静默退回模糊匹配。
- 同一 tab 的运行必须串行或独占，用户仍可操作页面，因此每次 mutation 前都做 guard。文本生成之后也要再校验。
- consumer 在发送 mutation 前检查权限与取消信号；不得因只有外层 browser_task 获批而绕过 ask/smart/full 的动作权限。现有沙箱并未给 browser_* 单独分类，宿主执行路径需要自己的动作权限判定（§7.1.3）；付费、发送、删除等超出原授权的行为仍须审批。审批按 conversation + owner 归属。
- mutation 先记录已发出/确认/结果未知，再观察。执行结果不明或导航打断时返回 uncertain，不重放；stale 且确认未执行时才可重新观察再决策。
- WAIT 有次数与总时限，每次等待后重新观察；BLOCKED 带原因交回主 agent；DONE 只是完成候选，必须用最新页面证据核验目标，无法验证时不能报告成功。
- SELECT 引用本次观测里的合法 option，执行前确认 option 仍存在且可用。
- 视口摘要适用于动作决策；保留完整页面阅读能力，不能把文章阅读也强制裁成首屏。
- 将固定 500ms 等待改为有界、状态感知的等待，仍监听真正的导航和加载失败。后台节流策略需实测，不能仅缩短计时器而丢掉延迟导航。
- browser state 的裁剪由 consumer 完成，候选表、criteria、ref 映射必须一致；通用 runtime 超过预算应拒绝而非任意截断 JSON。

Jev 返回的选择概率不是授权，也不是任务成功证明。

#### 7.1.1 现有实现与上述不变量的差距（v0.10.2 核对）

上面的不变量大多**还不存在**。它们是切片 3 的前置工作，其中两条是现有 browser_* 工具本身的缺陷，不依赖决策层，应先单独修：

| # | 现状（文件） | 问题 | 需要的改动 |
| --- | --- | --- | --- |
| G1 | `SNAPSHOT_BODY` 的 `text` 取 `el.innerText \|\| el.value …`（`side-pane-browser.tsx`） | `input[type=password]` 的 innerText 为空，会回落到 **明文密码值**进入快照；`PAGE_HELPERS.label/nearby` 也会把它放进 `candidates` 返回给模型。**已是现有泄漏，与决策层无关** | 快照与 label 对 password/file 类型只取 aria-label/placeholder/name，永不取 value；先修 |
| G2 | 每次快照 `setAttribute('data-fv-ref', 'e'+index)`，不清除旧标记；`resolve()` 用 `querySelector` 取第一个匹配 | 上次快照的 `e5` 若仍在 DOM 中且排在前面，会点到**旧元素**；也是现有缺陷 | 快照前清除全部旧 `data-fv-ref`，或 ref 带快照代号（`s12:e5`） |
| G3 | `resolve()` 依次回落 ref → selector → 可见文字模糊匹配 | 与 §7.1“旧引用失效不能退回模糊匹配”冲突 | 新增 strict 模式：browser_task 路径只按 ref 解析，失配即 stale |
| G4 | 快照无 `pageKey` / 快照版本；元素无几何、无视口标记 | 无法做 freshness guard，也无法只给视口内候选 | 快照返回 `pageKey`（导航代号 + 文档 URL）、`snapshotId`、每个元素的 `inViewport`、`rect` |
| G5 | `text` 为整页 `body.innerText` 前 8,000 字；元素按 DOM 顺序截前 150 个 | 首屏外元素可能占满名额，视口内按钮反而缺失 | 决策用快照优先视口内元素、再按距离补足；阅读用快照保持原行为 |
| G6 | select 走 `type` 动作，按 value/文字**模糊**匹配 option | 与“SELECT 引用唯一 option id”冲突 | 新增 `select` 动作：按 option 下标 + value 精确匹配，失配报 stale |
| G7 | 没有 scroll 动作；`press` 发给 `document.activeElement` | SCROLL 无法执行；PRESS_ENTER 可能打到用户刚点过的别处 | 新增 `scroll`；按键前校验焦点仍在上一步输入的 ref 上 |
| G8 | `act()` 的 grace 固定 500ms（`waitForNavigation`） | §7.1 要求有界、状态感知的等待 | 保留导航监听，加 DOM 静默/网络空闲的有界等待，上限仍由 run deadline 截断 |
| G9 | `browser-bridge.ts` 只绑定**最后 attach 的那个 renderer**，请求不带 runId，也无取消 | 主会话停止无法中断正在等待的 browser 请求；多窗口时路由依赖单一 target | 请求增加 `runId` 与取消消息；Main 侧 pending 按 runId 可批量 reject |
| G10 | `permission-sandbox.ts` 没有为 browser_* 分类，它们落入“opaque 未知工具” | ask 模式每次调用都确认，smart 只看参数是否命中风险正则，full 不确认。§7.1 所说“复用现有权限判定”并不存在 | 见 §7.1.3 |

G1、G2 建议作为独立修复先行，不等决策层立项。

#### 7.1.2 操作集合与现有动作的对应

operation 的候选全部映射到 renderer 已有或需新增的动作；没有映射的能力不出现在 criteria 里：

| operation | 出现条件 | target 问题 | 执行 |
| --- | --- | --- | --- |
| `CLICK` | 视口内有 ≥1 个可点击元素 | `click_target` | `click`（strict ref） |
| `TYPE_TEXT` | 有可编辑且非 password/file 的元素 | `type_text_target` | `resolveText` → `type`（strict ref） |
| `SELECT` | 有可用 `<select>` option | `select_target`（`select:e7:option:2`） | 新 `select` 动作（G6） |
| `PRESS_ENTER` | 上一步是对某输入框的 TYPE_TEXT，且焦点仍在该框 | 无（目标由代码确定） | `press Enter`，先校验焦点（G7） |
| `SCROLL_DOWN` / `SCROLL_UP` | 视口可继续滚动 | 无 | 新 `scroll` 动作 |
| `BACK` | `canGoBack` | 无 | `back` |
| `WAIT` | 页面仍在加载或最近一步触发了异步变化 | 无 | 宿主有界等待，计入 WAIT 次数 |
| `DONE` | 总是 | 无 | 宿主核验（§7.1 不变量） |
| `BLOCKED` | 总是 | 无 | 交回主 agent，附原因 |

有意**不提供**的：任意 URL 导航与搜索（需要生成文本且可能越出任务范围，归 `open_ended`/`writing` 交回主 agent；run 的起始页由主 agent 用现有 `browser_open` 决定）、`evaluate` 脚本、新开标签页。

每个 target 问题都附加一个 `NONE` 候选，描述为“没有合适的元素”（官方建议 choice 总是包含 none-of-the-above）。选中 `NONE` 等价于 operation 不可执行，走 `handoff: unsure`，不执行任何动作。

候选描述由代码拼装：`[角色/标签] 可见文字 · name/placeholder · 所在区域（header/form/dialog）`，截断到固定长度；不放 selector、不放 href 的查询串（可能含 token），只放 origin + path。

#### 7.1.3 动作权限：browser_task 需要自己的分类

现状是 browser_* 在沙箱中被当作未知工具（G10）。`browser_task` 在一次工具调用里执行多个动作，沙箱的 `tool_call` 钩子只会看到外层那一次，所以内部每次 mutation 前必须由宿主自己判定。建议：

| 模式 | 外层 `browser_task` | 内部普通动作 | 内部高风险动作 |
| --- | --- | --- | --- |
| ask | 确认一次，对话框显示 goal 与起始页 origin | 不再逐步确认 | 逐次确认 |
| smart | 不确认（与 web 访问同级，`network: true`） | 不确认 | 逐次确认 |
| full | 不确认 | 不确认 | 不确认 |

- **高风险动作**由代码判定，不由模型置信度判定：点击 `type=submit` 或位于含 password/支付字段表单内的按钮；可见文字或 aria-label 命中“支付/购买/下单/删除/发送/提交/确认订单/pay/buy/order/delete/send/submit/confirm”等词表；离开起始 origin 的导航后第一次 mutation。
- 确认通过该会话的 `#extensionUi(conversationId)` 发出（与沙箱同一 confirm 通道），对话框写明“在 {origin} 点击「{label}」”；拒绝即 `blocked`，交回主 agent。
- 无确认 UI 的会话（`ctx.hasUI === false`）遇到需要确认的动作一律 blocked，与沙箱现有行为一致。
- 这改变了 ask 模式的体验：原来每次 browser_click 都确认，现在变为一次任务确认 + 高风险确认。**需产品确认**；若不接受，ask 模式下不提供 browser_task，只保留逐步工具。

#### 7.1.4 `browser_task` 工具契约

```ts
// 参数
{ goal: string; tabId?: string; maxSteps?: number /* 默认 20，上限 40 */ }

// 结果（details 字段；content 为同内容的简短文本摘要）
type BrowserTaskResult = {
  status: "completed" | "blocked" | "handed_off" | "degraded" | "uncertain" | "cancelled" | "exhausted";
  summary: string;                       // 给主 agent 的一句话
  actions: Array<{
    step: number;
    operation: string;                   // CLICK / TYPE_TEXT / …
    target?: { label: string; role?: string };  // 不含 selector、不含填写值
    decidedBy: "jev" | "deterministic" | "review";
    status: "confirmed" | "unknown" | "rejected_stale" | "denied";
  }>;
  observation: { tabId: string; url: string; title: string };
  handoff?: { reason: HandoffReason | "verification_failed" | "permission_denied"; remaining?: string };
  usage: { jevRequests: number; largeModelRequests: number };
};
```

- 填入字段的文本不写入结果，只写“已填写 {字段 label}（N 字）”；主 agent 需要时自行 `browser_snapshot`。
- `completed` 必须附带 DONE 核验通过的依据（哪条页面事实）；否则只能是 `uncertain`。
- 工具描述必须说明：它只在已打开的标签页内执行点击/填写/选择/滚动，不会自行打开新站点；目标需要搜索或打开网址时先用 `browser_open`。

### 7.2 大模型在 browser use 中的职责

Jev 负责快速选择，大模型负责**生成、审议与修正**。设置仍只有一个“大模型”选项，下面两个能力由同一模型提供。

#### 7.2.1 生成字段文本

TYPE_TEXT 已选定目标后才调用 TextResolver，不为未选中的输入 head 投机生成文本：

```ts
// runtime 在 run 开始时已解析并固定该 run 使用的大模型。
const result = await decisionRuntime.resolveText(
  {
    binding: "browser.text",
    state: {
      goal,
      field: { label, role, currentValue },
      page: { title, visibleText },
      recentActions,
    },
    instructions: "只返回要填入所选字段的文本，不生成动作或脚本；缺少必要信息则返回不可用。",
    maxLength: 2000,
  },
  { budgetKey: runId, signal, route: { conversationId, runId, tabId, owner } },
);
```

TextResolver 返回 `{ status: "ok", text: string } | { status: "unavailable", reason: string } | { status: "cancelled" } | { status: "exhausted", reason: "budget" | "deadline" }`。仅 ok 分支可执行，需限制长度并保留合法空串（用户明确要求清空字段时）。内容始终作为字段数据插入，不能作为动作、selector 或脚本执行。unavailable 可交回主 agent，不能重复执行上一次 mutation；cancelled/exhausted 必须终止 run，不走 reviewStep 或其他模型。

#### 7.2.2 有限审议与证据驱动修正

browser consumer 的专用接口如下，不注册为任意 agent 工具，不启用 tools，不加载整个主会话历史：

```ts
type BrowserReviewRequest = {
  binding: "browser.review";
  observationId: string;
  goal: string;
  state: DecisionState;              // 最新的、经过出站过滤的观测
  questions: Record<string, Question>; // 当前合法 operation/target 候选
  cause:
    | { kind: "handoff"; reason: HandoffReason }
    | { kind: "verification_failed" };
  partialAnswers?: Record<string, Answer>; // 仅线索，不是模型必须遵从的指令
  evidence?: DecisionState;          // 观察到的差异，不是猜测的失败原因
};

type BrowserReviewResult =
  | { status: "proposed"; answers: Record<string, Answer> }
  | { status: "return_to_agent" }
  | { status: "cancelled" }
  | { status: "exhausted"; reason: "budget" | "deadline" };
```

`reviewStep(request, context)` 在 proposed 分支返回**动作提议**；cancelled/exhausted 直接终止，不能改写成普通 return_to_agent 继续运行。提议须经过同一 choice 成员/依赖关系校验、权限判定、取消检查和新鲜度 guard；无需要求大模型编造 confidence。它不直接执行、不生成任意脚本/selector、不因接管而获得更多工具。

规则：

1. operation 不确定时从最新完整候选重审；只有选中 target 不确定时可聚焦该步骤，但旧答案不构成授权。
2. partialAnswers 可保留用于解释交接，绝不能先执行低置信度答案再让大模型追认。未选中的 speculative head 不触发接管。
3. 页面变化使旧候选无效，必须重新观察；超限输入先裁剪/重建，不能把它原样交给大模型。
4. 若实际结果不符合目标，携带**新的可观察证据**（如网站解析出的地点与目标不同），让大模型提议下一步；需要重新填值时再显式调用 TextResolver。
5. 修正只允许目标范围内、已确认可安全继续的步骤。付款/提交结果未知等情况直接交回，不把“修正”用作重复提交的理由。
6. 每步至多一次审议、每轮最多三次审议/修正（初始内部预算）；审议失败、所选模型不可用或需要开放式规划，交回主 agent，不启动递归子 agent。
7. proposed 之后仍要重新观察结果；重复让 Jev 给一个 DONE 不是独立验证，有可确定性核验的页面事实时优先用代码。

主 agent 收到的交接摘要包括：原因、已确认执行的动作、结果未知的动作、当前观测/证据和剩余问题；不得包含 Jev key、未过滤 state 或所谓隐藏思维。取消/预算耗尽必须标记为终止，不提示系统自动继续。

### 7.3 `subagent.role`（未来）

未来可在 `resources/extensions/subagent/index.ts` 里，把“选哪个角色”变成 `decide("subagent.role", …)`。注入点现成——和 `questions` / `runSubagent` / `createWorktree` 同一个 `#extensionUi()`（`src/main/pi/process-manager.ts`）。

扩展 UI 上下文按会话存在，决策运行时全机共享；桥接只携带调用路由上下文，不把 conversationId 变成模型 state。

### 7.4 agent team 调度（现在不设计）

调度器是决策层的 consumer，不是决策层的一部分：它读取团队状态当 state，问一组 Choice 问题（下一个该谁动、是否并行、是否收敛），拿到答案后自己执行。只要守住 §4.1 的语义无状态约束，未来不需要重写协议。

---

## 8. 安全、远程与 i18n（硬规则）

1. **所有新 IPC 方法必须同时进两层分类。** 一是 `src/shared/remote-policy.ts`：`assertPolicyCoverage` 会在方法既不在 `DENIED` 也不在 `ALLOWED` 时拒绝启动服务器。二是 v0.10 新增的 `src/main/app-server/capabilities.ts`：`capabilityOf()` 按前缀映射能力，未识别的前缀会让 `assertCapabilityCoverage` 失败。`decision:*` 需新增一条映射，建议归入 `settings`（配置读写）；`decision:test` 会从本机发起网络请求，即使能力匹配也由 remote-policy 拒绝。新增 `handle()` 不等于自动可远程。
1a. **只在桌面 Main 内运行的会话提供 `browser_task`。** Headless App Server 的能力集不含 `browser`（`HEADLESS_CAPABILITIES`），SSH 远程 Agent 也没有 `__fastvibeBrowserRequest` 桥；这两类会话不注册该工具，也不显示“Browser use 优化”为已生效。
2. **决策配置管理只允许本机。** `decision:save-config`、`decision:set-key`、`decision:test` v1 均拒绝远程调用；远程 renderer 不显示可提交的设置表单，只显示“决策引擎只能在本机管理”。
3. **决策 key 不从 Main 读回或广播到 renderer。** 用户录入时 renderer 暂时持有输入值，提交后清空；不进入 localStorage、日志、模型 state、trace 或设置快照。
4. **v1 不接受任意 endpoint。** Jev adapter 固定 endpoint；未来自建 endpoint 需要 HTTPS、固定 allowlist、禁止未经确认的重定向、禁止从 renderer 传入 headers/代理/credential 名称，并由 Main 发起请求。
5. **state 出网 = 数据出境，必须显式告知。** browser state 是用户正在看的网页正文与控件值摘要；启用远端 Jev 前必须确认，且 password/file/hidden 永远不进入 state。
6. **决策引擎不授予权限。** v1 不开放 `permission.*` binding；权限由现有 sandbox 和用户审批控制，不能用“模型置信度高”替代。后续任何权限模型方案需单独设计。
7. **所有用户文案走 i18n。** 设置页、配置错误、交接/降级通知、远程拒绝和隐私告知分别进入 `settings` / `app` / `chat` locale；`binding`、backend id、模型 id 不是直接展示给用户的文案。
8. **交接不扩大权限或数据范围。** 大模型审议仍走同一过滤器、动作权限和取消链；网页内容、partialAnswers、供应商错误文案都是不可信数据，不能用作修改系统规则的指令。取消不得转换成 unreachable 后继续请求另一个模型。

---

## 9. 计量与使用统计

决策用量不能直接当普通 assistant turn 写进现有台账；现有台账按 session/entry 去重，须先扩展为向后兼容的可区分记录。建议新增 `kind: "decision"`，以 `runId + requestId + attempt + phase(decide/text/review)` 为唯一键，附 conversationId 作归属，主工具结果不得再重复记同一用量。`collectUsageStats` 扩展后才接入现有 `usage-ledger.jsonl`。

- 只存原始 token、backend/model、request 状态和 binding，不存价格；读时再定价；
- Jev 的 input token 单独作为“决策层”用量；output token 按 adapter 返回值记录；
- 大模型的 resolveText/reviewStep 分别标记 `decisionText` / `decisionReview` 来源，记录本次运行实际固定的 provider/model，避免与主对话消耗混算；
- cache hit 不产生 provider token，但 trace 仍记录一次命中；
- 失败请求、重试请求和 fallback 是否计费按实际 provider response 记录，不能只按成功动作统计；
- 没有模型调用的规则后端记录零 token；远程请求若缺 usage 或超时后是否计费未知，标记“未知”，不能显示为免费；
- 保留原始 provider/model 身份而不是只存可修改的 backend id。价格沿用读时当前价估算口径，Jev 使用有来源的独立价格配置；未收录价格标记未知，不伪装成真实账单。

---

## 10. 实施分期与验收

第一版产品范围明确为：**设置 → 决策引擎 + Jev 决策模型 + 可选 Browser use 优化**。subagent 和 team 只做协议预留。

| 切片 | 内容 | 新凭证 | 验收 |
| --- | --- | --- | --- |
| **前置** | 修复 §7.1.1 的 G1（快照泄漏密码值）、G2（旧 ref 残留） | 否 | 与决策层无关，独立 PR；快照与 candidates 中不出现 password 值；连续两次快照后旧 ref 不可解析 |
| **0** | 离线评测：不做 UI、不接主流程，用脚本验证 Jev 在我们的 state/questions 上是否值得做（见 §10.1） | 开发者自己的 Jev key | 产出评测报告与 go / no-go 结论；no-go 则本方案后续切片不启动 |
| **1** | `protocol.ts` + dispatch/validator + DecisionOutcome + `executor/runtime` + trace + 假后端 | 否 | 覆盖 reported/estimated/missing、预筛不请求、未选 head 不升级、cancelled/exhausted 不接管、必要答案校验及总预算 |
| **2** | 设置 → 决策引擎：大模型选择、Jev 选择、API key、Browser use 勾选、状态机、i18n、IPC/policy | Jev key | 大模型可选任意已配置模型；默认跟随主模型；key 只写 Main；测试连接不发送真实 state；多窗口收到脱敏变化；远程管理被拒 |
| **3** | browser consumer：Jev 决策、TextResolver、有限 reviewStep、freshness guard、视口文本、敏感字段过滤 | 使用已配置大模型 | 多步任务跑通；不执行低置信度答案；接管后仍验证引用和权限；修正携带真实证据且有界；服务故障可见；停止后无新请求 |
| **4** | 规则后端 / 普通 chat 后端 / 自建 System One adapter | 否 | 不改变 browser consumer；可用性、回退和计量语义一致 |
| **5** | `subagent.role` consumer | 否 | 角色选择有 trace 可查；未启用时现有 subagent 行为完全不变 |
| **6** | agent team 调度 consumer | 否 | 另立设计，不在本文件承诺具体协作策略 |

**实现状态（2026-09-23）**

- 前置 G1/G2：已修（`side-pane-browser.tsx`）。
- 切片 1：已完成，尚未接入任何产品路径：
  - `src/main/engine/decision/protocol.ts`：类型、canonicalize、问题与答案校验、confidence 归一化；
  - `dispatch.ts`：大小筛查与答案采纳策略；
  - `runtime.ts`：run 的预算与总 deadline、单次请求时限、重试、取消，以及 revokeAll；§4 设想的 executor 已并入这里；
  - `trace.ts`：JSONL 记录，只记 hash 和摘要，文件权限 0600，按条数修剪；
  - `backends/jev.ts`：线格式、错误映射、测试连接。本属切片 4 的范围，提前完成是因为切片 0 的评测脚本要用。
- 测试：`test/decision-{protocol,runtime,jev}.test.ts`，全部用假后端或假 fetch，不访问网络。

`pnpm test` 只测纯模块（无 DOM、不引 zustand/React）。browser 的注入脚本继续由 `pnpm check:scripts` 检查；浏览器语义测试需要本地 fixture，不能只靠 TypeScript。

### 10.1 切片 0：离线评测与止损标准

§11 的三个 UNVERIFIED 决定整个方案值不值得做，而切片 1–3 的工作量主要在设置页、权限和 browser 不变量上。先用最小代价回答“Jev 在我们的输入上选得准不准、快不快”，再决定是否投入。

**数据集**

- 录制：用现有 browser_* 工具让主模型完成一批任务，每步保存快照（经 G1 过滤）与主模型实际选择的动作；人工复核后作为标注。不录入登录态页面与个人数据。
- 规模建议：英文站点与中文站点各 ≥ 15 个任务、合计 ≥ 300 步；另加本地 fixture 页面覆盖 SELECT、分页、弹窗、同名按钮等难例。
- 每步离线重放：按 §7.1.2 构造 questions，只调用 Jev，不执行动作。

**指标**

- operation 准确率、target 准确率（按中/英、候选数分桶：≤20 / 21–80 / >80）；
- 按 confidence 阈值扫描：采纳率与“采纳后错误率”的曲线，确认存在一个阈值使错误率足够低时采纳率仍有意义；
- 延迟 p50 / p95（含网络）、输入 tokens / 步；
- 对照：同样输入下主模型用 enum/schema 约束一次性给出 operation + target 的准确率与延迟（§11 要求的公平基线）。

**建议止损线**（数值待评审确认，写进报告而不是代码）

| 条件 | 结论 |
| --- | --- |
| 英文：存在阈值使采纳率 ≥ 60% 且采纳后错误率 ≤ 2%；p95 延迟不高于基线的 1/2 | 继续切片 1–3，v1 先只宣称英文站点收益 |
| 中文单独达到上述标准 | 中文站点同样启用；否则设置页说明中文效果有限，或中文页面直接走现有路径 |
| 英文也达不到，或延迟优势在交接计入后消失 | no-go：保留本协议文档作为未来其他后端的设计，不接 Jev |

#### 10.1.1 试点结果（2026-09-23，jev-1.13.0，对照模型 fastvibe/deepseek-flash）

规模远小于上面建议的数据集：单步决策 33 个页面、端到端任务两组、每种配置只跑 1 次，因此只能指明方向，**不能作为 go / no-go 结论**。页面由无头 Electron 加载，快照使用产品的 `SNAPSHOT_BODY`，问题由 `browser-questions.ts` 构造。

**单步决策（33 个页面，英文 17、中文 16，对照模型同样只能在枚举选项中作答）**

| | Jev | deepseek-flash |
| --- | --- | --- |
| 步骤正确率 | 97%（32/33；英文 16/17，中文 16/16） | 91%（30/33） |
| 延迟 p50 / p95 | 328 / 675 ms | 2010 / 2364 ms |
| 平均输入 tokens | 5.6k | 4.0k |

置信度阈值扫描：阈值为 0.6 时采纳 79%，采纳部分的错误率 4%；阈值为 0.9 时采纳 64%，错误率仍为 5%。唯一的错误是 Hacker News 首页：目标是“打开最新提交列表”，Jev 回答 DONE，置信度 0.96。**高置信错误确实存在**，所以 §7.1 的“DONE 必须核验”和“一个动作都没做就 DONE 不可信”这类代码守卫不能省。

**端到端任务**（用 Google 搜索，对比 GPT-6 Sol 与 Claude Opus 5.5 的 benchmark、价格、上下文窗口、发布时间，输出带来源的表格）

| 配置 | 墙钟 | 主模型调用 / 输入 tokens | Jev 调用 / 输入 tokens | 小任务 LLM 调用 | 浏览器动作 |
| --- | --- | --- | --- | --- | --- |
| A 主模型直接驱动，可直接打开网址 | 125 s | 24 / 821k | — | — | 12 |
| B 同上加 browser_task | 149 s | 21 / 670k | 3 / 6.6k | 1 | 14 |
| A' 只能打开 Google 首页，其余靠点击 | 62 s | 19 / 372k | — | — | 10 |
| B' 同 A'，页面内交互交给 browser_task | 144 s | 27 / 1118k | 32 / 129k | 13（生成文本 4、审议 9） | 25 |

观察：

1. 调研类任务的时间主要花在主模型阅读快照上（主模型累计 47–94 s）。Jev 每步只有约 0.5 s，但把页面内交互委派出去之后，主模型的轮次反而变多了（每次委派后还要 snapshot），**端到端没有变快**。
2. B' 中，“搜索”和“点击指定结果”两类子任务全部由 Jev 正确完成（20 步）。“滚动到某一节”三次失败：原型没有 SCROLL 动作（G7），Jev 每次都不确定，审议模型三次点击同一个目录锚点，直到审议次数用完。**需要 SCROLL，也需要循环检测**（同一动作加同一目标重复即交回）。
3. 四份报告的核心数据一致（$2/$10 对 $4/$20，1.05M 对 1M，同为 2026-09-22 发布），并且都识别出 Anthropic 对比表里列的是 GPT-5.6 Sol 而不是 GPT-6 Sol。B' 从官方文档页取数更多；A' 更多依赖搜索摘要和第三方汇总。
4. Jev 的成本可以忽略：B' 全程 129k 输入 tokens，约 $0.005。

初步判断：Jev 在“下一步点哪里”上又快又准，中文页面表现良好；但 browser_task 的收益取决于任务形态。多步表单、站内导航这类交互密集型任务更可能受益，而“读多个页面再汇总”的调研任务瓶颈在主模型阅读。切片 0 的正式评测应把这两类任务分开统计，并先补上 SCROLL 与循环检测。

评测脚本放 `scripts/`，不进入产品包；key 从开发者环境变量读取，不写入仓库、不复用产品的 `.env`。

---

## 11. 未验证 / 待补

- **`UNVERIFIED`：Jev 在中文页面上的实际质量。** 官方文档写明英语是主要训练语言，CJK 准确率不等同；必须在真实中文站点和英文站点分别测。
- **`UNVERIFIED`：Jev + 现有大模型的 browser 端到端收益。** 比较主模型直接 browser use、Jev + 大模型生成/有限接管两条路径，真实计入交接、重试、修正和失败成本。基线使用合法 enum/schema 约束与合理推理设置，不能用未优化的长输出基线夸大收益。
- **`UNVERIFIED`：置信度采纳策略。** 按中英文、模型版本、候选数量和 confidence 来源分组测准确率/误操作率/交接率，记录从未被选中的选项。不能因交接率高就直接降低阈值，也不能把 reported 信号当授权。
- **Jev 版本策略。** v1 可以默认 `jev-latest`（2026-09-23 指向 `jev-1.13.0`，`jev-preview` 同），但 trace 必须记录响应里的 versioned model；切片 0 的评测结论绑定具体版本，别名漂移后需重跑评测，稳定用户需要后续支持 pin 版本。
- **已核实（2026-09-23，官方文档）：** 请求上限 64k tokens（state + 最长问题 ≤ 32k）；choice ≤ 255 候选；score 2–10 级；noul 无 confidence；错误码 401 / 422 / 429 / 529；输入 $0.042 / 百万 tokens，输出免费。实现时仍需重新核对。
- **ask 模式下 browser_task 的确认粒度**（§7.1.3）需要产品决定。
- **Jev 的动态速率限制与错误体验。** 429、超时、额度不足、key 失效需要分别映射为用户能理解的状态，而不是统一显示“决策失败”。
- **自建 endpoint 的产品入口。** 协议先保留，v1 不暴露任意 URL；未来是否提供自建服务参考实现另立设计。
- **trace 展示形态。** v1 先落盘和显示摘要；完整 inspector 需要另做隐私、清理和筛选设计。
- **验收测试补充。** 除协议单测外，覆盖两个会话主模型不同、主会话中途换模型、关闭场景/清除 key、取消审批、Jev 请求被取消、动作结果未知不重试、重定向不带 key、trace 不含填充值。UI 用本地 fixture 验证设置状态、zh/en 切换及配置跨窗口同步。

---

## 12. 审阅修订与参考依据

本次是设计审阅与文档修订，不代表功能已经实现；没有调用付费 Jev API 或证明端到端性能。

- 修正“纯函数”和网络重试/trace/预算相矛盾的问题：纯校验与有运行元数据的服务分开。
- 删除隐式 `resolve: text`，改为明确的大模型文本能力，避免投机 head 导致无用生成。
- 区分决策语义与会话/权限/取消路由，不再禁止携带 conversationId。
- 按新需求收敛产品：大模型默认跟随发起会话的主模型，决策模型 v1 为 Jev + API key，场景 v1 只有 Browser use。
- 修正将“用户自己的供应商”等同本地计算的表述；大模型和 Jev 都可能把数据发往远端。
- 补齐取消、权限、mutation 结果不明、回退不重放、配置迁移与用量去重边界。
- 未来规则/chat/自建后端是扩展方向，不是 v1 必做入口；不承诺仅靠协议获得 Jev 同等性能。

### 12.1 jev-use 补充调研（358819d）

本轮借鉴的是协作边界，不是把整个 npm 包作为宿主运行时：

- `protocol.ts` / `dispatch.ts`：调用前筛查、类型化 handoff、reported/estimated 区分；补入 §3.1、§3.5–3.6。
- `judge.ts`：答案与是否值得执行分离。我们仍保留更严格的响应校验、按已选依赖筛查和端到端取消，不照搬整批 verdict 的 escalated 聚合。
- `bench/examples/collab.mjs`：结果不符时携带地理编码证据回交大模型；其选择器/流程是站点专用示例，不证明通用 browser runner 的可靠性。
- `src/backends/`：Jev 可通过不同网关协议接入，confidence 和 usage 的位置各异；v1 仍只配置 TypeSafe 直连，渠道扩展以后再做。
- 不照搬权限 hook：其故障时让位给宿主权限流程，不能充当 FastVibe 的最终安全闸。也不照搬缺失外部 AbortSignal、较宽松响应转换与简易 token 估算。
- `bench/RESULTS.md` 的性能是作者单一环境报告，非 FastVibe 验证。公平配置下的延迟优势约 3 倍而非演示直观的十几倍；报告也披露有示例在 escalate 后仍使用答案，真实有限交接必须计入额外时间/费用。阈值和速度都不能直接移植。

本次补充不增加 v1 场景或用户配置项；只扩充两个已配置模型如何合作的契约，以及相应 trace/计量/验收。

### 12.2 v0.10.2 代码复核与线格式核对（2026-09-23）

- 对照 `side-pane-browser.tsx`、`browser-bridge.ts`、`permission-sandbox.ts` 列出 §7.1 不变量的实现差距（§7.1.1），发现两处与决策层无关的现有缺陷（快照泄漏密码值、旧 ref 残留），前移为独立修复。
- 纠正“复用现有 browser 权限判定”：browser_* 目前没有专门分类；补 §7.1.3 宿主侧动作权限，并把 ask 模式确认粒度列为待决策。
- 补 §7.1.2 操作集合到实际动作的映射、target 问题的 `NONE` 候选、候选描述规则，以及 §7.1.4 `browser_task` 结果契约。
- 按 TypeSafe API 参考补 §3.7 线格式、上限、错误码与成本量级；修正 Jev confidence 的性质（分布形状统计量，noul 无 confidence）和重试码（加入 529）。
- 补 v0.10 引入的 App Server 能力分类（`capabilities.ts`）与 SSH/headless 会话不提供 browser_task 的规则。
- 新增切片 0 离线评测与止损标准，先验证价值再投入设置页和 browser consumer。

参考（源码/公开文档静态调研）：

- [jev-ultrafast 源码](https://github.com/browser-use/jev-ultrafast)：`agent.py`、`model.py`、`browser.py`、`snapshot.js`。
- [jev-use@358819d](https://github.com/shitianfang/jev-use/tree/358819d)：`src/protocol.ts`、`src/dispatch.ts`、`src/judge.ts`、`src/backends/`。
- [jev-use 性能与反例](https://github.com/shitianfang/jev-use/blob/358819d/bench/RESULTS.md)：包含基线配置、交接率、置信度来源和性能证据边界。
- [TypeSafe Quick start](https://docs.typesafe.ai/introduction/quickstart)：systemone 请求格式和认证。
- [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents)：不是对话模型的直接替代品。
- [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)：同一状态下的独立问题。
- [Models](https://docs.typesafe.ai/models)：版本、价格、语言能力及速率限制；实现时需重新核实。
- 本仓库：`src/main/pi/browser-bridge.ts`、`src/main/pi/process-manager.ts`（`#extensionUi` / `#runSubagent`）、`src/main/engine/providers.ts`、`src/shared/api.ts`、`src/shared/remote-policy.ts`。
