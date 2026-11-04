# 手机端当前工程合同

涉及 Flutter、Rust FFI、账号 iroh、LAN 发现、登录与连接生命周期时阅读。

关联入口：[手机端开发说明](../../apps/mobile/README.md)、[iroh 节点列表](../iroh-relay-nodes.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## 手机端（Flutter + Rust core）

`apps/mobile` 使用一套 Flutter 页面，恢复自 `67a79709` 的扁平简约样式（以 `142aa23e` 的完整 Flutter 实现为基线）；Compose、SwiftUI 产品界面及原 JNI/SwiftPM 桥接已经移除。`lib/core` 通过 `dart:ffi` 直接调用 `core/src/ffi.rs`，专用 isolate 持有 Rust runtime，阻塞的账号命令不得在 UI isolate 运行。`packages/rust_core` 只负责 Android `.so` 和 iOS XCFramework 的打包与链接。

手机网络继续使用当前 Rust core 的账号鉴权 iroh 与 App Protocol；旧 Flutter 的 WebRTC、局域网密码和扫码连接不能随界面恢复。Dart 负责页面与交互，Rust 负责协议和事件状态。`android/` 与 `ios/` 只保留 Flutter 宿主、签名和系统能力配置，不再新增两套原生页面。保留 `dev.fastvibe.mobile` 应用 ID 与现有发布签名，版本来自 `pubspec.yaml`，Android 发布元数据必须同步。

iroh 租约的 `relays` 是完整节点列表，每项含自己的 `relay_id/url/quic_port/token`，到期时间与账号额度共用。旧顶层单节点字段仅为兼容：新客户端把全部节点放入 `RelayMap`，并把全部 URL 加入对端 `EndpointAddr`，由 iroh 探测与并发拨号选择路径；不能只读取首项。桌面 `start/refresh/connect` 和手机账号响应到 FFI 命令都须保留完整列表，刷新移除已撤销的节点配置。旧 Control 没有 `relays` 时才回退单节点；显式空或损坏列表报错。云端名单来自配置，不在客户端硬编码过滤某个节点。

局域网发现使用原生 NSD/Bonjour 的 `_fastvibe-iroh._udp`，TXT 只带 `v/device_id/endpoint_id/addrs`，SRV 是实际 QUIC UDP 端口，不是 HTTP 7777。只给当前账号内 deviceId 与 EndpointId 均匹配的设备加「局域网」标签；点击时刷新云端端点并复核新鲜地址，以 `preferDirect` 先直拨 1.5 秒，失败才在 Core 内异步领取完整中继租约并回退，总拨号仍限 15 秒。回退租约的到期时间先于 welcome 传回 Dart 安排轮换；显式空或损坏的租约仍报错。发现记录在后台、换网、账号变化、移除和过期时清理，地址只作路由线索，身份和账号授权保持有效。iOS 声明 Bonjour 服务与本地网络用途，Android 使用兼容当前 Gradle 的 `nsd_android 2.2.0`。桌面广播器（`rtc/iroh-discovery.ts`）在公告失败——默认路由被隧道接管时组播发送报 `EHOSTUNREACH` 就是实测案例——按 1s/5s/15s/60s 退避自动重建，成功公告重置退避；登出或失去地址的显式 stop 取消重试、不再复活。一次网络抖动不该让「局域网」标记消失到下次重启：手机侧记录 60 秒过期，桌面不重新公告，标记就不会回来。

`Connection` 长期持有专用 isolate/runtime 与 Endpoint，客户端退休必须等原生 disconnect 完成；断连清事件、overflow 和投影，generation 隔离旧状态、welcome、租约与命令，账号/identity 变化关闭端点。仅成功的设备/端点注册缓存五分钟，token、安装身份或注册字段变化及 401/403/404 使缓存失效；每次仍核对当前账号设备。普通断连复用 UDP 端口与 HTTP client，runtime 致命失败则在销毁完成后替换实例。

手机账号登录用 `url_launcher` 的 external-application 模式切到完整默认浏览器，不使用内嵌 WebView、Custom Tabs 或系统认证面板。`app_links` 把 `fastvibe://oauth/callback` 交回当前登录，平台关闭 Flutter 默认 deep-link 路由；回调严格匹配 URI 和本次 state，保留 PKCE，五分钟过期。账号行可以取消等待；取消、退出及迟到响应不得恢复旧账号。

手机会话工具使用 `lib/chat/tool_card.dart` 的紧凑平铺行：动作和对象为主信息，目录/计数在次行；运行中保留工具图标，只让标签轻微闪动，并遵循减少动画偏好。参数与输出按需挂载在 `tool_details.dart` 的限高详情内，长输出分块懒加载，复制保留全文；失败默认只露出两行原因，完整详情由读者展开。思考行共享图标尺寸和运行标签处理，todo 保留专用清单。

验证：`pnpm mobile:analyze`、`pnpm mobile:test`、`pnpm mobile:core:test`；Android `pnpm mobile:android`，iOS `pnpm mobile:ios:build` / `pnpm mobile:ios:check` 后用 Flutter 构建。跨平台 ABI 与真实桌面协议仍由 `test/mobile-protocol.integration.test.ts` 覆盖。完整开发说明见 `apps/mobile/README.md`。其它工程资料中涉及旧原生客户端的历史描述以本节为准。
