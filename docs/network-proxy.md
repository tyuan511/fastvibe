# 客户端网络代理

设置 → 偏好设置 → 网络代理：默认关闭（直连）；开启后二选一——跟随系统代理，或填一个代理地址（`http://127.0.0.1:7890`、`socks5://[::1]:1080` 这类，端口可省）。每一项改动当场写盘并生效，没有「应用」那一步；无需重启，但会断开现有网络连接，运行中的请求可能需要重试。地址框是唯一的例外——它在失焦或回车时提交：`http://1` 也是个合法地址，逐字符保存等于在打到 `http://127.0.0.1:7890` 的路上先把流量送进 `http://1`。校验不过的输入只留在框里报错，不写盘。不收账号密码（`http://user:pass@host` 直接拒），`settings.json` 会交给渲染层与远程客户端；也不支持 SOCKS4，与系统代理那侧的拒绝一致。

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

- `src/shared/proxy.ts`：配置、地址校验与规范化、Chromium 规则、PAC 结果及 loopback 判定。地址按手写的正则解析而不用 `URL`：WHATWG 会丢掉与 scheme 默认值相同的端口（`http://h:80` 的 `port` 是空串），照它的各部分重拼就会把用户写的 `:80` 悄悄抹掉。scheme 认 `http` / `https` / `socks5` / `socks5h`，其中 `socks5` 带数字，所以 scheme 的字符类不能只给字母。
- 旧配置就地读：这份设置以前是 `proxyProtocol` / `proxyHost` / `proxyPort` 三个字段，`proxyUrlOf` 把它们合成一个地址，所以上一次升级前配好代理的安装启动后照常走代理，不需要迁移或提示重填。一旦 `proxyUrl` 这个键存在，它就单独说话（包括它不合法的时候）——半个地址不会把同一份文件里剩下的旧字段抬回来。渲染层把三个旧键当作 `REMOVED_KEYS` 丢掉，所以第一次普通保存就把它们从文件里带走。
- `src/main/engine/network-proxy.ts`：在启动引擎/窗口/后台下载之前设置所有网络栈；切换串行化，失败回滚。可恢复的网络配置或 relay 初始化失败保持联网阻断，但允许打开设置修复。
- `node-proxy.ts`：逐请求使用 Chromium 的解析结果。切换销毁旧连接池、请求和升级后的 WebSocket；配置代次拒绝迟到的旧解析结果。仅销毁 HTTP 池不能关闭已经升级的 WebSocket。
- `proxy-relay.ts`：只监听 127.0.0.1 随机端口，校验随机 Basic 认证，转发时去掉 hop-by-hop 头和 relay 凭据；HTTP 流式转发、CONNECT、SOCKS5 远端 DNS、错误/超时/取消和关闭均不直连兜底。
- `settings:proxy-set` 是唯一普通代理写入入口，走共享 API / 调用表 / 广播。普通 `settings:set` 保留磁盘上的代理字段，不能用另一客户端的旧全量快照关闭代理。恢复默认是明确的另一条关闭路径，磁盘失败时回滚，不报告假成功。

## 验证

`pnpm test` 中的 `proxy-settings.test.ts`、`proxy-relay.test.ts`、`node-proxy.test.ts` 使用本机假代理及 `.invalid` 目标，不访问公网。覆盖 HTTP、HTTPS CONNECT、SOCKS5、流式/取消、WebSocket、子进程 relay、代理失败不直连、配置切换期间的迟到解析、关闭清理、跨客户端旧快照保护。

Electron 冒烟检查应另行覆盖：默认/浏览器/更新器/后建 Session 与 Node 均通过同一个本地 HTTP、SOCKS5 测试代理；切换系统/关闭；已有和新建 WebContents 的 WebRTC 策略。真实公网出口、操作系统 PAC 和 STUN 抓包需要相应网络环境验证，纯模块测试不能替代。
