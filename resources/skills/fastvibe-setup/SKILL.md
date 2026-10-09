---
name: fastvibe-setup
description: 帮用户配置 FastVibe 客户端自身的功能——远程访问（局域网密码、账号发现）、MCP 服务器、界面与对话设置。用户说「帮我打开远程访问 / 手机怎么连这台电脑 / 加一个 MCP」之类时使用。
---

# 配置 FastVibe 自身

你运行在 FastVibe 桌面客户端里。`fastvibe_config_get` / `fastvibe_config_apply` 调用的是设置页本身用的同一批方法：你写进去的值会立刻出现在用户打开的设置页上，和用户自己点的一样。需要动另一台机器时，用你平常的 `bash` + `ssh`。

## 通用流程

1. **先看现状**：`fastvibe_config_get({ action: "overview" })`。返回里的 `actions` 是完整的动作目录（每个动作的读/写类型和 input 字段），其余是当前状态。不要凭记忆猜字段。
2. **说清楚要做什么，再动手**：列出要改的东西（客户端里填哪些表单、外部要装什么），缺的信息一次问齐。
3. **做外部那一半**（如果有），每一步都验证。
4. **填表单**：`fastvibe_config_apply`。每次写入前先说清楚要改什么。
5. **验证并交付**：读回状态，确认真的通了，把结果和下一步告诉用户。

### 硬规则

- **远程访问密码绝不经过对话。** 调 `remote.set_password`（input 为空），由用户在弹出的输入框里填。不要让用户把密码发给你，也不要自己编一个。
- **供应商 API Key 不走这里。** 让用户去 设置 → 供应商 自己粘贴。
- 一个动作失败时，把 `error` 原文和你的判断告诉用户，不要换个参数反复重试同一件事。

---

## 远程访问

打开远程访问（`remote.start`）会同时打开两条路，各有各的前提，缺哪个就只开另一个，不算失败：

- **官方连接**：需要这台电脑登录了 FastVibe 账号。用同一个账号登录的手机会自动发现这台电脑，不需要密码，也不需要用户做任何网络配置——能直连就直连（局域网内、跨 NAT），直连不通才经 FastVibe 中转。
- **局域网地址**：需要先设置密码（`remote.set_password`，由用户在输入框里填）。设置后用户可以开「允许局域网访问」，手机在同一 Wi‑Fi 下用地址 + 密码登录，或者在「附近的电脑」里发现。

用法：

1. `remote.status` 看现状：`official.status`（`signed-out` 表示还没登录账号，`online` 表示手机已经能发现）、`configured`（是否设了密码）、`running`（局域网监听是否在跑）。
2. 想让手机自动发现：确认 `official.status` 不是 `signed-out`。没登录就请用户点侧栏左下角的账号图标登录，**不要**绕过。然后 `remote.start`。
3. 想用地址 + 密码：先 `remote.set_password`，再 `remote.start`；需要局域网内访问时，请用户在 设置 → 远程访问 里打开「允许局域网访问」。
4. 验证：`remote.status`，`official.status === "online"`（官方连接）或 `running === true`（局域网）。`official.peers` 是已连接的手机，每个带 `path`：`direct` 直连，`relay` 经 FastVibe 中转（中转计入账号的月度中转流量）。
5. `remote.stop` 同时关掉两条路。

FastVibe 不再内置 cloudflared / ngrok / frp 这类内网穿透。用户想让互联网上的浏览器直接访问，需要自己在前面放反向代理，这不是这个应用配置的范围。

## MCP 服务器

用 `mcp.upsert` 一次加或改一个，不会影响其他服务器：

```json
{ "action": "mcp.upsert", "input": { "server": {
  "id": "github", "name": "GitHub", "transport": "stdio",
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<用户提供>" }
} } }
```

HTTP 型：`"transport": "http", "url": "https://…/mcp"`。写完用 `mcp.list` 看 `connected` 和 `error`；stdio 型连不上时，先在 bash 里直接跑一遍 `command args` 看报错。

## 界面与对话设置

`settings.get` 读当前值，`settings.set { patch: { … } }` 只写要改的键。远程访问（`remote*`）、代理（`proxy*`）的键会被拒绝：远程访问用上面的 `remote.*` 动作，代理请用户在界面里改。
