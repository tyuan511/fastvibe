# App Server 协议

本文描述 FastVibe App Server v1 的公开接入协议。第三方桌面端、移动端或自动化客户端可以按本文直接连接正在运行的 FastVibe；不需要 Electron，也不需要加载 FastVibe 的网页客户端。

> 当前协议版本：`fastvibe.app` / `1`。线协议定义位于 `src/shared/app-protocol.ts`。IPC 方法名和 payload 类型位于 `src/shared/ipc.ts`、`src/shared/api.ts` 及对应 handler 中。

## 1. 连接流程

1. FastVibe 在「远程访问」中启用服务，并设置密码。
2. 客户端向 `POST /api/login` 提交密码，取得设备 token。
3. 客户端建立 `ws://host:port/ws` 或 `wss://host/ws` WebSocket。
4. WebSocket 建立后先发送旧式鉴权帧 `{ type: "auth", token }`。
5. 服务端返回鉴权结果；成功后客户端发送 App Protocol `hello`。
6. 服务端返回 `welcome`，之后才能调用 RPC 或订阅事件。

服务默认绑定 `127.0.0.1`；开启局域网访问或使用隧道后，地址可能不同。服务端不会把密码或 token 放进 `settings.json`，token 只在登录响应中明文返回，服务端磁盘只保存其哈希。

## 2. HTTP API

### `GET /api/hello`

用于判断服务是否已设置远程访问密码：

```json
{ "configured": true }
```

### `POST /api/login`

请求体：

```json
{ "password": "用户设置的密码", "label": "我的手机" }
```

`label` 可省略，默认是「远程客户端」。成功响应：

```json
{
  "token": "设备 token",
  "device": {
    "id": "设备 id",
    "label": "我的手机",
    "createdAt": 1710000000000
  }
}
```

失败响应：

- `400`：请求体不是有效 JSON；
- `401`：`{ "error": "密码错误" }`；
- `429`：尝试过于频繁，同时返回 `retryAfterMs` 和 `Retry-After`。

登录失败采用全局指数退避。客户端应尊重 `Retry-After`，不要循环猜测密码。

## 3. WebSocket 外层鉴权

连接地址：

```text
wss://example.com/ws
```

连接建立后发送：

```json
{ "type": "auth", "token": "登录得到的 token" }
```

成功：

```json
{
  "type": "auth",
  "ok": true,
  "device": { "id": "dev_xxx", "label": "我的手机" }
}
```

失败：

```json
{ "type": "auth", "ok": false, "error": "令牌无效" }
```

未在 10 秒内发送鉴权帧会关闭连接。常见关闭码：

| 关闭码 | 含义 |
| --- | --- |
| `4001` | 未鉴权、token 无效或协议被拒绝 |
| `4002` | 鉴权超时 |
| `4003` | 帧过大或附件无效 |
| `4004` | 客户端读取服务端推送过慢，触发背压保护 |

服务端每 30 秒发送一次 WebSocket Ping。客户端应使用标准 WebSocket 实现自动回复 Pong；不要因为连接空闲而主动断开。

### 浏览器客户端注意事项

服务端不提供跨域 CORS。浏览器页面应由 FastVibe 同源提供，或由自己的后端代理 `/api/login` 和 `/ws`。一个任意第三方网页不能仅靠浏览器 `fetch` 直接跨域登录 FastVibe；WebSocket 的 `Origin` 也会被服务端校验。

## 4. App Protocol v1

### 4.1 `hello`

外层鉴权成功后发送：

```json
{
  "kind": "hello",
  "hello": {
    "protocol": "fastvibe.app",
    "protocolVersion": 1,
    "client": {
      "kind": "third-party-mobile",
      "version": "1.0.0"
    },
    "capabilities": ["conversations", "engine"],
    "features": {
      "eventBatch": true,
      "binaryAttachments": true
    }
  }
}
```

`capabilities` 可省略，表示接受服务端提供的全部能力；填写后只会缩小权限，不能增加服务端没有的能力。建议第三方客户端只声明自己真正实现的能力。

服务端返回：

