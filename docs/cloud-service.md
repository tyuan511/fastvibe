# FastVibe 云服务

FastVibe 自己的服务端：账号、模型转发、用量与计费、官网与控制台，以及之后的官方隧道和客户端配置下发。服务端用 Go，数据库用 Postgres。

**顺序**：先做服务端、官网和控制台，桌面端最后再改。桌面端现有的内置供应商（指向 `fastvibe.dev` 的 sub2api）在桌面端改造之前保持原样，本文的服务与它无关。

## 域名与路由

全部放在 `app.fastvibe.dev` 上：

| 路径 | 由谁提供 | 内容 |
| --- | --- | --- |
| `/`、`/zh/...`、`/en/...` | 官网（`apps/website`，Next.js） | 产品介绍、下载 |
| `/<locale>/login`、`/<locale>/console/...` | 官网（同一个 Next 应用） | GitHub 登录、控制台 |
| `/<locale>/admin/...` | 官网（同一个 Next 应用） | 管理后台，仅管理员 |
| `/<locale>/terms`、`/<locale>/privacy` | 官网 | 服务条款、隐私政策 |
| `/api/...` | `services/cloud`（Go） | 业务 API，认证也在这里 |
| `/llm/...` | `services/cloud`（Go，嵌入 Bifrost） | 模型转发 |

`fastvibe.dev` 上是另一个独立运营的 sub2api 中转站，和这里无关。`app.fastvibe.dev` 和它属于同一个根域名（same-site），所以本服务的 cookie 一律只绑定当前主机名：用 `__Host-` 前缀，不设 `Domain`。

官方隧道不放在这个域名下，见「官方隧道」一节。

### 为什么官网要从 Vercel 迁到自建

一个主机名只能解析到一处。`/llm` 的流式输出不能经过 Vercel：外部 rewrite 会遇到超时，流量还要额外计费。所以 `app.fastvibe.dev` 由服务器上最外层的 **nginx**（它同时也在代理这台机器上的 Jenkins）统一接入，直接转给后面的两个服务，中间不再加一层代理：

```
外层 nginx (app.fastvibe.dev, TLS)
  /api/   →  127.0.0.1:9089  cloud (Go)
  /llm/   →  127.0.0.1:9089  cloud (Go)，关缓冲、关压缩、超时 35 分钟
  /       →  127.0.0.1:9088  website (next start，output: "standalone")
```

cloud 和 website 各自打包、各自部署。cloud 监听 `127.0.0.1:9089`、website 监听 `127.0.0.1:9088`（都避开 Jenkins 默认占用的 8080），容器只发布在回环地址，不对外网开放。要加进外层 nginx 的配置在 `services/cloud/deploy/nginx/`：`upstreams.conf`（放在 http 块里）、`locations.conf`（放在 `app.fastvibe.dev` 的 server 块里）、`proxy_headers.conf`（被前者引用）；`app.fastvibe.dev.conf.example` 是还没有这个域名的 server 块时的参考，`make nginx-check` 用同一版本的 nginx 做语法检查。

**`/llm` 的三条硬要求，缺一条流式输出就出问题**：`proxy_buffering off`（否则回复一段一段地蹦出来）、`gzip off`（压缩也会攒数据）、读写超时 35 分钟（长回复不被切断）。`client_max_body_size 32m` 要和服务的 `http.body_limit` 一致。这些都在 `locations.conf` 里，以后如果又在前面加了一层代理或 CDN，那一层也要照做。

**真实 IP**：外层 nginx 把 `X-Real-IP` 覆盖成它看到的连接地址，服务只信任来自 `http.trusted_proxies` 的这个头，别处发来的一律忽略。这个地址决定了审计日志和限流看到的是谁，配错了所有用户会共用一个 IP。

如果前面再套一层 Cloudflare：它会切断 100 秒内没有任何数据的连接。`/llm` 的流式输出靠持续推送数据块保持连接活跃；模型长时间思考、一个字都没输出时，转发层要定时发 SSE 注释行（`: ping`）。

### 官网侧要注意的两点

- `middleware.ts` 的 matcher 现在只排除了 `api`，还要加上 `llm`，否则 next-intl 会把 `/llm/v1/...` 当成页面重定向到 `/en/llm/...`。
- 不要在 Next 里建 `app/api/*` 的 route handler：`/api` 在 nginx 那一层就转给 Go 了，Next 里写了也收不到请求。

控制台做进同一个 Next 应用，放在 `app/[locale]/(console)` 路由组下。页面在客户端渲染，同源调用 `/api`。登录态是同源 cookie，不需要 CORS。

## 组件与技术栈

```
services/cloud/
  cmd/cloud/            主服务：/api 与 /llm
  internal/auth/        GitHub 登录、会话令牌
  internal/account/     用户、设备
  internal/llm/         Bifrost 嵌入、Account 实现、插件（鉴权 / 计量）
  internal/billing/     价格表、用量写入、账本、兑换码；之后接 Creem
  internal/store/       sqlc 生成的代码
  migrations/
  deploy/               docker-compose（postgres + cloud）、nginx 片段、配置示例
```

| 用途 | 选型 |
| --- | --- |
| HTTP 框架 | Fiber v3（`/api` 与 `/llm` 同一个 fasthttp 监听，Bifrost 的接入层也跑在 fasthttp 上） |
| 数据库 | Postgres；驱动用 `pgx/v5`，查询用 `sqlc` 生成 |
| 迁移 | `goose` |
| 日志 | zap（生产 JSON，开发 console）；每个请求一行，只记路径，不记查询串和内容 |
| 配置 | koanf：内置默认值 → 可选 YAML 文件 → 环境变量（`FASTVIBE_` 前缀，层级用双下划线） |
| 模型转发 | `github.com/maximhq/bifrost/core`（Apache-2.0），以库的形式嵌入 |
| 本地开发 | `docker compose`：postgres + cloud；website 用 `pnpm website:dev` |

模块化单体：一个二进制。模型转发和 API 在同一进程里，`/llm` 鉴权时直接查本地连接池，不跨服务调用。

## 认证

### 只支持 GitHub 登录

没有邮箱密码，也没有邮箱验证码。登录页做在官网里（`/<locale>/login`），页面上只有一个「使用 GitHub 登录」按钮。

