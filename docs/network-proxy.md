# 客户端网络代理

设置 → 偏好设置 → 网络代理：默认关闭（直连）；开启后选择系统代理，或自定义 HTTP / SOCKS5 的主机与端口。修改先留在草稿，点击「应用」后写盘并生效；无需重启，但会断开现有网络连接，运行中的请求可能需要重试。

## 覆盖与边界

- Chromium：默认会话、内置浏览器 `persist:fastvibe-browser`、更新器 `electron-updater`，以及后续创建的会话；无 Session 的 Electron 网络请求也应用配置。
- Node：全局 fetch/Undici、HTTP/HTTPS 默认 Agent、全局 WebSocket。模型流、供应商探测、OAuth 令牌交换、MCP HTTP、模型目录、插件目录和本地资源下载共同使用它。
- npm/git 等遵循代理环境变量的子进程通过带随机认证的 loopback relay 出网。变量仅存在本进程及其后代，不修改登录 shell、系统代理或远端主机。运行中的子进程持有的 relay 地址不因切换代理而失效。
- 本机 loopback 通信直连，保留 OAuth 回调、本机 MCP、SSH 本地转发等能力。`127.example.com` 不是 loopback。
- 系统模式由 Chromium 解析系统设置/PAC，可能返回 DIRECT。Node 对已选代理的连接失败不会回退直连；SOCKS4 明确报不支持，不误按 SOCKS5 连接。Chromium 自身仍遵循其系统代理失败回退规则。
- 启用代理时，现有及新建 WebContents 禁止 WebRTC 非代理 UDP。
- **不是全系统 VPN/TUN**：SSH 原始连接、穿透工具的 TCP/UDP、外部浏览器、SSH 远端以及忽略代理变量的外部程序不受此设置约束。需要这类流量也强制经过代理时，应使用操作系统级 TUN/VPN。远程网页客户端自身的网络由其所在设备管理。
- 不提供代理账号密码字段；`settings.json` 会分享给渲染层及远程客户端，不应承载代理凭据。

## 实现约束

- `src/shared/proxy.ts`：配置、校验、Chromium 规则、PAC 结果及 loopback 判定。
- `src/main/engine/network-proxy.ts`：在启动引擎/窗口/后台下载之前设置所有网络栈；切换串行化，失败回滚。可恢复的网络配置或 relay 初始化失败保持联网阻断，但允许打开设置修复。
- `node-proxy.ts`：逐请求使用 Chromium 的解析结果。切换销毁旧连接池、请求和升级后的 WebSocket；配置代次拒绝迟到的旧解析结果。仅销毁 HTTP 池不能关闭已经升级的 WebSocket。
- `proxy-relay.ts`：只监听 127.0.0.1 随机端口，校验随机 Basic 认证，转发时去掉 hop-by-hop 头和 relay 凭据；HTTP 流式转发、CONNECT、SOCKS5 远端 DNS、错误/超时/取消和关闭均不直连兜底。
- `settings:proxy-set` 是唯一普通代理写入入口，走共享 API / 调用表 / 广播。普通 `settings:set` 保留磁盘上的代理字段，不能用另一客户端的旧全量快照关闭代理。恢复默认是明确的另一条关闭路径，磁盘失败时回滚，不报告假成功。

## 验证

`pnpm test` 中的 `proxy-settings.test.ts`、`proxy-relay.test.ts`、`node-proxy.test.ts` 使用本机假代理及 `.invalid` 目标，不访问公网。覆盖 HTTP、HTTPS CONNECT、SOCKS5、流式/取消、WebSocket、子进程 relay、代理失败不直连、配置切换期间的迟到解析、关闭清理、跨客户端旧快照保护。

Electron 冒烟检查应另行覆盖：默认/浏览器/更新器/后建 Session 与 Node 均通过同一个本地 HTTP、SOCKS5 测试代理；切换系统/关闭；已有和新建 WebContents 的 WebRTC 策略。真实公网出口、操作系统 PAC 和 STUN 抓包需要相应网络环境验证，纯模块测试不能替代。
