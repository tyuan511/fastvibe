# 本地 GitHub App 配置

本技能随仓库保存 CLI，凭据由每台执行机器单独配置。当前 App 为 `fastvibe-review`，App ID `5578494`，安装 ID `177798655`，仅安装到 `tyuan511/fastvibe`；这些标识不是密钥。使用 `status` 验证实时状态，不把本文件当作授权证明。

## 目录与配置

CLI 固定从 `~/.config/fastvibe/github-review/config.json` 读取配置，与当前工作目录无关。配置示例：

```json
{
  "appId": 5578494,
  "installationId": 177798655,
  "appSlug": "fastvibe-review",
  "owner": "tyuan511",
  "repository": "fastvibe",
  "baseBranch": "main",
  "privateKeyPath": "/实际用户主目录/.config/fastvibe/github-review/private-key.pem"
}
```

`privateKeyPath` 填真实绝对路径，JSON 中的 `~` 和 `$HOME` 不会自动展开。私钥通过用户在本机提供的文件复制，不能要求粘贴私钥到聊天。

```bash
mkdir -p "$HOME/.config/fastvibe/github-review"
chmod 700 "$HOME/.config/fastvibe/github-review"
# config.json 与 private-key.pem 已由用户提供并写入后：
chmod 600 "$HOME/.config/fastvibe/github-review/config.json" "$HOME/.config/fastvibe/github-review/private-key.pem"
```

配置不存在时先说明缺少的项。不要从下载目录猜私钥，不扫描或打印其他凭据，不在这个项目里保存配置或私钥。

## App 权限

| Repository permission | 安装授权 | 用途 |
| --- | --- | --- |
| Metadata | Read | 仓库基本信息 |
| Contents | Write | 读源码与合并 PR；GitHub 没有独立的仅合并权限 |
| Pull requests | Write | 行内评论、正式 review |
| Checks | Write | 读取 checks；为后续发布 Check Run 预留，当前 CLI 未实现发布 |
| Commit statuses | Read | 传统 CI 状态 |
| Actions | Read | 工作流信息读取 |

当前 CLI 的通用读取令牌会请求 Actions/Checks/Contents/Pull requests/Statuses 的只读权限，安装缺少这些权限时可能被 GitHub 拒绝。发布 review 只提高 Pull requests 权限，合并只提高 Contents 权限。

使用 installation token，无需用户 OAuth Callback。当前为本地按指令触发，Webhook 关闭。未经用户要求，不增加安装仓库或权限，不配置 Webhook，也不设置 App 绕过分支规则。

## 认证与故障

- CLI 用 RSA 私钥签署短期 JWT，以 `Authorization: Bearer` 请求单仓库 installation token。直接把 JWT 当作 `GH_TOKEN` 交给 gh 的默认认证路径，可能得到 `HTTP 401: A JSON web token could not be decoded`；不要据此判断私钥已坏或反复生成新私钥。
- `status` 会校验 App ID、slug、installation 所属账号与暂停状态，并显示仓库和权限；不输出 token。
- installation token 只存当前 CLI 进程内存，命令结束时尝试撤销。撤销因网络故障失败时会明确提示，令牌仍按 GitHub 返回的到期时间失效。
- HTTP 401：检查系统时间、App 标识、私钥与 Bearer 认证；HTTP 403/404：检查安装范围、授予权限及仓库/PR 是否存在。只报告错误和非敏感元数据。
- 不能通过个人账号补发 bot 审核。修复配置后重新验证，避免审核身份与授权范围发生变化。

## 本机已验证的能力

本会话已经用 `fastvibe-review[bot]` 向 PR #2 发布正式 Request changes 与 5 条行内评论，并定向处理了旧个人审核。该事实说明 review 写接口已验证，不代表未来 PR 已通过审查。

当前尚未实际验证合并写接口，也未实现 Check Run 发布、Webhook 或无人值守调度。CLI 的 `--dry-run` 只验证预检条件，不发布、合并或创建检查。