```json
{
  "kind": "welcome",
  "handshake": {
    "protocol": "fastvibe.app",
    "protocolVersion": 1,
    "server": {
      "serverInstanceId": "srv_xxx",
      "version": "0.14.0",
      "platform": "darwin"
    },
    "capabilities": ["conversations", "engine"]
  },
  "sessionId": "sess_xxx",
  "capabilities": ["conversations", "engine"],
  "epoch": "事件流代次",
  "features": {
    "eventBatch": true,
    "binaryAttachments": true
  }
}
```

只有 `welcome` 返回后，连接才算 ready。协议名或版本不完全匹配时，客户端应停止重试并提示升级；不要把 v2 当作 v1 解析。

当前能力名：

```text
conversations  engine  workspace  git  terminal  providers
settings       stats   imports    extensions  browser  native
```

### 4.2 调用 RPC

普通调用：

```json
{
  "kind": "call",
  "requestId": 1,
  "method": "conversations:list"
}
```

带 payload：

```json
{
  "kind": "call",
  "requestId": 2,
  "method": "engine:get-snapshot",
  "payload": { "conversationId": "conv_123" }
}
```

成功响应：

```json
{ "kind": "result", "requestId": 1, "ok": true, "result": {} }
```

失败响应：

```json
{
  "kind": "result",
  "requestId": 2,
  "ok": false,
  "error": {
    "code": "policy.denied",
    "message": "该操作只能在本机完成",
    "retryable": false
  }
}
```

`requestId` 在同一连接内必须唯一且为非负安全整数。服务端不会因为客户端本地超时而自动停止已开始的工作；如果客户端放弃等待，应发送：

```json
{ "kind": "cancel", "targetRequestId": 2, "reason": "timeout" }
```

取消只放弃该连接等待的响应，不保证中止服务端正在执行的操作。真正停止 Agent 应调用 `engine:abort`。

`query` 与 `call` 的格式相同，但不能携带 `idempotencyKey`。需要幂等的写操作使用 `call`：

```json
{
  "kind": "call",
  "requestId": 3,
  "method": "conversations:rename",
  "payload": { "id": "conv_123", "title": "新标题" },
  "idempotencyKey": "rename-conv_123-1710000000"
}
```

幂等键按设备和键名缓存。相同键必须对应相同 method 与 payload，否则返回 `idempotency.conflict`。常见错误码：

- `protocol.not_ready`：尚未完成 `hello`；
- `protocol.duplicate_request`：同一连接重复使用 request id；
- `server.busy`：服务端并发或幂等请求过多，可稍后重试；
- `policy.denied`：该方法不允许远程调用；
- `policy.administrative`：远程客户端不能管理远程服务本身；
- `policy.unclassified`：方法未纳入远程协议；
- `capability.unsupported`：客户端没有声明该方法所属能力；
- `call.failed`：handler 执行失败。

### 4.3 订阅事件

订阅安装级事件：

```json
{ "kind": "subscribe", "scopes": ["installation"] }
```

订阅某个会话：

```json
{
  "kind": "subscribe",
  "scopes": ["conversation:conv_123"]
}
```

支持的 scope：

- `installation`：无法归属项目或会话的事件；
- `conversation:<id>`：某个会话的事件；
- `workspace:<projectKey>`：某个项目的事件；
- `resource:<id>`：资源级事件；
- `*`：实时接收所有 scope 的事件，但不能用游标恢复。

事件格式：

```json
{
  "kind": "event",
  "scope": "conversation:conv_123",
  "seq": 42,
  "epoch": "事件流代次",
  "eventId": "事件流代次:conversation:conv_123:42",
  "channel": "engine:event",
  "payload": {
    "type": "conversation_running",
    "conversationId": "conv_123",
    "running": true
  }
}
```

如果在 `hello.features.eventBatch` 中声明了 `eventBatch: true`，部分高频 channel 可能合并为：

```json
{ "kind": "events", "events": [/* 按顺序排列的 event */] }
```

客户端必须按数组顺序处理，不能按到达时间重新排序。当前可批处理的高频 channel 是 `engine:event` 和 `workspace:terminal-data`；其他事件仍以单条 `event` 发送。

取消订阅：

