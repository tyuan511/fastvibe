# 图片生成工作台

图片生成是独立领域，类型以 `src/shared/image-generation.ts` 为准。全局侧栏「图片生成」进入 `#/images`，保留原有项目与聊天列表；图片工作台是单栏布局，内容区与聊天同宽（`CHAT_COLUMN_CLASS`，跟随设置 → 外观的「消息宽度」），生成批次按发起时间排列。无左侧会话栏：标题栏显示当前会话标题，点击弹出会话 Popover（`components/images/image-session-list.tsx`）管理会话——点击切换、行尾更多菜单与右键菜单重命名/确认删除、头部加号新建。每个会话用最新一张已保存图片做封面缩略图（`ImageSession.previewPath`，由 `snapshot()` 读时从最新任务推导，不落库；无图会话显示安静占位），标题与最近更新时间分两行，生成中显示脉冲状态，当前会话用淡主色底和描边封面突出。打开页面自动落在最近更新的会话；无任何会话时（首次打开或被删空）自动创建「默认会话」并选中。图片模型来自统一供应商目录，生图请求独立于聊天 SDK。

## 配置与默认模型

设置 → 模型与默认复用现有供应商和模型管理，协议增加「图片-GPT」「图片-Gemini」「图片-Grok」，既可设置供应商默认协议，也可给单个模型覆盖协议。同一供应商可以同时保存聊天与图片模型。新增模型支持手动填写 ID，图片供应商不要求先查询模型列表。图片模型详情只保留名称与协议，隐藏聊天上下文、输出上限和推理参数。

`shared/image-model.ts` 按模型协议优先、供应商默认协议兜底筛选图片模型，工作台和「默认图片模型」都使用这份投影。默认值保存在 `settings.defaultImageModel: { provider, id }`。隔离模式继续使用 `providers.json` 与现有凭据存储，不创建独立图片模型配置或密钥文件；全局模式在既有 `models.json` 供应商中使用 `fastvibeImageModels / fastvibeImageApi` 扩展字段保存图片元数据，SDK 的标准协议字段只保留聊天 API。聊天模型列表排除图片协议，包括被改为图片用途的原生模型。

所有图片请求在宿主端解析所属供应商的通用 API key，不经配置、任务或事件返回。全局模式沿用 pi 的 key 表达式语义；订阅 OAuth 不进入图片鉴权流程，不刷新或发送订阅令牌。模型协议由用户明确选择，不根据名称猜测。

新会话采用默认图片模型；已有会话保持最近一次使用的模型和参数。`isUsableImageModel` 统一判断模型已启用、有通用 API key、接口为有效 HTTP(S) 地址，且模型标识有效，不通过付费请求探测上游。没有可用模型时，工作台显示前往现有模型管理的引导并禁止生成，历史图片仍可查看；配置读取中和读取失败分别呈现，不冒充未配置。

没有任何可用图片模型时不注册 `generate_image`，工具声明和活动工具集中都没有它。增加、禁用、删除模型或修改凭据后，空闲会话立即重载工具，正在运行的会话在 settle 后更新；创建期间的配置变化由资源版本检查补齐。只有默认模型变化不触发工具重载。有可用模型但未设默认时，工具描述列出可用模型 ID，调用方必须显式指定 `model`，不会选择另一家模型替用户付费。

## 异步任务

`ImageGenerationService` 由 `PiProcessManager.images` 持有，通过桌面和无头 Agent 共用的 `registerImagesIpc` 注册。所有调用进入中立调用表，`images:changed` 通过广播发送给同一宿主的客户端。SSH 项目绑定目前不聚合另一台主机的图片工作台；远程客户端可直接连接对应宿主调用这些方法。

每次生成先用一个数据库事务写入会话、任务和 revision，再立即返回任务。网络请求独立运行，没有本地等待队列。一批 1–4 张图被拆成并发的单图请求，每张成功立即保存并发布；部分失败保留已有结果，不自动重试付费请求。

