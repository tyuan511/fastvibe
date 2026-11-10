# 供应商、模型与旁路请求

涉及供应商协议、OAuth、模型热更新、思考档位、轻量请求、回复推荐或 models.dev 时阅读。

关联入口：[Pi 引擎模式](../pi-engine-modes.md)、[扩展与 MCP](extensions.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## Providers

供应商列表与其他设置共用 `SettingsGroup` 外框，各供应商作为无间距的折叠行，内部使用细分隔线。供应商名称右侧的重命名图标在 hover / 键盘聚焦时显示，点击后直接原位编辑左侧名称，Enter / 失焦保存、Escape 取消；删除和启用开关位于标题栏右侧，收起时也能操作。整行标题栏可展开或收起，编辑控件独立于展开与拖动触发区。余额作为展开区内独立的一项，承接金额刷新、上游识别和面板凭据配置，不在标题栏重复显示。

供应商标题行和模型行直接拖动排序，不展示拖动手柄；hover 显示抓手光标，轻点仍展开或编辑，操作按钮不启动拖动。触屏长按 250ms 才激活，键盘用 Alt + ↑ / ↓ 移动。供应商顺序通过 `providers:reorder` 保存到原供应商数组；排序只提交 ID，遗漏的新供应商保留在末尾，桌面和 SSH 共用同一调用。

已保存的模型可点供应商详情中模型行右侧的小图标自检，结果通过图标状态和轻提示显示。`providers:test` 仅接受供应商与模型 id，通过当前 `ModelRegistry.streamSimple` 的协议和鉴权发两个有界小请求：普通回复和一个不执行的测试工具。结果只包含状态、首字耗时和错误分类，不把提供方原始响应或凭据传给渲染层。桌面与 SSH Agent 注册同一调用。

There is **no built-in provider**: the app ships with none, and there is no connect wall
and no separate 「not configured」 engine state. An install with no provider boots an
ordinary engine whose model list is empty, and that empty list is the whole signal. The
composer reads it — it goes read-only and its placeholder asks for a model — and the model
chip's popover says 暂无模型 above the 管理模型 entry that leads to Settings → 供应商, where
the user adds an SDK provider or any compatible endpoint of their own. The FastVibe relay
(`fastvibe.dev`, a Sub2API deployment) is just one such endpoint; it used to be a
code-owned built-in entry and is not any more. The FastVibe *account* ([账号登录](remote-access.md)) is a
separate thing and does not configure a provider.

A provider ships **no models** until the user connects it: configuring a provider
fetches its `/models` list and the user picks which to keep. A provider without either an API key or an OAuth credential is excluded from `models.json` entirely, so no models surface anywhere.

**A custom provider's protocol is the user's choice** — both on the provider (API 格式, which
sets the default for all its models) and per model (协议, in 模型详情). A model with no `api` of its own
inherits its provider's (that is what `models.json` omits), which is why a gateway can
serve a `/responses` model next to a `/chat/completions` one without being split into
two providers. `compat` is therefore emitted per model, derived from the api that
model will actually stream with.

**A model id that names a native API pins its own protocol** (`automaticModelApi`,
`model-api.ts`): `claude-*` → `anthropic-messages`, `gemini-*` → `google-generative-ai`,
both case-insensitive and only when the provider does not already speak that protocol — so
the stored model keeps inheriting and the roster draws no pinned chip. It fires at one
moment only, in `enrichOne` while a provider's `/models` list is read, which means an
already-added model changes nothing until 同步模型, and a model the user tuned is marked
`edited`, which `savePicker` treats as authoritative — an absent `api` there means "the user
chose to inherit", so a freshly inferred protocol must not walk over it. The prefix is the
whole rule because the roster
carries nothing else; it is a guess, and 模型详情 › 协议 is the one-click undo for a relay
that forwards the model behind its OpenAI endpoint instead. Namespaced ids
(`anthropic/claude-…`, `models/gemini-…`) deliberately do not match — Google's own listing
strips `models/` before this runs.

`authHeader` is a *provider* field in pi's schema, so a Gemini model pinned under an
OpenAI-shaped provider still sends `Authorization: Bearer` next to the Google client's
`x-goog-api-key`. That is the direction that works on a native-protocol relay (which is why
`fetchGeminiModels` sends both), and Google's real endpoint never lands in that position — a
base that lists models natively is configured as a Google provider, so its models inherit the
protocol rather than being overridden here.

**A model's base URL is translated for the protocol it streams with** (`engineModelBaseUrl`,
`provider-url.ts`), because the four clients address their endpoint from one stored base very
differently. pi's OpenAI clients append `/chat/completions` / `/responses` *below* the
version prefix, so `https://host/v1` is what they want and the base is taken as typed. The
Anthropic Messages client appends `/v1/messages` **itself**, so the same base reaches
`/v1/v1/messages` and 404s. pi's Google client goes the other way — `apiVersion: ""`, so the
base must carry the version, and Google's is `v1beta`, not `v1`.