```json
{ "kind": "unsubscribe", "scopes": ["conversation:conv_123"] }
```

### 4.4 游标恢复与 `resync`

每个 scope 的游标是：

```json
{ "epoch": "事件流代次", "seq": 42 }
```

重连并完成新的 `welcome` 后，针对具名 scope 带上游标：

```json
{
  "kind": "subscribe",
  "scopes": ["conversation:conv_123"],
  "since": {
    "conversation:conv_123": {
      "epoch": "事件流代次",
      "seq": 42
    }
  }
}
```

服务端只保留有限的事件历史（默认每个 scope 最多 512 条、最长 5 分钟，并受总大小限制）。以下情况会返回：

```json
{
  "kind": "resync",
  "scope": "conversation:conv_123",
  "reason": "事件历史已超出保留范围",
  "epoch": "新的事件流代次",
  "seq": 100
}
```

收到 `resync` 时不要继续拼接旧状态。重新读取对应快照；如果无法判断受影响的范围，则重新读取整个工作区和当前会话。

`*` 订阅永远不提供可靠回放，带 `since` 只会得到 `resync`。需要断线恢复时，优先订阅具体的 conversation/workspace scope。

## 5. 推荐的会话客户端实现

### 5.1 首次打开会话

推荐顺序：

1. 订阅 `conversation:<id>`；
2. 调用 `engine:get-snapshot`，payload 为 `{ conversationId: id }`；
3. 用 snapshot 绘制 `messages`、`running`、`pendingUi`、`turnEvents` 和 `queue`；
4. 暂存订阅与快照请求并行期间收到的事件，快照完成后再处理；
5. 对 `engine:event`，使用事件 payload 中的 `seq` 丢弃不晚于 `snapshot.seq` 的旧事件。

`ConversationSnapshot.messages` 已经包含进行中的回复和工具调用，不要把 `message_update` 的 delta 再次追加到 transcript，否则会重复显示。`turnEvents` 只包含 transcript 没有位置存放的 UI 状态，不是可重新播放的消息流。

### 5.2 发送消息

```json
{
  "kind": "call",
  "requestId": 10,
  "method": "engine:prompt",
  "payload": {
    "conversationId": "conv_123",
    "message": "请检查当前项目的测试",
    "streamingBehavior": "followUp"
  },
  "idempotencyKey": "prompt-conv_123-client-msg-001"
}
```

`engine:prompt` 的成功响应表示服务端已接受消息，不表示 Agent 已完成。完成、错误、审批请求和流式内容通过 `engine:event` 推送。停止当前会话：

```json
{
  "kind": "call",
  "requestId": 11,
  "method": "engine:abort",
  "payload": { "conversationId": "conv_123" }
}
```

会话级方法应尽量显式传 `conversationId`，不要依赖服务端的 active conversation。这样多个第三方客户端可以同时查看不同会话，不会互相切换。

### 5.3 权限请求

Agent 可能通过 `engine:event` 发出 `extension_ui_request`，客户端应展示请求并用 `engine:permission-respond` 回答。回答 payload 至少包含请求的 `id`，例如：

```json
{
  "kind": "call",
  "requestId": 12,
  "method": "engine:permission-respond",
  "payload": {
    "id": "permission_123",
    "confirmed": true
  }
}
```

如果客户端重新连接，优先调用 `engine:get-pending-ui` 或读取 snapshot 中的 `pendingUi`，不要只依赖之前已经错过的事件。

## 6. 图片与二进制附件

不声明 `binaryAttachments` 时，图片直接放在 JSON payload：

```json
{
  "type": "image",
  "mimeType": "image/jpeg",
  "data": "base64..."
}
```

声明并从 `welcome.features.binaryAttachments` 得到确认后，可以先发送一个二进制 WebSocket 帧，再在 JSON payload 中使用 `attachmentId`：

- 二进制帧格式：`fastvibe-attachment-v1:<id>\n<raw bytes>`；
- `id` 形如 `att_` 加 8–80 个字母、数字、`_` 或 `-`；
- JSON 图片改为 `{ "type": "image", "mimeType": "image/jpeg", "attachmentId": "att_xxx" }`；
- 二进制帧必须先于引用它的 `call` 到达；
- 附件保存 60 秒，单连接总大小上限 32 MiB；单帧上限 24 MiB。