1. 按钮跳到 `GET /api/auth/github/start?return_to=/zh/console`。服务端生成 state 和 PKCE（S256），放进一个 10 分钟有效的 `__Host-fv_oauth` cookie，然后 302 到 GitHub 授权页。
2. GitHub 回调 `GET /api/auth/github/callback`。服务端先校验 state，再用 client secret 换取 access token，调 `GET https://api.github.com/user` 取用户信息，调 `GET https://api.github.com/user/emails` 取邮箱。用户的 GitHub token 用完即丢，不存。
3. 按 GitHub 的**数字 id** 找到或创建用户。不用 `login`：用户名可以改，改名后又可以被别人注册走。
4. 创建会话，写 cookie，302 回 `return_to`。`return_to` 只接受以 `/` 开头、且不以 `//` 开头的站内路径，防止被利用做开放重定向。

- 用 GitHub **OAuth App**，scope 是 `read:user user:email`。要邮箱权限，是为以后开放邮箱登录做准备。
- **只存 GitHub 标记为已验证的邮箱**：从 `/user/emails` 里取 `primary && verified` 的那一个，没有就留空。`/user` 里的 `email` 字段只是公开资料，用户可以随便填，不能当身份依据。
- 每次登录都刷新邮箱，用户在 GitHub 上改了主邮箱，这边会跟着变。
- 已验证的邮箱在库里唯一。这个邮箱已经挂在另一个用户名下时（比如有人把它从旧 GitHub 账号移到了新账号），这次登录不写邮箱，但登录照常成功，并在 `audit_log` 里记一条。
- 以后开放邮箱登录时，只按**已验证的**邮箱把两种登录方式合并到同一个账号上。未验证的邮箱一律不参与合并，否则别人在 GitHub 上填你的邮箱，就能接管你的账号。
- 一个 OAuth App 只能填一个回调地址，所以本地开发单独注册一个回调到 `http://localhost` 的 OAuth App。
- `/user` 返回的 `created_at` 存下来。以后如果送试用额度，可以按 GitHub 账号注册时长来限制，挡掉批量注册的小号。

### 会话令牌：网页和 `/llm` 用同一种

只有一种凭据：**不透明的会话令牌**。32 字节随机数，库里只存 SHA-256 哈希，存在 `sessions` 表里。有两种携带方式：

| 客户端 | 怎么携带 | 有效期 |
| --- | --- | --- |
| 官网和控制台 | cookie `__Host-fv_session`（HttpOnly、Secure、SameSite=Lax） | 30 天，用一次就顺延 |
| 桌面端、手机端（延后） | `Authorization: Bearer <token>`，每台设备一个 | 90 天，用一次就顺延；在控制台「设备」页可以逐台登出 |

- `/api` 两种方式都接受。用 cookie 的写请求必须带同源的 `Origin`，防止跨站伪造请求。
- **`/llm` 只接受 Bearer，带 cookie 也不认。** 否则任何网页都能借访问者的登录态替他消耗余额。
- **不另发 API Key。** `/llm` 认的就是登录后拿到的这个会话令牌。代价是用户没法把官方转发配进其他工具（Claude Code、Cursor、Codex CLI）。以后如果要支持，在 `/llm` 上再加一种 API Key 凭据就行，不影响现在的设计。
- **为什么不用 JWT**：`/llm` 每次请求本来就要查余额，查令牌不多花什么。不透明令牌可以立刻吊销；也不用 access token 加 refresh token 那一套。agent 跑一个长任务时，不会撞上 15 分钟过期。
- 校验结果在进程内缓存 30 秒（按令牌哈希）。本实例登出时立刻清掉缓存；多实例部署时，其他实例上的吊销最多晚 30 秒生效。

### 桌面端登录（延后）

浏览器授权码 + PKCE + 本机回调（RFC 8252）：

1. 桌面端打开官网的 `/<locale>/authorize?...`。
2. 浏览器里还没登录的话，先走一遍 GitHub 登录，再回到授权页。
3. 用户确认后，带着授权码回调到本机端口。
4. 桌面端用授权码请求 `POST /api/oauth/token`，拿到这台设备的会话令牌。

桌面端把这个令牌直接当作内置供应商的「API Key」，注入 SDK 的内存凭据存储，同时持久化到一个 0600 权限的文件里。手机端用设备码流程（RFC 8628），拿到的也是同一种令牌。

### P1 实现说明

后端在 `services/cloud/internal/auth`（登录流程、会话、令牌缓存）和 `internal/httpapi/auth.go`（路由、cookie、Origin 校验），页面在 `apps/website` 的 `app/[locale]/(account)/`。上面的设计都按原样实现了，下面是文档里没写、实现时定下来的细节：

- **接口**：`GET /api/auth/github/start`、`GET /api/auth/github/callback`、`POST /api/auth/logout`、`GET /api/me`、`GET /api/sessions`、`DELETE /api/sessions/:id`。失败的回调一律 302 到 `/login?error=<code>`，错误码有 `invalid_state`、`github_denied`、`github_rejected`、`github_unavailable`、`account_disabled`、`internal_error`，登录页按语言显示对应文案。
- **令牌格式**：`fvs_` 加 43 个字符（32 字节随机数的 base64url）。格式不对的令牌不查库直接拒绝。
- **state cookie**：`__Host-fv_oauth`，里面是 state、PKCE verifier、return_to 和过期时间，10 分钟有效，不签名。`__Host-` 前缀加 HttpOnly 保证页面脚本和同根域的其他子域名（`fastvibe.dev` 上跑着另一个服务）既读不到也写不进，所以不需要签名。
- **cookie 会跟着会话一起顺延**：服务端每次用 cookie 认证成功都重新下发 cookie。否则会话在服务端是滑动的，浏览器里的 cookie 却会在登录 30 天后固定过期。
- **本地开发用 http**，没有 `__Host-` 前缀（浏览器要求它必须是 Secure），cookie 名是 `fv_session` 和 `fv_oauth`，开发环境下 GitHub 凭据可以不配，登录入口返回 503。生产环境缺少 GitHub 凭据时服务拒绝启动。
- **限流**：`/api/auth/github/*` 每个 IP 每分钟 30 次，用的是进程内存，多实例时每个实例各算各的。
- **邮箱冲突**：已验证邮箱被别的账号占用时登录照常成功，邮箱不写入，审计日志记一条 `email_conflict`。取邮箱失败（GitHub 的邮箱接口出错）时不改已存的邮箱。
- **审计**：`login`、`login_refused`、`logout`、`session_revoked`、`admin_granted`、`email_conflict` 都会写 `audit_log`。
- **过期会话**：每天清理一次，删除失效超过 90 天的会话。
- **控制台页面**：`/login`、`/console/account`（账号）、`/console/sessions`（设备）。登录页发现已登录会跳到控制台，未登录访问控制台会跳到登录页。首页导航栏有「登录」入口。