That is invisible while a provider serves one protocol (the user types whichever base its
protocol wants) and breaks the moment one relay carries several, which is the case the
per-model `api` exists for. So a model streaming `anthropic-messages` is written its own
`baseUrl` with the version segment removed, and one streaming `google-generative-ai` with
`v1` → `v1beta`; the provider keeps the base the user typed for every other model, and pi
reads a model-level `baseUrl` over the provider's. `fetchProviderModels` derives the same
way, so listing a Gemini provider's models does not 404 either. **The base is not a
protocol-neutral root with the version derived**: `/v1` and `/v1beta` are the only segments
our own UI ever hands a user, and a relay may mount a protocol under a path of its own —
z.ai's `.../coding/paas/v4` is the endpoint path, so it is never rewritten, and an OpenAI
api's base is never rewritten either way.

`providers.json` carries a `version` (`PROVIDERS_VERSION`). **v3 removed the built-in
FastVibe provider.** A `kind: "builtin"` entry from an older file is read as a custom provider
in place (`migrateBuiltin`): the id stays `fastvibe` and the key stays in
`FASTVIBE_API_KEY`, so the pasted key and every conversation that recorded
`fastvibe/<model>` keep working, and it can now be renamed, re-pointed and deleted like any
other. A v1 entry's `api` was the code's default rather than a choice, so it is read as
`openai-responses`; an entry with no models was never connected and is dropped instead of
left as an empty row. Nothing is written until the next ordinary provider edit.

**The 决策引擎 (Jev) is gone, and so is the `systemone` API format it existed for.** It was a
second model that decided each browser/desktop click and the `batch_decide` tool; removing it
took `src/main/engine/decision/`, the `browser_task` / `computer_task` / `batch_decide` tools,
the 设置 → 决策引擎 pane, the `decision:*` methods and `decision.json` with it. Browser and
computer use are the atomic `browser_*` / `computer_*` tools the main model steps through —
nothing else. A `providers.json` written by those builds can still hold a provider whose own
protocol was `systemone`: `readProviders` **drops that entry** rather than repairing it, because
hydrating it would silently turn a decision endpoint into an OpenAI-shaped chat provider whose
models fail on every request (the same reason `chatProvider` used to keep those models out of
`models.json`). Its key stays in `agent/.env`, unreferenced and inert.

**A built-in can also be configured by a subscription login (OAuth).** Claude
Pro/Max and ChatGPT Plus/Pro are the two people actually want, but nothing names
them: a provider's capability is read off the SDK, where `auth.apiKey.login` says a
pasted key is a real path and `auth.oauth` says a login ships with it
(`native-providers.ts`). Only `amazon-bedrock` / `google-vertex` stay hardcoded as
unsupported — their credentials are ambient cloud ones. That is why `openai-codex`
(login only, `supportsKey: false`) is offered at all, and why an SDK release that adds
a login reaches the UI with no change here.