附件缺失时，调用会返回 `attachment.missing`。第三方客户端实现这个扩展前，应先实现普通 base64 版本。

## 7. 远程权限与方法目录

App Protocol 只规定 envelope；具体方法沿用 FastVibe 的 transport-neutral IPC 表面。远程客户端可调用的方法由 `src/shared/remote-policy.ts` 明确列出，未列出的方法默认拒绝。服务端启动时还会检查方法覆盖，新增方法不会自动暴露到网络。

主要方法族：

| 方法族 | 示例 | 用途 |
| --- | --- | --- |
| `conversations:*` | `conversations:list`、`conversations:open` | 项目与会话目录 |
| `engine:*` | `engine:get-snapshot`、`engine:prompt` | Agent、消息、队列、审批 |
| `workspace:*` | `workspace:read-dir`、`workspace:git-diff` | 项目文件与 Git |
| `providers:*` | `providers:list`、`providers:refresh` | 已保存的供应商和模型 |
| `settings:*` | `settings:get`、`settings:set` | 应用偏好 |
| `stats:*` | `stats:usage` | 使用统计 |
| `projects:*` | `projects:rename`、`projects:reorder` | 项目管理 |
| `memory:*` | `memory:search`、`memory:detail` | 本机长期记忆 |

以下类型不能由远程客户端调用：

- `remote:*`、`ssh:*`：不能从远程连接反过来管理远程访问、隧道或 SSH；
- 会打开服务端本机文件选择框、窗口或系统设置的操作；
- OAuth 本机浏览器登录及浏览器内嵌窗口管理；
- 任意 URL 探测或带凭据的供应商抓取；
- 未归类的新方法。

收到拒绝时，应展示 `error.code` 和 `error.message`，不要把所有错误都显示成网络断开。

## 8. 重连策略

推荐实现：

1. 保存 token，但不要把它写入日志或 URL；
2. WebSocket 断开后，指数退避重连，建议从 500ms 开始并封顶 10s；
3. 每次重连都重新发送外层 `auth` 和 `hello`；
4. `welcome.epoch` 变化时丢弃旧 epoch 的游标；
5. 具名 scope 使用 `since` 恢复；收到 `resync` 就重新读取快照；
6. `*` scope 不做增量恢复，重新读取目录和当前会话；
7. 收到 `4001` 或登录返回 `401` 时清除 token，要求用户重新登录；
8. 运行中的 RPC 在断线后不要假设成功或失败，重连后通过 snapshot、状态和事件重新判断。

## 9. 参考实现与兼容性

仓库提供了不依赖 Node 的协议客户端：`src/shared/app-client.ts`。它只需要一个实现以下接口的 transport：

```ts
interface MessageTransport {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  close(): void;
  setBinaryAttachments?(enabled: boolean): void;
}
```

它负责 v1 `hello/welcome`、requestId、RPC result、scope 游标、事件去重和 `resync` 通知；WebSocket 的外层 token 鉴权仍由调用方负责。

协议字段允许新增可选字段，但现有字段含义改变时会递增 `protocolVersion`。第三方实现应忽略未知 JSON 字段，并对未知 method、channel、事件 payload 保持前向兼容；不要把未知事件当成协议错误。

## 10. 相关源码

- 线协议类型与校验：`src/shared/app-protocol.ts`
- 浏览器/跨平台客户端：`src/shared/app-client.ts`
- IPC 方法名：`src/shared/ipc.ts`
- API payload 与返回值：`src/shared/api.ts`
- 远程允许/拒绝策略：`src/shared/remote-policy.ts`
- 能力分类：`src/main/app-server/capabilities.ts`
- App Server 调度：`src/main/app-server/app-server.ts`
- 事件、scope 与回放：`src/main/app-server/event-bus.ts`、`src/main/app-server/client-session.ts`
- WebSocket/HTTP 外层：`src/main/server/server.ts`
- 协议测试：`test/app-server-protocol.test.ts`、`test/app-client-server.test.ts`、`test/app-client-remote-server.test.ts`
