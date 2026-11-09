# Vivi 的 GitHub App 认证（M11 前置，隔离实现）

状态：**[github-app-auth.ts](../src/main/bot/shadow/github-app-auth.ts) 已实现并通过离线回归；没有任何生产 Runtime、IPC、settings 或凭据文件引用它。** 本文记录 2026-11-09 逐条查证的平台语义、身份绑定的设计决定，以及接入部署与设置页之前的剩余工作。

## 为什么需要它

M11 的受控 Review/Merge 需要一个与 writer 不同的 GitHub 身份。GitHub App 的 bot 账号（`{slug}[bot]`）是产品形态上最合适的选择：安装即可用、可随时撤销、权限可收敛到单个仓库。现有 [github-native-operation.ts](../src/main/bot/shadow/github-native-operation.ts) 的 writer/reviewer 双身份合同不需要放宽，reviewer 从用户 PAT 换成 App bot 时领域层不变。

## 已验证的平台语义（2026-11-09 查证）

来源：docs.github.com 的 REST OpenAPI 规范（`github/rest-api-description`）与渲染后的端点页，逐条核对：

| 端点 | 语义 |
| --- | --- |
| `GET /user` | **installation token 不可用**（`enabledForGitHubApps: false`）。现有 PAT 式写入时 `/user` 反射对 App 凭据不存在。 |
| `GET /app` | 仅接受 App JWT；文档明写 "You must use a JWT… does not work with GitHub App installation access tokens"。 |
| `GET /users/{login}` | installation token 可用；bot 账号页返回稳定数值 `id` 与 `{slug}[bot]` login。 |
| `POST /app/installations/{id}/access_tokens` | App JWT 认证；token 一小时过期；body 可带 `repositories` 收敛范围。 |
| `GET /app/installations` | App JWT 认证，枚举安装。 |
| `POST /app-manifests/{code}/conversions` | 无认证、有限流；`code` 一小时有效；201 返回 App `id`、`slug`、`pem`、`webhook_secret`、`client_id`、`client_secret`。 |
| manifest 流程 | 表单 POST `manifest` 参数到 `github.com/settings/apps/new` → GitHub 跳回 `redirect_url?code=…` → 用 code 调 conversions 换取配置。三步须一小时内完成。 |

## 身份绑定设计

PAT 的防线是"写入前用同一 secret 读 `/user` 核对账号"。installation token 没有等价的反射端点（上表前两行），因此绑定移到 **mint 时**：

1. `resolveAppPrincipal()` 用 App JWT 调 `GET /app`，校验私钥真的属于配置的 App ID，核对 slug；
2. 再用公开的 `GET /users/{slug}[bot]` 发现 bot 账号的数值 id 与 login——这正是 review 行里 `user.id` / `user.login` 记录的值，与 `reviewMatches()` 的比较兼容；
3. 结构性保证补足剩余部分：installation token 只能以其所属 App 的 bot 身份行动，不可能"写错账号"；
4. 仓库级绑定不需要新增检查——operation preflight 的仓库读取本来就经同一 transport、同一 secret。

由此 `reviewerIdentity = { id: botUserId, login: "{slug}[bot]" }`，构造期的 `botLogins`/`selfLogins` fence 原样生效（`{slug}[bot]` 天然命中 Source 的 bot 判定）。

## 模块 API

```ts
createAppJwt(appId, privateKeyPem, now?)                     // RS256，9 分钟，≤10 分钟上限
convertManifestCode({ code, origin?, loopbackTest? })        // manifest 第三步，无认证
buildAppManifest({ name, homepage, redirectUrl, permissions, ... }) // manifest 第零步，纯函数
resolveAppPrincipal({ appId, privateKeyPem, expectedSlug? }) // mint 时身份校验 + bot 发现
listInstallations({ appId, privateKeyPem })                  // App JWT 认证的安装枚举（窄视图）
new GithubAppInstallationCredentials({ appId, privateKeyPem, installationId,
  repositories?, expectedSlug?, now? })                      // CredentialResolver：按需 mint、
                                                             // 过期前 5 分钟刷新、并发共享单次 mint
// github-app-setup.ts
beginGithubAppSetup({ manifest, expectedState?, timeoutMs? }) // loopback 回调服务器：redirect_url 由
                                                              // 端口生成，state 校验，completed 换取配置
saveGithubAppCredential(file, record) / loadGithubAppCredential(file) // 0600 原子读写，同 remote-access 边界
organizationRegistrationAction(org)                           // 组织账号的注册入口
```

- `GithubAppInstallationCredentials` 直接 `register()` 进 `ShadowCredentialHost` 并 `bind()` 到 reviewer Source；transport 拿到的仍是一个 Bearer 字符串，仓库外路径白名单**不需要放宽**（mint 与身份发现走 resolver 自己的 fetch，不经过仓库 transport）。
- origin 门禁与 [github-transport.ts](../src/main/bot/shadow/github-transport.ts) 一致：默认 `https://api.github.com`；`http://127.0.0.1` 仅显式 `loopbackTest`。
- 错误信息只含状态码与远端 `message`，不含 token/PEM。

离线验证（真实 RSA 密钥 + loopback HTTP，不访问真实 GitHub）：`node --test test/dsh-github-app-auth.test.ts`，**10/10 通过**。覆盖 JWT 签名与有效期、manifest 交换（含数值 id、可空 webhook secret、404 过期）、mint 时身份校验与拒绝、token 缓存/margin 重发/失败重试、CredentialHost 集成、origin 门禁。另有一次测试设计失误意外打到真实 `api.github.com` 并得到 401（JWT 结构可被解析但不属于任何 App）——该结果不作为证据，测试已改为纯离线门禁。

## 接入前剩余工作

1. ~~**operation adapter 的 principal 模式**~~：已实现。transport 新增 `principalMode: "user" | "github-app"`（构造期校验）：`github-app` 模式下写入前不再读 `/user`，adapter 的 `identity()` 对该模式的 transport 跳过 preflight `/user`，仓库 preflight 仍经同一 transport 与 secret 执行；默认 `user` 模式行为不变（专项回归：app 模式全程零 `/user` 请求、非法模式值构造期拒绝）。
2. **设置页 manifest 一键安装**：shadow 层流程已实现（[github-app-setup.ts](../src/main/bot/shadow/github-app-setup.ts)）：`buildAppManifest` 构造表单 manifest（redirect_url 由回调端口自动生成）、`beginGithubAppSetup` 起 `127.0.0.1` 回调服务器（state 校验、超时/取消、`completed` 兑换配置）、`saveGithubAppCredential`/`loadGithubAppCredential` 以 0600 原子写读独立凭据文件、`listInstallations` 供选择安装。剩余为生产接线：设置页渲染自动提交表单（POST 到 `github.com/settings/apps/new`）、userData 凭据路径选择、IPC 面板。`redirect_url` 接受 loopback 未在文档明示（Probot 本地开发是先例），需在真实注册轮确认。
3. **M11 真实验收**：真实 App 注册/安装、installation token 驱动的受控 Review 与 Merge、Issue 收束；接线时部署构造期应强制 `resolveAppPrincipal()` 成功并以返回的 bot 身份作为 `reviewerIdentity`。本文的离线证据不替代。