- **Credential persistence and runtime injection.** API key 会落盘：隔离模式下，设置中保存的 key 写入 `runtime/engine/agent/.env`（0600），启动与热更新时通过 `setRuntimeApiKey()` 注入 SDK 的 runtime 内存覆盖层；全局模式写入所选 pi 配置目录的 `auth.json`。OAuth 凭据按模式保存在隔离目录的 `oauth.json`（0600、临时文件后 rename）或全局目录的 `auth.json`，以便刷新令牌跨重启保留。`ModelRuntime.create` 使用相应凭据存储，runtime key 覆盖层优先于底层同供应商凭据；内存注入不代表密钥从不落盘。全局配置迁入隔离模式还可能把 API key / 表达式导入 `oauth.json`，不能把该文件概括为只含 OAuth。路径选择见 [Pi 引擎模式](../pi-engine-modes.md)。
- **That is why a successful login drops the provider's API key.** Leaving one behind
would silently keep billing the key and make the subscription the user just
authorised do nothing. The provider detail says the same thing in words when both
credentials exist.
- **Connected means either credential.** `connectedProviderIds` is what
`applyProviders` (which models the composer sees) and `usableProviders` (which
providers `reloadProviders` keeps in the overlay) both filter on; a provider with
neither contributes no models anywhere, which is the whole «not connected» signal.
Signing out therefore removes the models without removing the entry, exactly like
clearing a key.
- **The flow is pi-ai's; the GUI only carries it.** It owns the PKCE pair, the loopback
callback server and the device-code polling, and asks for a human through `notify`
(one-way: `auth_url` / `device_code` / `info` / `progress`) and `prompt` (a round trip).
Both ride `providers:oauth-event`, with the answer coming back through
`providers:oauth-answer`; `Main` opens the `auth_url` / verification URI with
`shell.openExternal` and the dialog shows it too, because a browser that will not come
up has to stay recoverable by hand. **A prompt can be withdrawn while it is on
screen** — an Anthropic login opens the browser *and* offers a paste box, and aborts
the box the moment the callback arrives — so the flow's own `prompt.signal` and a
user cancel both emit `prompt_cancelled` and the dialog takes the question back down
(`oauth-login-dialog.tsx`). A login that fails *after* its credential landed (the
runtime's own synchronisation pass can throw) still counts as signed in: re-authorising
for nothing is worse than a missing confirmation.
- **`supportsKey: false` hides the key field**, in both 添加供应商 and the provider
detail; the login is the only way in. A built-in added this way is created with an
empty key, which `addNativeProvider` accepts only while a token is actually stored.
- **A subscription login is not always the plan's included usage, and the GUI says
so.** A Claude Pro/Max login used by a third-party harness is charged per token
against the account's «extra usage» balance, and refused outright — `third-party apps
not draw from your extra usage` — while that balance is not enabled. pi's own CLI
warns about this; the GUI did not, so the refusal was the first the user heard of it,
after the provider was connected and a prompt already sent. `NativeProviderOAuth`
carries an optional `extraUsage.url` for such a login, set from `EXTRA_USAGE_LOGINS`
in `native-providers.ts` (Anthropic is the one that works this way — it is a billing
fact, not an SDK capability) and drawn by `oauth-extra-usage-note.tsx` under the
订阅登录 row in the provider detail and in the login dialog's success state.

**Editing a provider never restarts the engine.** `PiProcessManager.reloadProviders()`
mutates the live `AuthStorage` (set/remove keys), rewrites `models.json`, then calls
`ModelRegistry.refresh()` on the *same* instance every session already holds, and
re-points each idle session at the refreshed `Model` object (`agent.state.model`,
quietly — a settings edit is not a user model switch and must not append a
`model_change` entry). A run that is still streaming keeps the config it started
under and is rebound on `agent_end`. Only a cold engine (no runtime/registry yet —
the first provider, or `start()` after a crash) takes
the `start()` path. Do not reintroduce `stop()` + `start()` here: it disposed every
AgentSession, so a change in Settings → 供应商 aborted the reply in flight.

设置 → 模型与默认的供应商标题右侧提供「刷新模型列表」。其他程序改动配置后，用户可手动重新读取当前模式的配置并调用 `reloadProviders()`，随后更新设置页供应商行和聊天模型菜单；不启用文件监听。隔离模式读取 `providers.json` 与对应凭据并重新生成 `models.json`，全局模式直接重读 pi 的 `models.json` / `auth.json`。该操作不向供应商拉取 `/models`；单个供应商的「同步模型」仍负责上游模型发现。

**Model parameters have a single source: the bundled models.dev snapshot.** There is
no hand-maintained catalog — context window, max output, input modalities, reasoning
efforts and list prices all come from models.dev (`loadModelsDev()` →
`enrichModel()`). Unknown ids keep conservative defaults (128K / 8K / text-only)
rather than being rejected. The provider's model list is a compact roster (name, a chip
if the protocol is pinned, the context size); clicking a row opens 模型详情, which
shows those parameters and lets the user tune name, protocol, context, max output,
推理 / 输入模态 and **思考强度**. A tuned model is marked `edited` so 同步模型
refreshes its metadata without reverting the edits.

**Thinking levels are the engine's, not models.dev's.** `THINKING_LEVELS`
(`@shared/types`) mirrors pi-ai's set:
`off | minimal | low | medium | high | xhigh | max`. models.dev's effort values map
onto it one-to-one (`models-dev.ts`), recording the provider value in `effortMap`
(pi's `thinkingLevelMap`) wherever the names differ.
**`off` is never offered.** The engine's set contains it, but asking an upstream to
*disable* thinking is rejected by models that reason by default, so no menu in the app
offers it (`THINKING_EFFORT_LEVELS` is what gets stored, tuned and listed) and
`settings.thinkingLevel: "off"` from an older build is dropped on load — 跟随模型默认
is the "leave the parameter alone" choice. `THINKING_LABELS.off` stays so the composer
can still name a session the engine reports as off (a non-reasoning model, a restored
transcript).
`renderModelsJson` then writes a `thinkingLevelMap` for any model the user tuned:
unchecked levels become `null` (the engine clamps instead of sending a rejected
parameter), `xhigh` and `max` always carry a mapping because pi only offers either
when mapped, and unchecking 推理 clears the list and writes `reasoning: false`.

**The model and thinking chips work on the empty hero too.** There is no conversation
for the engine to bind the choice to until the first prompt, so `setModel` /
`setThinkingLevel` hold it on the manager (`#pendingModel` / `#pendingThinking`) and
return a draft `EngineSessionState` — `getState()` reports the same instead of failing
with 「no active conversation」, and `#applyPreferredModel` adopts the pick into the next
session created (before the pinned 「默认模型」, which it still falls back to). A pick made
while no conversation exists is dropped as soon as one is activated. Nothing may throw
before that branch is reached: `#activeSession()`'s `#ensureReady()` used to reject with
「尚未配置模型供应商」 on an unconfigured engine, which made the chips unusable in exactly
the first-run state they exist for.

**Nothing on the first-run path is an error.** A fresh install has no conversation and
possibly no provider, and that is a state the composer has to work *in* rather than
fail in. There is no status for it: the engine boots normally and the model list being
empty *is* the signal. `App.tsx` holds the composer read-only on that condition
(`canChat` needs a model) with a placeholder asking for one, hides the suggestion chips
that would only fill a box that cannot be sent, and the model chip reads 「添加模型」
with a popover saying 暂无模型 above 管理模型 → 设置 → 供应商. `handleSubmit`'s refusal
(a send with no model keeps the draft and raises the 「还没有配置模型」 alert) stays as
the safety net behind the disabled input — a queued prompt can still drain into it if
the last provider is removed mid-run. Once a provider is connected a send needs no extra
step: the new session resolves its own model (`findInitialModel`), and every
session-scoped choice that could be made before a conversation existed (the
model/thinking chips, 自动压缩 read in `#createSession`) is adopted by the session that
appears.

**A conversation can exist before a model does.** The SDK substitutes a placeholder
model (`provider: "unknown"`, from pi-agent-core's `DEFAULT_MODEL`) on a session that
has none, so a chat created on a fresh install is a real session with no model rather
than a refusal: `#state` reports that placeholder as *no* model (otherwise 「unknown」
would land on the composer's chip), and `#rebindModel` treats it as the 「model is gone」
case, which is how such a conversation adopts the provider the user connects
afterwards.

**A switch is drawn in the transcript as a divider only where the new model actually
runs** — a quiet rule reading 「模型已切换至 provider/model」, naming the model the reply
came from rather than the pair it moved between. Picking a model is not using one: the
SDK writes a `model_change` entry the instant the pick is made, so drawing from the
entry alone put a divider on the screen for a switch that no reply had run on yet (or
one reverted before the next prompt). The divider is therefore tied to the reply:

- It is a **`{ kind: "model" }` MessagePart, not a row**. Consecutive engine messages
  of one reply are merged into a single row, so a switch made while a reply was
  streaming belongs *between that reply's parts* — a row of its own would split the
  merged run into two blocks (and two footers).
- `#announceModelUse` (`src/main/pi/process-manager.ts`) emits `model_changed` when the
  provider request is sent (`#armModelNotice` wraps `onPayload`, which runs after virtual
  routing and before the HTTP call), not from the assistant `message_start`. That event is
  the response starting, and a reasoning model can sit silent for a minute after the
  request has already gone out — the divider has to be on screen for that wait. The model
  is compared with the last assistant message already in the transcript, and the part is
  spliced at the part index the engine's current message began at — `apply-engine-event.ts`
  tracks it as `partBoundary` (`stores/session.ts`). Picking A, then B, then A again before
  sending announces nothing, and `#useModel` itself no longer emits anything (nor does the
  renderer re-read the transcript after a pick).
- `#insertModelSwitches` derives the dividers from the **replies**, not from the
  `model_change` entries: it walks `sessionManager.getBranch()` and inserts one at the
  start of every assistant message whose `provider`/`model` differs from the previous
  assistant message's — the same slot the live event uses, so a reload and the stream
  agree. The entry alone cannot say this: it is anchored to the last completed message,
  which during a run sits *before* the reply still streaming, so a switch made mid-run
  would appear one round-trip early. A pick that no reply followed draws nothing, and
  so does `A→B→A` before sending — no reply ever ran on B. Re-picking the model already
  selected returns early, and a provider edit's forced fallback model goes through the
  same path (it *is* a switch the user did not ask for, announced when the next reply
  runs on it).
- A leading divider stays **outside** 折叠运行过程's fold (`foldHead` in
  `components/chat/message-list.tsx`): which model answered is not process, and hiding
  it inside 「用时 …」 buries the one fact the divider exists to state. A divider spliced
  mid-run does still fold with the rest of the run it sits in.

Only `models.json` is written; the `models.yml` / `config.yml` pair from the old RPC
engine is gone because the SDK never read them.

## 轻量模型（`engine/light-model.ts`，设置 → 模型与默认）

一个 `settings.lightModel`（provider + id），管四类轻量请求：会话标题（`session-title` 扩展）、AI 提交信息
（`generateCommitMessage`）、回复推荐（`#suggestNext`）、长期记忆（`#backgroundModel` 的阶段 1 与整合 agent）。
**默认留空 = 跟随会话模型**，也就是这个设置存在之前的行为；新装的用户一个额外请求都不会多发，也不会因为
「要选一个」而被卡在首次运行路上。

- **一条规则，四个调用点**：`lightModelFor(registry, readLightModel(paths), session.model)`。选不中就不换——
  pin 的供应商被删了、模型被 同步模型 撤了、这个安装没有那家的 key（`hasConfiguredAuth` 说不行），一律退回原来那个模型。
  旁路不值得抛错：代价是一轮没有标题，而报错的代价是整个界面卡住。坏掉的 pin 由 设置 → 模型与默认 那行显示成
  「（已不可用）」，让人自己看得见、改得掉，而不是在日志里找。
- **`#lightModel` 只挑模型，不判可用性**：调用方照旧自己校验（提交信息仍然抛「还没有可用的模型」，回复推荐仍然静默返回）。
  新增一个轻量调用点时这一步不能省，否则「没有可用模型」这件事会换个地方炸。
- **记忆是唯一没有「会话模型」可跟的**：`#backgroundModel` 的顺序是 记忆自己的 pin → 轻量模型 → 默认模型 →
  当前活动对话的模型 → 第一个能鉴权的模型。`memory.modelDefault` 那行文案因此从「跟随默认模型」改成「跟随轻量模型」。
- **标题在扩展里，而扩展是散文件、不能 import `@shared`**：Main 把 pin 挂在 `ctx.ui.lightModel()`
  （`#extensionUi`，每次调用现读 settings，所以改完不用重载会话），扩展自己 `ctx.modelRegistry.find` +
  `hasConfiguredAuth`。宿主不是 FastVibe（pi CLI、测试 harness）时这座桥不存在，`lightModel?.()` 直接退回 `ctx.model`。
- **一个形状**：那行的选择框是 `DefaultModelSelect`，触发器与菜单和 `ModelThinkingSelect` 的设置态共用
  `SETTINGS_MODEL_TRIGGER`（`model-thinking-select.tsx`）+ `DropdownMenuCheckboxItem`。同一组里挨着的两行
  长得不一样，读起来就是两个功能而不是两个选择。这个常量的形状是**量出来的**：`h-8`（2rem，和 shadcn
  `SelectTrigger`、默认 `Button` 以及同一张卡片里的「管理」按钮同高——早先的 `min-h-9 py-2` 是为了让换行的
  标签长高，而标签是 `truncate` 的，它只让行尾比正文高）、`w-fit` + `sm:max-w-64`（钉死宽度要么截断
  provider/model id，要么让行尾参差不齐）。子 Agent 与按项目默认模型那两处 `surface="settings"` 一起跟着变。

- **故意不动的东西**：压缩摘要、`/handoff`、子 agent 与 DAG 任务仍用对话自己的模型——前者要整段上下文才编得出来，
  后两者是用户明确交出去的活，不是「顺手帮个忙」。想扩进来先想清楚这条界线。
- 验证：`test/light-model.test.ts` 钉住退回规则与 `readLightModel` 对半写坏值的处理；`test/session-title.test.ts`
  用真 SDK 跑「pin 生效」与「pin 解析不到时退回」，并钉住**对话本身仍留在原模型上**（旁路搬家不能把用户的会话一起搬走）。

## 回复推荐（`engine/reply-suggestion.ts`，`PiProcessManager.#suggestNext`）

一轮回复结束后，用轻量模型（未设置时就是该对话自己的模型）猜用户下一句，画成 composer 的 placeholder，输入框为空时按 Tab 填入。
设置 → 偏好设置 → 对话 → 回复推荐（`settings.replySuggestions`，默认开；Main 只在 `=== false` 时关）。

- **只在「正常收尾的文字回复」后生成**：`agent_settled` 且结论不是 error/stopped/handoff，不是辅助对话、不是定时任务，
  且最后一条是 `stopReason: "stop"` 的助手文字（`suggestionMaterial`）。停在工具调用、失败、被截断都不猜。
  只给模型最后一轮的用户消息和回复的**尾部**（回复被截去前面，因为下一句是接着结尾说的）。
- **用哪个模型**：`#suggestNext` 走 `#lightModel(session.model)`，即 设置 → 模型与默认 里的「轻量模型」（见
  ## 轻量模型），没 pin 就是该对话自己的模型。**`FASTVIBE_SUGGEST_MODE=cache` 例外，永远用对话自己的模型**：
  那条请求赌的是前缀缓存，换一个模型等于把缓存丢掉重来。延迟仍然取决于所选路线是否让模型思考，而不是模型大小
  （同一个 deepseek，FastVibe 中转站 0/12 思考、custom-qwen 12/12 思考），所以这个设置省的是钱和噪音，不是必然的秒数。
  早先试过「标题、提交信息、回复推荐各自选一个」（`settings.smallModel`，已随 `d9ac5d8` 移除），三个下拉只让用户多点两次，
  现在是一个共享的 pin。
- **旁路，不能影响运行**：fire-and-forget，15s 超时，异常全吞（composer 照常显示原 placeholder）。
- **从那条回复结束的那一刻开始，不等整轮 settle**（`message_end` 且 `stopReason: "stop"`，仅 `fresh` 模式）：settle 可能还要等压缩或重试。
  起得早意味着此时运行还开着，所以结果照常发布，由 composer 的「没在运行」条件在 settle 前不画它；运行继续（续跑、排队消息）则
  `agent_start` 收回。`agent_settled` 时：已经早起过就不再问一遍（`#suggestionEarly`，哪怕那次什么都没得到），没起过才起，
  被用户停止或失败的运行则收回。`message_end` 先于 `session.messages` 一定含有这条消息，所以材料用 `withFinalMessage` 补上它。
- **流式、一行就停**（`readSuggestionStream`）：建议是一行，第一行写完（后面跟了换行）就取消请求，不为后面的解释付费。实测一行回复
  模型自己就结束，所以这一步主要防的是话多的模型，延迟 ≈ 首 token + 几百毫秒（FastVibe 中转站首 token 1.4–1.8s，Qwen 0.5–1.2s）。
- **输出上限：不推理的模型和不发 thinking 的 Anthropic 给 80，其余一律 1024**（`suggestionMaxTokens`）。`maxTokens` 只是天花板，
  短答案在 80 和 1024 下一样快，小上限唯一的效果是在模型先思考时把回复截成空。曾经给过「带关思考字段就 80、落空再用 1024 重问」，
  实测反而更慢（8s：失败的一次加重问）：**FastVibe 中转站上的 deepseek 时而思考时而不思考，加不加关思考字段都一样**
  （同一份真实对话，一轮探测带字段 3/3 思考，隔几分钟全部变体 0 思考，含不带字段的）。Qwen 的 `enable_thinking:false` 则每次都有效。
- **输出要像一条消息**：`cleanSuggestion` 取第一行、剥引号/项目符号/「Next message:」标签，`NONE` 或超过 120 字符
  都当作没有（超长说明模型在回答而不是在猜）。规则在 `test/reply-suggestion.test.ts`。
- **两条通路到界面**：活动会话走 `reply_suggestion` 事件（`text: null` = 撤回）；`EngineSessionState.suggestion`
  让之后打开的会话/窗口也能读到。渲染层 `suggestions[conversationId]` 只从 state **采纳**、从不被 state 清除——
  一次与生成赛跑的状态读取不该抹掉刚到的推荐，撤回只认事件。后台会话不推窗口，只推观察者（手机）。
- **composer 里**：`suggested` 要求输入为空、无附件、没在运行、没被锁；Tab（无修饰键、没在输入法组合中）写入并把光标
  放到末尾，`Kbd` 画在 placeholder 的**最前面**（输入框左侧，文字让出 `pl-14`），它只是提示不是按钮（触屏没有 Tab，手机的推荐入口另说）。斜杠/@ 面板打开时输入非空，所以不会抢 Tab。
- **慢在哪，以及现在怎么办（真实供应商实测，2026-10-19，~11K token 的对话）**：延迟几乎全是模型的思考时间，不是网络，也不是缺缓存。
  思考开着，FastVibe 中转站上的 deepseek 新请求 4.7–6.0s，主模型（Qwen）新请求 6–27s、带缓存前缀 3.0–4.3s（命中 11264/11772）。
  **关掉思考才是量级变化**：FastVibe 中转站的 deepseek 2.0–2.7s（中转站自己的底噪约 2s），Qwen 新请求 0.3–0.9s、带缓存前缀 0.9–1.2s。
  所以回复推荐的请求走 `#completeQuick`（`engine/thinking-off.ts`）：对 OpenAI 兼容的接口（chat completions 和 Responses——FastVibe 中转站上的 deepseek 就是 /responses 模型，量过同样有效）**额外**带上三个关思考字段
  （`enable_thinking:false`、`chat_template_kwargs.enable_thinking:false`、`thinking:{type:"disabled"}`，SDK 已经设了的不覆盖）。
  SDK 本来会按 `thinkingFormat` 在不传 reasoning 时关思考，但自定义中转站的格式靠 URL 推断、认不出就什么都不发，所以这里补一层。
  严格的端点会把未知字段当 400：`withThinkingOffFallback` 在失败信息像「参数被拒」时**原样不带补丁重试一次**并记住这个模型
  （`#thinkingOffRefused`，之后直接走普通请求）；超时、限流、密钥错误不重试。Anthropic、Google 不加补丁（不传 reasoning 本来就是关）；OpenAI 官方的 Responses 会拒绝这些字段，走上面的重试一次。
  **`FASTVIBE_SUGGEST_MODE=cache`**（同一前缀 + 追加一轮，`buildCacheContext`，必须是对话自己的模型）保留作实验：关思考后它没有比
  精简的新请求更快（Qwen 0.9–1.2s 对 0.3–0.9s），但它看得到整段对话，建议更贴题。默认仍是 `fresh`（精简的新请求）。
  每次请求在 `logs/main.log` 里有一行 `[suggest] mode=… model=… ms=… in=… cacheRead=… -> shown|stop=length|…`。
- 预览：`mock.html?suggest=1`。原生移动端还不认 `reply_suggestion`，会忽略它。

## 旁路请求与 pi 补上的「关闭思考」参数（`engine/thinking-off.ts`）

一轮请求**没有请求思考强度**时，pi 会替模型补一个关闭思考的参数，而不是什么都不发：`openai-responses` / `azure-openai-responses` / `openai-codex-responses` 补 `reasoning: { effort: "none" }`，`openai-completions` 只在模型自己映射了 `off` 时补 `reasoning_effort`。FastVibe 从不映射 `off`（UI 不提供这一档，`decodeEfforts` 里就写着），所以这些请求都带着 pi 的猜测出门——而 gpt-5 之前的推理模型只认 minimal/low/medium/high，回一句 400。这类请求全在 agent loop 之外，SDK 的 retry 策略一次也不会碰到它们，症状就是「gpt 模型的对话永远没有标题」这种没有任何人看见的失败。

- **入口只有一个：`installThinkingOffGuard(runtime)`，在 `PiProcessManager.start()` 里 `new ModelRegistry(...)` 之后立刻装。** 它包 runtime 实例上的**两个方法**，因为整个应用不带思考档位的请求只会从这两处出去：`complete`（标题生成、`/handoff`、AI 提交信息、记忆抽取——扩展拿到的 `ctx.modelRegistry` 是 SDK 自己 `new ModelRegistry(this._modelRuntime)` 出来的第二层门面，FastVibe 碰不到它，所以只能在它底下的 runtime 上做）与 `streamSimple`（**主对话与压缩也走它**：`pi-coding-agent/core/sdk.js` 那个 `streamFn` 闭包调的是 `modelRuntime.streamSimple`）。两个 `bind` 都在赋值之前完成，SDK 改名只会当场抛错，不会留下半包装的状态。
- **被拒了才去掉，不是每次都去掉。** 去掉参数的语义是「这个模型没有关闭思考的开关」（`thinkingLevelMap: { off: null }`，与 `pi-global-sync.ts` 的 `withAdaptiveOff` 同一手法），代价是模型按默认强度思考——而这些请求存在的理由恰恰是不想思考。所以接受 `none` 的模型保留快路：一次失败 → 原样重发（不带该参数）→ 把 `provider/id` 记进 `#noThinkingOffModels`（进程内的学习，不落盘，和 `#thinkingOffRefused` 一样）。已经在集合里的模型每次都直接按去掉参数的样子发，因为调用方每次交回来的都是 registry 里那个原始 model，学习必须发生在 helper 里。
- **去掉参数要同时放宽输出上限**（`roomForThinking`，1024，封顶在模型自己的 `maxTokens`）：思考计入 `max_tokens`，128 的标题请求会在思考中途被切，`stopReason: "length"` 又被 `candidateTitle` 判为不可用，重试四次还是没标题——修了 400 换来一个更难查的哑失败。
- **只认「点名了思考参数」的拒绝。** `looksLikeRejectedThinkingOff` 要求同时出现 reasoning/effort/thinking（或引号里的 `'none'`）与 invalid / not supported 一类措辞；超时、429、坏 key 原样交回给调用方（返回的 error reply 还是抛出的 error，形状都不改），也不把模型误标成没有开关。
- **`streamSimple` 那侧只换模型、不重试**：重试一条已经在跑的流等于把它重启，代价不成比例。它做的是另一件事——把已经学到的模型在交给 SDK 之前换掉（`guardedModelFor`），返回的还是 SDK 自己那条 `AssistantMessageEventStream`。这条是必需的，因为 pi-ai 分不出「档位是 off」和「根本没表态」：`pi-agent-core/agent.js:307` 把 off 转成 `reasoning: undefined`，`streamSimple` 再转成 `reasoningEffort: undefined`，两者落到同一个补值分支——FastVibe 今天不提供 off 档所以主对话走不到，但恢复来的转写、别的宿主写下的会话都可能走到，那时 400 出现在对话中间而不是标题上。
- **两处 `streamSimple` 的直接调用方各自显式套 helper**（它们绕过了 runtime 的 `complete`）：`#completeQuick`（回复推荐，与它原有的 thinking-off 补丁两层叠加，各学各的）和 `testProvider`（模型自检：只有 `protocol` 类失败才按去掉参数的模型重跑一次并放宽输出上限，**重跑成功才认定**这个模型没有开关，因为 400 也可能真是坏的工具 schema）。
- 验证：`test/thinking-off.test.ts` 里一组 payload 断言直接跑 pi-ai 的 provider（stub fetch 抓请求体），钉住三件事——「无映射 → `effort:"none"`」「`off:null` → 不发」「带 `reasoning:"off"` 与不带档位**完全一样**」；最后那条就是上面那个语义塌缩的证据，也是包 `streamSimple` 的理由。`test/session-title.test.ts` 用真实 SDK 跑完整对话钉住「扩展那侧确实被 guard 覆盖」。

## Model metadata (models.dev)

- `scripts/sync-models-dev.mjs` downloads `https://models.dev/api.json` and emits a
  lookup-optimised snapshot to `resources/models-dev/index.json` (gitignored, generated).
  The upstream catalog is ~4.5 MB; the snapshot is ~0.4 MB.
- The snapshot is `{ v, t, s, c, m, x }`: `m` is unique models as
  `[id, name, context, output, inputMask, efforts|null, cost|null]` tuples and `x` maps
  every normalized alias to an index, so runtime lookup is one `Map` hit (O(1)).
  `v: 2` added `cost`, `v: 3` the price ladder, `v: 4` dropped the feature bitmask the
  UI no longer records, `v: 5` made the fold order-independent (see the folding rules
  below; the tuple shape did not change, so a v4 reader still decodes it). Older
  snapshots still decode — a v1 tuple just ends after `efforts`, and the decoder reads
  the price slot by version so a stale bundled index loses detail instead of misreading
  a retired field as prices.
- `cost` is `[input, output, cacheRead, cacheWrite, tiers?]` per million tokens, `null`
  when the catalog has no non-zero price; `tiers` is the long-context ladder,
  `[[over, input, output, cacheRead, cacheWrite], …]` ascending, and absent for the
  majority of models that charge one flat rate. `context_over_200k` is the older
  single-threshold spelling and is only consulted when a model has no `tiers`. A tier
  row that omits a field (`cache_write` on most Anthropic models) keeps the entry price
  for that field rather than reading as free.
- **The fold is a total order, and that is the whole point.** The catalog lists one
  model under every reseller that carries it — ~9000 entries for ~3600 ids — and they
  disagree: the same id arrives with different context windows and prices that can
  differ by more than 10×. Which entry wins is therefore a decision, not a detail. It
  used to be made by iteration order: entries were scored, and an exact tie kept
  whichever appeared first upstream, so a model's context window and **billing** moved
  whenever models.dev re-sorted its provider list (36% of ids were tied, 541 of them
  with different metadata; ~1000 of 5720 aliases could resolve differently). The order
  now is: **the vendor's own entry** (`canonical_model_id`'s provider prefix — `anthropic`
  for `anthropic/claude-sonnet-5-5`; a prefix match like `google-vertex` ranks next, but
  **a subscription plan never gets that credit** — `xiaomi-token-plan-cn`,
  `zhipuai-coding-plan`, `tencent-tokenhub` are a vendor's 包月 billing plan, not the vendor,
  and a plan is not charged per token so its rate is not a list price; no
  `canonical_model_id` prefix in the catalog is plan-shaped, so exact vendor matches are
  untouched), then capability, then a complete price list, then the long-context ladder,
  then the larger context window, then provider id and model id. The last two make it
  total, so the same catalog always folds the same way. An id **no vendor publishes** (a
  reseller-only release) therefore resolves by provider id alone: arbitrary, but stable
  and the same on every machine and every hour. An entry with no price is dropped before
  that comparison whenever some candidate has one — a $0 model bills every turn at zero.
  `test/models-dev-index.test.ts` shuffles a catalog and asserts the fold is
  byte-identical; keep that test when touching `scripts/models-dev-encode.mjs`.
- **Aliases are claimed by tier, not by rank.** Every entry offers names that are not its
  id (the last segment of `zai-org/GLM-5.3`, the display name, a date-stripped form), and
  913 of them are claimed by more than one model. Handing an alias to whichever entry
  ranked highest meant `llama3-3-70b` could resolve to `TEE/llama3-3-70b`'s neighbour
  instead of the model literally called that. Claims are tiered — the alias *is* the
  entry's key (0), its date-stripped form (1), the last segment of a namespaced id (2),
  the display name (3) — and a lower tier always wins; inside a tier the same total order
  applies.
- Prices are not display-only. `cost` is written to `models.json`, where pi's
  `calculateCost` multiplies it by the turn's tokens; the ladder cannot be expressed
  there (pi prices a run with one rate), so `src/main/engine/pricing.ts` picks the tier
  from the request's prompt size whenever FastVibe reports money itself — the live
  composer stat and 统计 — and `models.json` keeps the entry rate.
- **A stored model's metadata is only a fallback, and only for ids the catalog does not
  know.** `providers.json` keeps a copy of every field the catalog supplied, but that
  copy is what the snapshot said on the day the model was added. `hydrateModels`
  therefore re-derives context window, output ceiling, modalities, reasoning, thinking
  levels and prices from the current catalog for every model the user has **not** tuned
  (`edited`), which is also how a corrected fold reaches an install that already stored
  the wrong winner's numbers. A tuned row is authoritative in every field, and an id the
  catalog does not describe at all keeps what it had — the 128K/8K defaults
  `enrichModel` substitutes are conservative guesses, and swapping a real context window
  for them would make the window guard compact far too early.
- `src/main/engine/models-dev.ts` reads the user-updated snapshot first
  (`models-dev.json` in the app data dir) and the bundled one second. The snapshot is
  refreshed hourly on the user's machine (`models-dev-refresh.ts`) and on demand from
  设置 → 关于; both call `models-dev-update.ts`, and a click during the background fetch
  waits for that same download. A failure is logged and retried an hour later — it is
  not shown, and it is not polled in a loop. An overdue or missing snapshot is fetched
  shortly after launch rather than waiting out a full hour; one already inside the hour
  waits for the rest of it. Deleting the updated file falls back to the copy the app
  shipped with, and a corrupt one is ignored rather than trusted. Both writers share
  one encoder (`scripts/models-dev-encode.mjs`, also used by `scripts/sync-models-dev.mjs`),
  so what is downloaded is the format the decoder already reads. The file is replaced
  either way (its timestamp is what the schedule waits on), but `models.json` is
  re-derived through `PiProcessManager.reloadModelMetadata()` only when the catalog
  content changed — an unchanged hour must not rebind every open session. That reload
  refreshes live sessions like a provider edit and never boots a cold engine.
  `normalizeModelKey` must stay identical to `normalize` in the sync script.
- Resolution order: the updated `models-dev.json`, then
  `process.resourcesPath/models-dev/index.json`, then `resources/models-dev/index.json`.
  Packaging must copy the directory via
  `extraResources`. If the snapshot is missing, models fall back to defaults
  (128K context / 8192 output / text-only) and the settings About page shows it as missing.
- Run `pnpm sync:models -- --force` before a release to refresh the snapshot.