**本地跑起来**（开发 GitHub 登录需要先在 GitHub 注册一个 OAuth App，回调地址填 `http://localhost:9088/api/auth/github/callback`）：

```bash
# services/cloud/.env.local（已被 git 忽略）：
#   FASTVIBE_GITHUB__CLIENT_ID=...
#   FASTVIBE_GITHUB__CLIENT_SECRET=...
#   FASTVIBE_ADMIN__GITHUB_IDS=你的数字id
pnpm dev:web
```

`pnpm dev:web`（`scripts/dev-web.mjs`）同时起两样东西，一个 `Ctrl+C` 全部停掉：`make -C services/cloud run`（Postgres 加 Go 服务，监听 `127.0.0.1:9089`）和官网的 `next dev`（`:9088`，把 `/api` 代理到服务）。官网端口取自 `FASTVIBE_PUBLIC_ORIGIN`，代理目标取自 `FASTVIBE_HTTP__LISTEN`，都读 `.env.local`，两边不会对不上；端口已被占用时会直接说明，不会只起一半。退出后 Postgres 容器还在，`make -C services/cloud down` 才会停。

**没有 GitHub 凭据时看控制台页面**：往本地数据库里直接插一个用户和会话（令牌的 SHA-256 存进 `sessions.token_hash`），再把令牌设成浏览器的 `fv_session` cookie。

**还没做**：桌面端和手机端的登录（授权码 + PKCE，见上面的「桌面端登录」）、管理后台的 `/api/admin/*`、退出所有设备。

## 模型转发（`/llm`）

### 路径

桌面端会按协议改写 baseUrl（`engineModelBaseUrl`）。以 `https://app.fastvibe.dev/llm/v1` 作为 baseUrl 时，实际请求的路径是：

| 协议 | 路径 |
| --- | --- |
| OpenAI Chat | `/llm/v1/chat/completions` |
| OpenAI Responses | `/llm/v1/responses` |
| Anthropic Messages | `/llm/v1/messages`（桌面端先去掉 `/v1`，SDK 再自己拼回 `/v1/messages`） |
| Google | `/llm/v1beta/models/{model}:streamGenerateContent`（`v1` 被改写成 `v1beta`） |
| 模型列表 | `/llm/v1/models`：只返回这个用户能用的模型，由我们自己实现 |

`/llm` 只认会话令牌，放在 `Authorization: Bearer` 里（Anthropic 格式也可以放 `x-api-key`，Google 格式也可以放 `x-goog-api-key`），见「认证」一节。它忽略 cookie，也不返回 CORS 头。

### 分工：Bifrost 有的能力直接用，钱的事归我们

**原则：Bifrost 已经有的能力就直接用，不自己再写一套。** 下面留在我们这边的几项，都是 Bifrost 没有、或者和它的形态对不上的。

```
/llm 请求
 1. 鉴权、检查账号和模型、并发与 RPM              ← 我们
 2. 预扣（冻结预估费用），写一条 pending 记录      ← 我们，同步落库
 3. 路由：按 model_routes 排出候选渠道             ← 我们
 4. 调用上游：协议适配与转换、流式、key 轮换、     ← Bifrost core
    候选渠道之间的失败切换
 5. 用量归一化：各家 usage → BifrostLLMUsage        ← Bifrost core
 6. 结算：按价格表算费用，写流水，解冻              ← 我们，同步落库
```

- **所有请求都经过 Bifrost 自己的 HTTP 接入层**（`transports/bifrost-http/integrations` 的 OpenAI / Anthropic / GenAI 路由），同协议和跨协议都一样。接入层会先把请求解析成 Bifrost 的内部结构，再按上游协议重新序列化，同协议也不例外。只有 Claude Code 的 User-Agent 会触发原样透传。所以字段会不会丢，取决于它的结构有没有覆盖那个字段，P0 已经逐个验过（见下面的「原型验证结论」）。各家 provider 的适配、流式解析、多 key 按权重轮换、失败切换都用它现成的，这是用它的意义。
- 我们给 Bifrost 的是「排好序的候选渠道」：第一个作为 provider，其余作为 `Fallbacks`。失败切换必须在第一个字节发给客户端之前完成（P0 验证第 4 项）。
- **用量直接用 Bifrost 的。** 它把各家的 usage 归一化成 `BifrostLLMUsage`：`PromptTokens`、`CompletionTokens`，`PromptTokensDetails` 里有 `CachedReadTokens`、`CachedWriteTokens` 以及按 5 分钟 / 1 小时拆开的 `CachedWriteTokenDetails`，`CompletionTokensDetails` 里有 `ReasoningTokens`。我们只把这些字段映射成计费用的五个数，见「计费 → 用量口径」。
- 留在我们这边的，以及原因：

| 我们自己做 | 为什么不用 Bifrost 的 |
| --- | --- |
| 费用计算 | Bifrost 的 `Cost` 是 `float64`，而且按它自己的价格目录算；我们卖的是自己定的价，金额必须用整数。所以 token 数用它的，单价和乘法用我们的 |
| 余额、预扣、流水、充值 | Bifrost 的 budget 是「每个周期最多花多少」的限额，没有预付余额、充值、退款这套账本 |
| 鉴权与限流 | 它的鉴权和限流挂在虚拟 key 上；我们 `/llm` 认的是用户的会话令牌，用户只在我们库里存一份 |
| 模型目录、价格、渠道配置 | 在我们的管理后台里维护，通过 `Account` 接口交给 Bifrost；不用它的 configstore，免得两份配置 |
| 请求日志 | 我们不存请求内容；用量和元数据已经在 `usage_events` 里，不用它的 logstore |
- 我们实现 Bifrost 的 `Account` 接口：渠道和凭据从 Postgres 读，见「管理后台 → 和 Bifrost 的对接」。
- **`internal/llm` 对外只暴露我们自己定义的接口**；Bifrost 锁定版本，升级前先跑全部协议回放测试和用量样本测试。
- 请求 OpenAI 系上游的流式接口时，确保带上 `stream_options.include_usage`（Chat 需要；Responses 在 `response.completed` 里自带用量）。

### 错误格式

`/llm` 自己产生的错误（未登录、余额不足、限流、模型不存在）**按请求所用协议的原生格式返回**：OpenAI 路径返回 `{"error":{"message","type","code"}}`，Anthropic 路径返回 `{"type":"error","error":{"type","message"}}`，Google 路径返回 `{"error":{"code","message","status"}}`。这样客户端的 SDK 能正常解析，用户在桌面端看到的是一句能看懂的话（比如「余额不足，请到 app.fastvibe.dev 充值」），而不是一段 JSON。