元数据保存在 `image_sessions`、`image_tasks`、`image_meta`。`request_id` 唯一，用来去重同一次提交。每个任务保存实际模型及参数快照，后续设置修改不改变历史记录。原图与参考图保存为 `runtime/engine/image-generation/<session>/<task>/...`，不把 base64 放进数据库或 UI 状态。

- 取消先发布终态，再中止网络请求；迟到结果不得恢复任务。
- 删除单条生成记录和删除会话都需界面二次确认。单条删除清理该任务原图与参考图，会话删除清理全部所属任务和资产。
- 删除先取消任务并等待写入者停止，再清理文件和元数据；正在删除的会话拒绝新任务，迟到结果不得恢复记录或目录。清理文件失败时保留已取消记录，允许再次删除。
- 参考图最多一张，上传或选择结果图会替换当前参考图；提交后复制到任务自己的目录，删除来源记录不会破坏已经复制的参考图。
- 应用退出将活动任务标为 interrupted；重启也修复遗留 generating，不自动重发。
- 上游临时图片 URL 立即下载到宿主，下载不转发模型密钥。
- 请求有超时、响应/图片/参考图大小限制和图片签名校验。

客户端先订阅变更，再读快照；revision、选中会话和选择代次共同拒绝旧回复。点击已加载完成的当前会话是空操作，内容保留不闪加载态；选择其他会话直接刷新，而不只依赖 ID 的 effect；当前会话尚未加载成功（读取中或上次失败）时再次点击会重试。删除当前会话后自动落到剩余的第一个会话，会话被删空则由默认会话逻辑新建。旧读取与旧错误不能覆盖新选择。事件只通知重新读取，不携带图片字节。切换页面不影响宿主任务。

## 协议

`src/main/images/protocol.ts` 分别处理：