- 余额不足返回 402。注意：SDK 会对 429 自动重试，所以余额不足不能用 429。
- 上游的错误原样转回（状态码和正文），去掉上游的请求 id 等内部信息。所有候选渠道都失败时，返回最后一个错误。
- 每个响应都带 `x-fastvibe-request-id` 头，和 `usage_events.request_id` 是同一个值，排查问题时用户报这个 id 就行。

### 不存请求内容

只记录元数据（模型、token 数、费用、耗时、状态、渠道），**不存 prompt 和回复的内容**，日志里也不打印请求体。排查问题靠 request id 加元数据。隐私政策里照这个写。

### 限制

- 请求体上限 32 MB（图片以 base64 嵌在请求里，桌面端发的图片已经缩到长边 2048）。
- 单次请求最长 30 分钟；上游 60 秒没有任何输出就断开，并按「客户端中途断开」的规则计费。

### 动手前的原型验证（P0）

用真实上游逐项验证 Bifrost。哪一项不过，先查 Bifrost 有没有对应的配置或透传选项；确实不行，就先不支持那种组合，或者给 Bifrost 提 PR：

1. **同协议不丢字段**：`/v1/responses` 流式发给 OpenAI 系上游，`reasoning.encrypted_content`、工具调用的事件序列、`previous_response_id` 都完整；`/v1/messages` 发给 Anthropic，thinking 签名、`cache_control`、工具调用都完整。
2. **跨协议转换正确**：Responses 请求转到 Anthropic / Gemini 上游时，流式事件、工具调用、思考内容都对。
3. **用量准**：用真实上游录下「用量口径」里列的回归样本，确认 Bifrost 给出的数字和上游原始 usage 对得上（含缓存命中、5 分钟和 1 小时两种缓存写入、思考 token），passthrough 和协议转换两条路径都要验。
4. **失败切换只在首字节之前**：上游在输出前失败时切到下一个候选；已经开始输出后失败，不会再切换去拼接另一段输出。
5. **中途断开**：客户端断开时上游请求被取消，已经拿到的用量能交给我们。
6. **运行中改配置**：新增或修改上游（换 base_url、加 key）不重启就生效。

### 原型验证结论（离线，2026-10-09）

原型在 `services/cloud/spike/bifrost`，用的是 Bifrost core `v1.11.3` 加 transports `v2.2.6`。用本地假上游（按各家线上格式写的 SSE 和 JSON，并记录收到的请求体）跑 `go test -race`，六项都过了。具体见原型目录下的 README。

- **第 1、3 项，字段**：OpenAI 那边 `encrypted_content`、`previous_response_id`、`prompt_cache_key`、`reasoning` 都能到达上游，回包里的 `encrypted_content` 也能原样带回。Anthropic 那边 thinking 签名、`cache_control`（含 `ttl`）往返都完整。
- **第 2 项**：Responses 请求转到 Anthropic 上游，回给客户端的是 Responses 格式，计费按 Anthropic 的用量，缓存写入正确拆成 5 分钟和 1 小时。
- **第 3 项，用量**：五个计费数和预期完全一致（OpenAI：输入 200、缓存命中 800、输出 50，其中思考 30；Anthropic：输入 10、缓存命中 900、写入 5 分钟 60 和 1 小时 40、输出 70）。
- **第 4 项**：首字节前上游返回 500，会切到下一个候选，只有成功那次计费。
- **第 5 项**：客户端断开后，记录标成 `aborted`，并带上断开前已消耗的输入（Anthropic 在第一个事件里就报了输入用量）。**已经生成的输出没有计入**：Anthropic 的输出数在最后的 `message_delta` 里才给。所以「中断请求按已转发输出估算」这条规则必须由我们自己实现。
- **第 6 项**：改了 `Account` 之后调 `UpdateProvider`，流量就切到新地址，不用重启。

**必须带进正式实现的四个发现：**

1. **推理能力按模型名猜。** Bifrost 判断一个 OpenAI 模型是否推理模型，是看名字（`o1` / `o3` / `o4` / `gpt-5`…）。判成不是，就会**删掉 `reasoning` 参数和回放的 `encrypted_content`**。中转渠道用别的名字提供推理模型时，这两样会被悄悄丢掉。所以正式实现必须实现 `BifrostConfig.ModelCatalog`（`ModelInfoProvider`），用 `models` 表的 `thinking_levels` 回答每个（渠道, 上游模型）的能力，不能让它靠名字猜。原型里 `TestUnknownOpenAIModelNameLosesReasoning` 把这个行为钉住了，Bifrost 哪天改了行为，这个测试会失败提醒我们。
2. **控制头必须剥掉。** 客户端发来的 `x-bf-*`（直连 key、给上游加请求头、原始请求体开关）、`Authorization`、`x-api-key`、`x-goog-api-key`、`Cookie`、`x-request-id`，在交给 Bifrost 之前一律删除。`x-request-id` 换成我们自己生成的 UUIDv7，它就是 Bifrost 的 request id，也是 `usage_events.request_id`。剥掉鉴权头之后，Anthropic 接入层按 API key 模式走，用渠道自己的 key，不会把用户凭据当 OAuth 透传给上游。
3. **transports 模块没法按版本号引用。** 它的 tag 是 `v2.x`，但模块路径没有 `/v2` 后缀，Go 模块代理只认 `v1.6.11`。所以要用提交哈希引用，生成伪版本，比如 `v1.6.12-0.20261006042654-8b4fce4f1709`，并在升级说明里写清楚它对应哪个 tag。
4. **接入层基于 fasthttp。** Fiber 也是 fasthttp，所以 `/llm` 和 `/api` 能挂在同一个监听上，nginx 只需要一个上游；把 Bifrost 的 fasthttp 处理函数挂进 Fiber 的方式在 P2 实现时验证。

**还没验证、上线前必须用真实上游跑一遍的**：各家真实响应的用量字段（离线样本是照文档格式手写的）、Gemini 路径、工具调用、图片输入，以及真实的中途断开。方法见原型目录下的 README。


## 计费

币种是**美元**。在线支付以后接 **Creem**，现在不做。

### 原则

1. **token 数用 Bifrost 的，钱用我们自己算的。** token 数来自 Bifrost 归一化后的用量，并经过真实样本核对；单价来自我们的价格表；费用用整数计算。不用 Bifrost 的 `Cost`。
2. **同步落库**。请求开始前写一条 pending 记录并冻结预估费用，结束后在一个事务里结算。不在内存里攒批量，进程崩溃不会让一笔用量凭空消失。
3. **每一分钱都有流水**。余额等于流水之和，随时可以重算核对；对不上就告警，不自动修正。
4. **拿不准的不悄悄收**。估算出来的用量标记 `estimated`，用户在用量明细里看得到；完全不知道用量的请求（进程崩溃）不扣费，告警后人工处理。

### 金额

- 全部用 `bigint` 存 **micro-USD**（1 USD = 1,000,000）。不用浮点数，也不用 `numeric` 做中间计算。
- 价格存成「每 100 万 token 多少 micro-USD」：$3 / 1M 存为 `3000000`，$0.075 / 1M 存为 `75000`。
- 单次请求的费用 = Σ(各类 token 数 × 对应单价)，整数相乘求和后再 ÷ 1,000,000，最后**一次**四舍五入到 micro-USD（不对每一类分别取整）。

### 用量口径

token 数直接用 Bifrost 归一化后的 `BifrostLLMUsage`。**Bifrost 已经把各家统一成 OpenAI 的「包含式」口径**（下面的结论读自 `maximhq/bifrost` 提交 `ee74424`）：

- **`PromptTokens` 包含缓存读取和缓存写入。** Anthropic 原始的 `input_tokens` 不含缓存，Bifrost 会把 `cache_read_input_tokens` 和 `cache_creation_input_tokens` 加进去（`core/providers/anthropic/chat.go`；流式时在流结束后由 `normalizeCachedUsage` 补加一次，中途取消也会补）。OpenAI 和 Gemini 原本就是包含式。
- **`CompletionTokens` 包含思考 token。** Gemini 原始的 `candidatesTokenCount` 不含 `thoughtsTokenCount`，Bifrost 会把它加进去（`core/providers/gemini/utils.go`）。OpenAI 原本就包含。
- 缓存读取在 `PromptTokensDetails.CachedReadTokens`，缓存写入在 `CachedWriteTokens`，其中 1 小时的那部分在 `CachedWriteTokenDetails.CachedWriteTokens1h`。

所以我们的换算很直接：

| 计费口径 | 公式 |
| --- | --- |
| `input`（没命中缓存的输入） | `PromptTokens − CachedReadTokens − CachedWriteTokens` |
| `cache_read` | `CachedReadTokens` |
| `cache_write_1h` | `CachedWriteTokens1h` |
| `cache_write_5m` | `CachedWriteTokens − CachedWriteTokens1h` |
| `output`（含思考） | `CompletionTokens` |

这和 Bifrost 自己算费用的公式（`framework/modelcatalog/datasheet/cost.go` 的 `computeTextCost`）完全一致：它也是 `PromptTokens` 减去两种缓存后乘输入单价，缓存读取、5 分钟写入、1 小时写入各乘各的单价，`CompletionTokens` 乘输出单价，长上下文阶梯按 `PromptTokens` 选档（100K / 128K / 200K / 272K）。缓存数大于总数这类异常数据，它会先截断，避免算出负数，我们照做。

- 我们不直接用它算出来的 `Cost`，原因只有两个：它是 `float64`；单价来自它的价格目录，不是我们的售价。公式照搬，换成我们的价格表和整数运算。
- Bifrost 返回的 usage 对象原样存进 `usage_events.raw_usage`（只有数字，没有内容）。出了争议，可以用它加价格版本重新算一遍。
- 上面的结论属于 Bifrost 的内部行为，升级时可能变。所以每种上游各录一组真实响应作为**回归样本**（普通、缓存命中、缓存写入 5 分钟 / 1 小时、思考、流式与非流式、中途断开），断言 Bifrost 给出的数字。升级 Bifrost 前必须先跑一遍。

### 一次请求的资金流程

**开始（一个事务）**
1. 生成 `request_id`（UUIDv7），插入一条 `status = pending` 的 `usage_events`，记下这次的价格版本 `price_id`。
2. 计算**预扣额**：按请求体大小估算输入 token × 输入单价，加上（请求里的 `max_tokens`，没有就用模型的最大输出）× 输出单价，再受模型的 `max_reserve_micros` 封顶。
3. 可用余额 = `amount_micros − held_micros`。小于预扣额就返回 402；否则 `held_micros += 预扣额`。

**结束（一个事务）**
1. 把 `usage_events` 更新成终态，写入用量、费用、`raw_usage`。
2. 写一条 `kind = usage` 的流水（`ref = request_id`，唯一约束保证只扣一次）。
3. `amount_micros −= 实际费用`，`held_micros −= 预扣额`，更新 `usage_daily`。

实际费用超过预扣额时照扣，余额可能变成负数，但幅度受预扣额封顶和并发上限限制；余额为负的用户后续请求一律返回 402。

**各种结局怎么收费**

| 结局 | `status` | 收费 |
| --- | --- | --- |
| 正常完成 | `completed` | 按上游用量 |
| 上游在输出任何内容之前就失败（所有候选渠道都试过） | `failed` | 不收，解冻 |
| 客户端中途断开 | `aborted` | 上游给了用量就按上游的；没给的部分用分词器按已转发的输出估算，`usage_source = estimated` |
| 已经开始输出后上游出错 | `failed` | 同「客户端中途断开」 |
| 进程崩溃，结束事务没写成 | `lost` | 不收，解冻，告警 |

- **失败切换只发生在第一个字节发给客户端之前。** 已经开始输出就不能换渠道，两段输出拼不到一起。
- 结束事务写失败（比如数据库短暂不可用）时，在进程内按退避重试；进程挂了，就由下面的回收任务接手。
- **回收任务**：启动时和之后每分钟一次，扫描 pending 超过 35 分钟（比单次请求上限 30 分钟多一点）的记录，标成 `lost` 并解冻。

**渠道成本单独记**：每一次上游尝试（包括失败切换前失败的那次）写一条 `usage_attempts`，包含渠道、这次尝试的用量和按成本价算出的成本。用户只为结果付费，我们自己的成本另记一笔，用于核对上游账单和统计毛利。

### 价格表

- **`price_book` 带生效时间**：每次请求按开始时生效的价格扣费（`price_id` 记在请求上），扣完不再重算。这和桌面端本地「使用统计」的做法相反：桌面端每次按当前价格重算，因为那只是估算；这里是向用户收的钱。
- 价格只增不改：修改价格就是新增一行，旧行永远保留，历史请求都能按原价复算。
- **`usage_daily`** 按 **UTC** 切日，控制台的图表都查这张表，不扫明细表。页面上标明日期是 UTC，不按用户时区重切。