- GPT Image：`/images/generations` JSON；有参考图时 `/images/edits` multipart。旧 `gpt-image-1*` / `chatgpt-image-latest` / `dall-e-*` 保留固定比例和尺寸；新模型及兼容接口使用明确的 `WIDTHxHEIGHT`，支持八种预设比例和 1K/2K/4K 档位、按比例联动的宽高编辑。预设按像素面积缩放，宽高对齐到 16，最长边不超过 3840、总像素 655360–8294400，4K 档表示接口上限内的高分辨率预设，实际尺寸直接展示。Main 同样校验范围和比例，不能仅通过前端放宽。格式依据 [OpenAI Image API](https://developers.openai.com/api/docs/guides/image-generation)；具体模型/中转站仍可能限制尺寸，失败保留草稿且不自动重试。
- Gemini Image：原生 `generateContent`，参考图 `inlineData`，从非 thinking 内容片段提取图片和说明文字。清晰度支持选填 1K/2K/4K，具体能力仍由所选模型决定。
- Grok Image：图片生成/编辑 JSON 接口，参考图使用 data URI，比例使用自己的字段；分辨率提供 1K/2K，请求转成 `resolution: "1k" | "2k"`，不发送 OpenAI 像素尺寸。

本轮通过假的 HTTP 响应验证请求格式、文件保存和失败行为，未使用真实供应商凭据验证各模型的线上可用性。OpenAI Responses 的 hosted image_generation、多轮原生编辑状态、蒙版和视频不在当前实现范围内。

## Agent 工具

`imageGenerationExtension` 注册 `generate_image`，使用同一服务和默认模型。工具创建异步任务后等待自身结果，其他图片任务可同时运行；停止工具只取消自己的任务。普通会话和 Vivi Worker 通过扩展工厂获得工具，重载后重新注册。Agent Team 执行器注册同一工具，角色工具清单决定能否使用；内置 Worker 包含它，Explorer 不获得写权限。Vivi Router 保持只负责分派的工具规则。

生成记录按来源普通会话或 Worker 会话关联到一个图片会话；不会自动导航。`subscribeTask` 在持久化变化后发布任务快照，工具的每次进度与最终结果都保留 `details.task: ImageTask`，含真实状态、图片路径与槽位 index，不含图片字节或凭据。取消与部分失败也保留已完成图片。`details.items` 保留现有预览引用，折叠标题仍可打开图片；工具卡已显示图片网格的位置不再追加重复的文件名列表。

`imagePreviewFromTool` 优先读取任务快照，兼容旧转写的 items 或结果 JSON；已结束工具即使留下旧 generating 状态也不再绘制动画。普通聊天和工作台共用 `ImageResultsGrid`：宽内容区四列，窄内容区两列，每张独立出图并原位替换占位，点击按同一批次查看原图。

## 生成动画与界面

`ImageParticles` 渲染轻量 SVG 标记：主题色呼吸圆点居中，两圈弧线环反向旋转（纯 CSS 动画，无 WebGL/定时器），`motion-reduce` 下静止；不伪造进度百分比。动画最多 30 fps，DPR 与粒子数有界，不逐帧更新 React；离屏/页面隐藏暂停，减少动态效果偏好下使用静态帧，卸载清理 RAF 和观察者。原图加载完成后原位淡入。

图片时间线支持重新编辑、再次生成、取消、查看原图、复制路径、在文件夹中显示和确认删除；操作行左侧显示生成时间。比例、分辨率、数量集中在 `ImageOptionsPicker`，比例提供图形示意；共享参数规则在 `shared/image-options.ts`。数量可选 1–4 张；宽屏始终按四列排布，单张也只占一列，图片和粒子槽位使用同一尺寸；窄内容区切换为两列。提示词、模型、参数与单张参考图按会话保存草稿。Enter 生成、Shift+Enter 换行，保留 Cmd/Ctrl+Enter，组合输入确认键不提交，快捷键不在界面重复提示。图片下方不重复显示供应商的 revised prompt/说明，原始返回仍保存在任务中。工作台与聊天的生图结果都通过 `ImageGallery` 适配至聊天原有 `Viewer`，共用全屏遮罩、左右切图、Escape/空白关闭和路径菜单；工作台以图作参考有两个入口：结果图悬浮的「作为参考图」按钮使用该张图，预览顶栏的同名按钮使用当前查看的图，都会填入输入框参考图；聊天不提供这两个入口。窄屏与桌面共用标题栏的会话 Popover，和全局侧栏独立。

## 验证与预览

- `node --test test/image-options.test.ts`：24 组比例/分辨率预设通过后端校验、旧模型固定尺寸、原生协议格式和无效尺寸拒绝。
- `node --test test/image-generation-service.test.ts test/image-tool-sdk.test.ts`：独立并发、幂等、协议、部分失败、取消/删除迟到、恢复、凭据隔离，以及真实 SDK 的工具加载/重载/角色权限/预览引用。
- `node --test test/image-tool-preview.test.ts`：旧转写回退、四张槽位、无效参数、逐张进度以及取消/中断终态投影。
- `node --test test/image-provider-models.test.ts`：图片协议投影、混合供应商、纯图片凭据、全局配置往返、原生覆盖过滤与真实 SDK key 表达式解析。
- `node --test test/server-policy.test.ts test/inline-media.test.ts test/db.test.ts test/subagent-team-prompt.test.ts`：现有传输与存储契约回归。
- `pnpm typecheck`；生产构建 `pnpm build`。依赖链接的独立 worktree 中可直接运行对应 Node CLI，避免包管理器重装主目录依赖。
- `mock.html?images=1&theme=light|dark&lang=zh|en`：两条图片会话，已完成批次与持续生成的粒子占位。新发起的 mock 任务会逐张完成。
- `mock.html?images=unconfigured|disabled|keyless`：无配置、已禁用或仅订阅鉴权时的配置引导；后两项保留历史图片。
- `mock.html?images=config-error`：配置读取失败与重试，历史仍可查看。
- `mock.html?imageTool=running|progress|done|partial`：普通聊天里的四槽动画、反序逐张完成、完整结果或部分结果。
- `mock.html?images=empty`：空会话；保留 `images` 参数切换到 `#/settings/providers` 查看统一供应商图片协议与默认图片模型。

界面 fixture 使用本地 SVG 样例，不能作为真实供应商生成效果的证据。