### 自动核对（每天跑，对不上就告警，不自动修正）

1. 每个用户：`balances.amount_micros` = 他所有流水之和。
2. 每个用户：`balances.held_micros` = 他所有 pending 请求的预扣额之和。
3. 每条终态且收费的 `usage_events` 恰好对应一条 `usage` 流水，反之亦然。
4. 用 `raw_usage` + `price_id` 重新计算的费用，等于记录下来的 `cost_micros`。
5. 每个渠道每天的成本（`usage_attempts` 汇总），和上游厂商的用量或账单接口对比，偏差超过 2% 告警。

### 充值方式

- **第一期**：兑换码（`redeem_codes`）和后台手动入账。兑换在一个事务里完成：锁定兑换码那一行 → 确认未使用、未过期 → 标记已用 → 写流水 → 加余额。
- **新用户试用额度（后续再做）**：首次登录时写一条 `kind = grant` 的流水，`ref` 填 `signup`，每个用户只发一次，靠 `ledger_entries` 的 `UNIQUE (user_id, kind, ref)` 保证。可以按 GitHub 账号的注册时长限制谁能领。账本已经支持 `grant` 类型，到时候不用改表结构。

### Creem（后续）

- 充值做成固定档位的一次性商品（例如 $5 / $20 / $100）。`orders` 表记录 `checkout_id`、金额和状态。
- Webhook 必须校验签名（算法以 Creem 文档为准），并按事件 id 去重（同样靠 `UNIQUE (user_id, kind, ref)`）。支付完成时写一条正数的 `ledger_entries`；退款时写一条负数的。
- 以 webhook 为准，不以浏览器跳回的成功页为准。另外每天调一次 Creem 的接口，把订单状态和本地对一遍。
- Creem 是 merchant of record，税务由它处理。我们的账本只记到账金额。

## 控制台

| 页面 | 内容 | 接口 |
| --- | --- | --- |
| 概览 | 余额、本月消费、近 30 天消费趋势图、按模型的占比 | `GET /api/billing/balance`、`GET /api/usage/summary?from&to&group_by=day\|model\|device` |
| 用量明细 | 按时间 / 模型 / 设备筛选的请求列表，导出 CSV | `GET /api/usage/events?cursor&...` |
| 账单 | 资金流水（充值、消费、兑换），兑换码输入框 | `GET /api/billing/ledger`、`POST /api/billing/redeem` |
| 价格 | 各模型单价，不登录也能看 | `GET /api/pricing` |
| 设备 | 登录着的浏览器和设备，可逐个登出 | `GET/DELETE /api/sessions` |
| 账号 | GitHub 头像、用户名、邮箱，退出登录 | `GET /api/me`、`POST /api/auth/logout` |

界面中英双语，沿用官网现有的 `messages/` 和 next-intl。

## 管理后台

Bifrost 自带的网页管理界面属于它的 HTTP 网关，只有把 Bifrost 当独立服务运行时才有。我们只嵌入它的 core，所以没有这个界面。即使单独跑一个 Bifrost 网关来用它的界面，渠道配置也会分成两份：它的 configstore 一份，我们的计费和模型目录一份。所以模型、上游、兑换码、用户都在我们自己的后台里管，Bifrost 只负责按我们给的配置去调上游。

后台和控制台在同一个 Next 应用里，放在 `/<locale>/admin`。只有 `users.role = 'admin'` 的用户能进；第一个管理员由环境变量 `ADMIN_GITHUB_IDS` 在登录时授予。接口都在 `/api/admin/*` 下，要求 cookie 会话、管理员角色和同源 `Origin`，每次修改都写 `audit_log`。

### 三个概念

| 概念 | 是什么 | 例子 |
| --- | --- | --- |
| **渠道**（channel） | 一个上游账户：类型、地址、一组 key | 「OpenAI 官方」、「Anthropic 官方」、「某个 OpenAI 兼容中转」 |
| **模型**（model） | 对用户公开的模型：`/llm/v1/models` 列出的 id、名称、参数和价格 | `gpt-5.5`、`claude-sonnet-4-5` |
| **路由**（route） | 一个公开模型由哪些渠道提供、在上游叫什么名字、按什么顺序切换 | `claude-sonnet-4-5` → 先走 Anthropic 官方，失败再走中转 A |

把渠道和模型分开，同一个模型就能挂多个渠道做失败切换和负载分担，渠道上游的模型名也可以和对外公开的名字不一样。

### 和 Bifrost 的对接

- 我们实现的 `Account` 从内存快照里回答「有哪些 provider」「某个 provider 有哪些 key」「它的网络配置是什么」。快照从 `channels`、`channel_keys` 加载。后台每次修改后通过 Postgres `LISTEN/NOTIFY` 通知各实例重新加载。
- 每个渠道对应一个 Bifrost provider。官方渠道用 Bifrost 的内置类型（openai、anthropic、gemini…）；OpenAI 兼容的中转用 Bifrost 的自定义 provider，基于 openai 类型，填上我们自己的 `base_url`。
- 请求进来后，先在我们自己的代码里按 `model_routes` 选出渠道：按优先级排序，同一优先级内按权重随机，跳过近期连续失败的渠道。然后把选中的 provider、上游模型名和其余候选（作为 Bifrost 的 `Fallbacks`）一起交给 Bifrost 发请求。
- **运行中改配置**（原型验证第 6 项）：Bifrost 每次请求都会向 `Account` 要 key，所以 key 的变化应该会立即生效；provider 级别的配置（base_url、代理、请求头）可能需要调它的更新接口，或者重建 client。

### 后台页面

| 页面 | 内容 |
| --- | --- |
| 渠道 | 列表与健康状况（近一小时的请求数、错误率、延迟）；新增、编辑、启用、停用；「测试连接」：拉一次上游的 `/models`，再发一个 1 token 的请求；key 可以有多个，各带权重 |
| 模型 | 公开模型目录：id、名称、默认协议、上下文、最大输出、输入模态、思考强度、是否对用户可见、排序。新增时可以从 models.dev 快照预填参数。路由表在同一页编辑 |
| 价格 | 每个模型的售价，同一页也能填渠道成本价。修改价格是新增一行 `price_book`，可以立即生效，也可以定时生效，历史价格保留 |
| 兑换码 | 批量生成（金额、数量、有效期），导出，作废；查看使用记录 |
| 用户 | 按 GitHub 用户名或邮箱搜索；查看余额、用量、会话；手动入账或调账（写 `ledger_entries`，必须填原因）；停用账号 |
| 总览 | 按天、模型、渠道统计收入、成本和毛利 |

### 凭据

- 上游 key 用 AES-256-GCM 加密后存进 `channel_keys.key_enc`，加密密钥来自环境变量（以后可以换 KMS），不进数据库。
- 接口和页面**永远不回显完整 key**，只显示后四位。编辑时 key 是「只写」字段：留空表示不改。

### 在后台页面做好之前

P0 的原型和 P1 阶段，用一个 YAML 种子文件（`deploy/seed.yaml`）写入渠道和模型，由 `cloud seed` 命令导入数据库。后台页面在 P2 和 `/llm` 正式接入一起做。

## 数据库表（cloud 库）

```sql
users            (id, role DEFAULT 'user', github_id bigint UNIQUE, github_login, avatar_url, github_created_at,
                  email NULL, email_verified_at NULL,   -- 只存 GitHub 已验证的主邮箱；已验证邮箱加部分唯一索引
                  created_at, disabled_at)
sessions         (id, user_id, token_hash UNIQUE, kind, device_name, platform,   -- kind: web | desktop | mobile
                  user_agent, ip, created_at, last_used_at, expires_at, revoked_at)
oauth_codes      (code_hash, user_id, client_id, redirect_uri, code_challenge, expires_at)  -- 桌面端授权码，延后

channels         (id, name, provider_type, base_url, headers jsonb, proxy_url, enabled, created_at)
channel_keys     (id, channel_id, key_enc bytea, key_last4, weight, enabled, last_error, last_error_at)
models           (id text PRIMARY KEY, display_name, default_api, context_window, max_output,
                  input_modalities text[], thinking_levels text[], max_reserve_micros bigint, visible, sort_order)
model_routes     (model_id, channel_id, upstream_model, priority, weight, enabled,
                  PRIMARY KEY (model_id, channel_id))
price_book       (id, model, effective_from, input, output, cache_read, cache_write_5m, cache_write_1h,
                  tiers jsonb)                           -- 只增不改；售价
channel_costs    (id, channel_id, upstream_model, effective_from, input, output, cache_read,
                  cache_write_5m, cache_write_1h, tiers jsonb)   -- 渠道成本价，只用于核对与毛利

usage_events     (id, request_id uuid UNIQUE, user_id, session_id, model, price_id, channel_id,
                  status,          -- pending | completed | failed | aborted | lost
                  usage_source,    -- upstream | estimated
                  input_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
                  output_tokens, reasoning_tokens,   -- reasoning 只用于展示，已经包含在 output 里
                  raw_usage jsonb, reserve_micros bigint, cost_micros bigint,
                  attempts, ttfb_ms, latency_ms, started_at, finished_at)
usage_attempts   (request_id, attempt, channel_id, upstream_model, status, raw_usage jsonb,
                  cost_micros bigint, PRIMARY KEY (request_id, attempt))
usage_daily      (user_id, day, model, session_id, requests, input_tokens, cache_read_tokens,
                  cache_write_tokens, output_tokens, cost_micros, PRIMARY KEY (user_id, day, model, session_id))

ledger_entries   (id, user_id, kind, amount_micros bigint, ref, note, created_by, created_at,
                  UNIQUE (user_id, kind, ref))   -- kind: usage | redeem | grant | topup | refund | adjust
                                                 -- ref: usage→request_id，redeem→兑换码 id，topup/refund→Creem 事件 id，grant→signup
balances         (user_id PRIMARY KEY, amount_micros bigint, held_micros bigint, updated_at)
redeem_codes     (id, code_hash UNIQUE, amount_micros, created_by, used_by, used_at, expires_at)
orders           (id, user_id, provider, checkout_id UNIQUE, amount_micros, status, created_at)  -- Creem，延后
audit_log        (id, user_id, action, ip, user_agent, meta jsonb, created_at)
```

## 客户端配置下发（随桌面端改造一起做）

`GET /api/client-config?app=desktop&version=&platform=&channel=` 不需要登录，可以被 CDN 缓存。内容包括：

- 内置供应商的 `baseUrl`、默认协议、余额查询方式（`gateway`）、官网链接；
- 模型列表，参数来自 `models` 表，单价来自 `price_book`，所以桌面端的估算和实际账单一致；
- `defaultModel`、`defaultThinking`，在管理后台设置（到时候加一个「客户端配置」页）。

两道保护：

1. **签名**：配置用 Ed25519 签名，公钥打包进 App，预埋两把以便轮换。签名校验不过的配置直接丢弃。
2. **主机白名单写在桌面端代码里**：`baseUrl` 必须是 https，主机名必须在白名单内。

## 官方隧道（后续）

- 用独立根域名的子域名 `<id>.fastvibe.link`，并提交到 Public Suffix List。
- **不用 `app.fastvibe.dev/tunnel/<id>` 这种子路径**，原因有四个：
  1. 隧道页面和账号站同源，任何注册了隧道的人都能在这个源下执行 JS：带着访问者的登录 cookie 调 `/api`，还能读 localStorage 里其他隧道的设备令牌。
  2. 远程客户端写死了绝对路径 `/api/login` 和 `/api/hello`，会和本服务的 `/api` 撞上。
  3. 手机端添加电脑时只按源保存，会丢掉路径。
  4. 钓鱼页被浏览器拉黑时，连累的是主站。
- 实现：frps 的 HTTP vhost（`subdomainHost = "fastvibe.link"`）+ 泛域名证书；鉴权由 frps 的 server plugin 回调 cloud 的内部接口，校验 token 并确认子域名的归属。

## 桌面端改造清单（服务端和官网完成之后）

- `FASTVIBE_API_BASE`（`src/main/engine/providers.ts`）改由客户端配置下发；`normalizeFastVibe` 改成「配置优先，代码兜底」。
- `PROVIDERS_VERSION` 升到 3：等于旧默认值的 `api` 视为未选；老用户的 sub2api key 迁成一个自定义供应商，地址保留 `fastvibe.dev/v1`。
- 余额查询方式新增 `fastvibe` 类型，读 `/api/billing/balance`。
- `src/main/engine/cc-switch.ts` 的 `isFastVibeGateway` / `normalizeUrl` 目前把任何 `*.fastvibe.dev` 都当成内置网关，要改成按具体主机名区分。
- 新增 `account:*` 方法，要在 `server/policy.ts` 里分类：登录会在宿主机上打开浏览器，应拒绝远程调用。
- 供应商详情页的「访问」链接（`provider-detail.tsx`）改到新官网。

## 部署与运维

- **服务器**：一台海外 VPS 起步（服务对象和计费都面向海外，美元结算，不涉及国内备案）。外层 nginx（已有）、cloud、website、Postgres 都在这台机器上，cloud 和 Postgres 用 docker compose，website 单独打包；流量上来以后，先把 Postgres 换成托管数据库，cloud 再横向扩容。服务本身无状态，会话令牌的缓存允许最多 30 秒不一致，多实例不需要粘性会话。
- **发布**：GitHub Actions 构建 cloud 和 website 的镜像，推到 GHCR；服务器上 `docker compose pull && up -d`。数据库迁移由 cloud 启动时执行（goose），只做向前兼容的迁移，新版本先迁移、再切流量。
- **备份**：Postgres 每天全量备份并保留 30 天，WAL 归档到对象存储，支持按时间点恢复。账本是钱，备份必须定期演练恢复。
- **监控**：`/api/healthz`（进程存活）和 `/api/readyz`（数据库可连、渠道快照已加载）；zap 输出 JSON 日志，每行带 `request_id`，和响应头 `X-Request-ID`、错误体里的 `request_id` 是同一个；Prometheus 指标包括请求数、错误率、首字节延迟、各渠道失败率、计费写入队列长度。计费队列积压或写入失败要告警。
- **环境变量**：

配置有三层，后面的覆盖前面的：内置默认值 → YAML 文件（`-config` 或 `FASTVIBE_CONFIG`，完整示例在 `deploy/cloud.example.yaml`）→ 环境变量。环境变量名是 `FASTVIBE_` 加上配置路径的大写，层级之间用**双下划线**，例如 `database.url` 对应 `FASTVIBE_DATABASE__URL`。密钥只放环境变量，不放文件。启动时一次报出所有配置错误，而不是等某个请求碰到才发现。

| 变量 | 用途 |
| --- | --- |
| `FASTVIBE_PUBLIC_ORIGIN` | `https://app.fastvibe.dev`，用于 `Origin` 校验和 OAuth 回调地址 |
| `FASTVIBE_DATABASE__URL` | Postgres 连接串 |
| `FASTVIBE_HTTP__TRUSTED_PROXIES` | 外层 nginx 的地址，逗号分隔；容器内看到的是 compose 网络的网关地址 |
| `FASTVIBE_ENV` / `FASTVIBE_LOG__LEVEL` / `FASTVIBE_LOG__FORMAT` | 运行环境、日志级别、日志格式 |
| `FASTVIBE_GITHUB__CLIENT_ID` / `FASTVIBE_GITHUB__CLIENT_SECRET` | GitHub OAuth App（P1） |
| `FASTVIBE_ADMIN__GITHUB_IDS` | 管理员的 GitHub 数字 id，逗号分隔（P1） |
| `FASTVIBE_CHANNELS__KEY_SECRET` | 上游 key 的 AES-256-GCM 加密密钥（32 字节，base64）（P2） |
| `FASTVIBE_CLIENT_CONFIG__SIGNING_KEY` | 客户端配置的 Ed25519 私钥（P3） |

后四项是各阶段才会加进配置结构的，现在的服务还不认识它们。

- **数据保留**：`usage_events` 和 `ledger_entries` 长期保留（账务记录）。先不分区：Postgres 分区表的唯一约束必须包含分区键，`request_id` 的全局唯一就保证不了。数据量真大到需要分区时（千万行以上），先把唯一性完全交给不分区的 `ledger_entries` 再动手；过期和已吊销的 `sessions` 保留 90 天后删除；`audit_log` 保留 1 年。

## 法务

收钱之前（P4 接 Creem 之前）官网要有服务条款和隐私政策，Creem 开通收款时也会检查。隐私政策的核心内容：通过 GitHub 获取哪些数据（id、用户名、头像、已验证邮箱）；不存储请求内容；请求会转发给哪些上游模型厂商；用户可以申请删除账号（账务记录按法律要求保留）。

## 测试

- Go 单元测试覆盖纯逻辑：计费金额计算（整数运算、阶梯价选档、四舍五入）、路由选择、`return_to` 校验、错误格式转换。
- **用量回归样本**：每种上游、每种情况（普通、缓存命中、缓存写入 5 分钟 / 1 小时、思考、图片输入、工具调用、流式与非流式、中途断开）各录一份真实响应，断言 Bifrost 给出的用量和换算出的五个数。升级 Bifrost 前必须先跑一遍。
- 集成测试用 testcontainers 起真实 Postgres，覆盖：结算重复执行不重复扣费、并发请求下的预扣和余额、预扣不足返回 402、兑换码并发兑换只成功一次、会话吊销。
- **故障注入**：流式输出到一半杀掉进程（重启后回收任务把它标成 `lost` 并解冻）；结算时数据库断开（重试后只扣一次）；上游在首字节前失败（切换渠道且不收费）、首字节后失败（按已产生的用量收费）。
- 每次跑完测试，都执行一遍「自动核对」的五条检查，作为测试的最后一步断言。
- `/llm` 的协议测试用录制好的上游响应（流式和非流式，各协议各一套）回放，不打真实上游；原型阶段那六项验证用真实上游跑一次，结论写回本文。

## 阶段

| 阶段 | 内容 |
| --- | --- |
| P0 | `services/cloud` 骨架（Fiber、zap、koanf）、compose、迁移、nginx 片段；Bifrost 原型验证（「动手前的原型验证」里的六项） |
| P1 | GitHub 登录、会话令牌、会话管理；官网加登录页和控制台框架。**已完成**（官网自建部署的镜像和 Jenkins 流水线还没做） |
| P2 | `/llm` 正式接入：鉴权插件、计量写入、渠道路由；管理后台（渠道、模型、价格、兑换码、用户）；控制台的概览、明细、账单、价格页 |
| P3 | 桌面端改造（上一节清单）与客户端配置下发 |
| P4 | Creem 支付；新用户试用额度 |
| P5 | 官方隧道 |

## 待定

- 新用户试用额度给多少、GitHub 账号注册满多久才能领。
- VPS 放在哪个厂商、哪个地区（影响到上游厂商的延迟，以及国内用户的访问速度）。
- 请求内容是否完全不存（本文默认不存）。如果以后要做「对话审计」或排查质量问题，需要另外设计，并改隐私政策。
