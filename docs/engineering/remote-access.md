# 远程服务、账号与连接资料

涉及远程鉴权、策略、背压、SSH 手机访问或账号登录时阅读；旧传输资料的适用范围见下文。

关联入口：[App Server 协议](../app-server-protocol.md)、[iroh 节点列表](../iroh-relay-nodes.md)、[手机端当前工程合同](mobile.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

> 范围：账号 iroh 与 Flutter 是当前手机端基线。下文 WebRTC/TURN、旧密码扫码和旧服务发现说明保留为历史资料；不能据此把现存 HTTP/WS/SSH 服务端功能一并视为已删除。

## 远程访问（`src/main/server/`、`src/main/rtc/`）

> 本节同时包含仍保留的 HTTP/WS 服务端合同和旧手机密码/扫码入口叙述。当前手机端使用账号鉴权 iroh；不得据此恢复旧手机连接流程。背压、鉴权等服务端约束需结合当前源码适用范围使用。

One switch (设置 → 远程访问) opens two ways into the same call table — the one the desktop
windows use — so that a method cannot exist on the desktop and be missing on the phone:

- **官方连接** (`rtc/`): a phone signed in to the **same FastVibe account** finds this
  computer by itself and connects over WebRTC — directly (LAN, or across routers) when it
  can, through FastVibe's TURN relay when it cannot. No password, no address, nothing to
  configure. Needs only a signed-in account. See 官方连接 below.
- **局域网地址 + 密码** (`server/`): the `RemoteServer` listener, which a phone on the same
  network reaches by scanning a QR code (or finding the computer by name, 局域网发现 below) and
  typing the password. It needs a password and nothing else: with the switch on and a password
  set the listener is up, and 设置 → 远程访问 shows its QR code straight away. There is no
  separate 允许局域网访问 switch.

The listener binds `::`, which is **dual-stack**: one socket answers IPv4 and IPv6 at once
(`startListener` in `remote.ts`; a machine with IPv6 off falls back to `0.0.0.0`). The pane shows
one QR code per address family this machine has (`RemoteLan`, `remote-lan.tsx`) with a tab to
switch — a phone on a network that routes only one of them scans the other. The QR carries the
address and the computer's name, never the password. The listener is also what the headless Agent
uses, reached through an SSH forward or, with a password, by a phone (`agent/`,
`ssh:set-phone-access`).

There is no browser client any more. The listener answers `/api/hello`, `POST /api/login` and
the `/ws` upgrade, and a bare 404 to everything else; a WebSocket upgrade that carries an
`Origin` header is a web page and is refused outright, since the phone app and the SSH forward
send none.

The computer's name (设置 → 远程访问 → 电脑名称) is saved as `remoteDeviceName` (an older
`remoteDiscoveryName` is read as a fallback) and is the one name everywhere: the account's device
list, the console, the phone, the QR code and the mDNS record. The input starts out as the
computer's own name. Changing it re-registers the device (`OfficialConnection.renamed()`) and
replaces the mDNS record, without restarting signaling or dropping a phone.

`src/main/remote.ts` holds everything Electron-shaped — settings, paths, the methods the
settings pane calls — so `server/` itself imports no Electron and could run without a GUI. It
is handed the very same `dispatch` and `subscribe` the windows use.

Rules that fail silently if broken:

- **Credentials never touch `settings.json`.** That file is handed whole to every renderer
  and re-broadcast on every write. The password hash and device tokens live in
  `remote-access.json` (0600), and no method serves it.
- **`policy.ts` classifies every method, exhaustively.** `assertPolicyCoverage` refuses to
  start the server when the table holds one that is in neither set, so adding a method
  breaks the server until somebody decides — a denylist alone would expose it by default.
  The bar for denying is narrow: whoever has the password can already ask the agent to run
  commands, so only calls that *hang* (native dialogs), act on the wrong machine's desktop,
  or hand over a lever they would not otherwise have (`providers:fetch`) are refused —
  plus `remote:*` itself, so a stolen token cannot lock the owner out. `attachTransport`
  runs the same coverage check `start()` does.
- **No password, no listener.** `start()` throws rather than listening, and the default bind
  is `127.0.0.1`. The desktop binds beyond loopback only when the switch is on **and** a
  password exists (`bringUp`, and `remote:set-password` for a password set afterwards), so a slip
  in the settings pane cannot put a shell onto the local network. The official connection does
  not use the listener or the password (see below).
- **Pushes begin at authentication, not at connection.** A socket that has not proved who
  it is is subscribed to nothing and closed after ten seconds.

**The heartbeat is for the network, not for this machine.** A proxy or NAT cuts a
quiet connection — Cloudflare's edge after 100 seconds, nginx's `proxy_read_timeout` after 60
— and quiet is the normal case here: reading a transcript, or watching a run, is a socket
with nothing to say. So `#beat` pings each one every 30 seconds, and the browser's pong is
half the point: traffic has to be seen in *both* directions for the timers on either side to
reset. It doubles as liveness, which matters more over the internet than on a wire — a
half-open connection there looks attached forever and never receives anything again — so a
socket that missed a whole round is `terminate()`d, which becomes the `close` the client
reconnects from. `heartbeatMs` exists only so a test can watch that happen without waiting
out the real interval.

**A large frame being compressed is not a slow client.** `ws.bufferedAmount` includes
uncompressed bytes waiting on zlib as well as the socket's write queue. A 3 MB snapshot
followed immediately by a tiny event used to trip the instantaneous 2 MiB cutoff and
close with `4004`, even on loopback — seen repeatedly on the native phone app while it
was in the foreground. `server/backpressure.ts` now distinguishes a burst from congestion:
2 MiB is a soft watermark with 15 seconds of stall grace; a successful send callback or a
net drain of at least 64 KiB renews it. Each outstanding frame has a 120-second age limit
while above that watermark. Continuous fast output can keep a healthy queue above 2 MiB:
neither a flat queue size nor time spent above the watermark alone proves it is stuck.
`trackSend` records each frame before enqueueing it, and only a successful write completes
it; these callbacks mean local transport progress, never an acknowledgement from the phone.
32 MiB of existing backlog stops further writes immediately. A single large reply on an empty queue is allowed, so
the bound is the hard watermark **plus one outgoing frame**, not an absolute frame-size
limit. Send completions sample the buffer too, so two separate bursts do not share a
stale congestion clock; a per-client timer samples once a second even if no next event
arrives and is cleared on drain/disconnect. Do not merge or discard protocol events to
work around this: their sequence, payload and ordering remain unchanged. Real-socket
tests cover multi-MiB bursts with/without compression and hard-limit session cleanup.

What *is* thinned is decided at the source, for every client alike: a `toolcall_delta` carries
the call's whole arguments parsed so far, so streaming a large `write` was O(n²) bytes (a
100 KB file: ~2,500 events, ~125 MB through the event bus, IPC and the data channel). Each one
supersedes the last, so `ToolDeltaThrottle` (`pi/tool-delta-throttle.ts`, the conversation
listener and the delegated-run listener) forwards the first and then only the newest per
window — 100 ms growing to 1 s with the arguments' length — and delivers a held one before any
other event of the same owner, so ordering and the final state are unchanged (84 events,
~2.5 MB for that file). Clients replace a tool's arguments wholesale on each delta already, so
neither the desktop nor the phone changed.

The password is exchanged once for a device token (`POST /api/login`); tokens travel on
every later connection, are stored only as hashes, and are revoked one device at a time.
Guessing is slowed by a global exponential backoff.

## 历史：WebRTC 官方连接（`src/main/rtc/`）

> 历史 WebRTC/TURN 实现资料：保留帧格式、测量、NAT 探测与验证边界供排查或迁移参考，不是当前 Flutter 手机端的连接合同。当前实现以 [手机端合同](mobile.md)、[iroh 节点列表](../iroh-relay-nodes.md) 与现有 iroh 源码为准；云端服务说明在 fastvibe-services 的 `docs/cloud-service.md`。

`OfficialConnection` (`rtc/official.ts`, Electron-free) registers this install as a device
(`PUT /api/devices/me`, the id minted once in `rtc-device.json`), keeps the cloud's signaling
WebSocket open (`rtc/signaling.ts`, reconnecting with backoff), and answers each phone that
calls with a `Responder` (`rtc/responder.ts`) over libdatachannel (`node-datachannel`, behind
`rtc/peer.ts` so tests can fake it). It follows the 远程访问 switch and the account: switch off
or signed out → signaling closes and every phone is dropped.

- **The account is the authentication.** The cloud only introduces two sessions of the same
  account, and the DTLS fingerprints travel over that authenticated signaling, so a third party
  cannot stand in for either end. The data channel is therefore attached already authenticated
  (`RemoteServer.attachTransport`) — no password, no device token — and everything after that
  is the ordinary path: the policy (`remote-policy.ts`), the backpressure guard, the heartbeat,
  the App Protocol session. `stop()` of the listener leaves attached connections up; they do
  not depend on it.
- **The phone offers, this side answers.** The phone opens one data channel labelled
  `fastvibe` (any other label is closed); signals are `{type:"offer"|"answer", sdp}` and
  `{type:"candidate", candidate, mid}` inside the signaling `signal` message. Signals that
  arrive while ICE servers are still being fetched are buffered and replayed in order. The
  phone's candidates are held until this side has a server-reflexive candidate of its own —
  that is the STUN request having gone out, which is the whole point of the hold — and not
  until gathering completes, because the relay allocation after it is a round trip a phone
  on this network never needs. A STUN server that never answers still releases them after
  the same bounded wait. After the channel opens a `hangup` only frees the phone's signaling
  slot — it is ignored.
- **Frames are fragmented** (`rtc/frames.ts`; the phone's copy is `apps/mobile/core/src/lib.rs`
  and must stay byte-identical): one header byte (`LAST`, `BINARY`, `PING`, `PONG`, `CLOSE`),
  at most 16 KiB per message, control messages may fall between fragments. `ChannelSocket`
  (`rtc/channel-socket.ts`) dresses a data channel as the WebSocket-shaped `RemoteSocket` the
  server takes: queued bytes count toward `bufferedAmount`, ping/pong are real, and a close
  carries a code.
- **libdatachannel's `send` returning `false` means queued, not failed.** Treating it as a
  failure closed every connection on the first large reply. A send fails when the channel is
  not open, or throws.
- **The path is reported, not chosen.** ICE picks host → srflx → relay; the pane shows 直连 or
  中转 from `getSelectedCandidatePair()`, because relayed traffic is the one case that costs
  the account something (a monthly allowance). Compression follows that same report, and only
  that report: the offer's `deflate` is permission (an older reader refuses the bit), and a
  frame is deflated only once the selected pair is a relay. A direct path, and the window
  before ICE nominates, send frames as they are — deflating JSON on Main's thread costs more
  than the bytes save when the round trip is a millisecond. The bit is per fragment, so a
  path that moves later changes the next frame without reconnecting. The phone does the same
  with its own `getStats()`. On the relay a frame of 64 KiB or more is deflated off Main's
  thread (`ChannelSocket.send`): megabytes of transcript take tens of milliseconds, on the
  thread every agent's stream runs on. The frame keeps its place meanwhile — the channel
  carries no sequence number, so nothing sent after it may be handed over before it — and
  counts toward `bufferedAmount`, so the backpressure guard still sees it.
  Fragment size follows the path too, but only as far as the peer negotiated: a direct path
  reads `maxMessageSize()` and sends up to 64 KiB (libdatachannel's own default), while a
  relay and a path not yet chosen stay at 16 KiB. The phone's stack cannot read that number,
  so it keeps sending 16 KiB; receiving the desktop's larger fragments needs no change.
  64 KiB is not a step toward the 256 KiB both stacks negotiate: 128 was measured against 64
  on loopback (12 MB, real peers) and made no difference.
- **The phone's side** (`apps/mobile`): the account (`lib/account/account.dart`: browser PKCE
  sign-in through `native account bridge`, `fastvibe://oauth/callback`, token in the Keychain/Keystore,
  only ever sent to the site that issued it) and the account's computers (`official_devices.dart`),
  which live in the same saved list as manual ones with `kind: official` and origin
  `fastvibe-official://<device id>`. `RtcDialer` (`lib/protocol/rtc_connection.dart`) does the
  signaling and the WebRTC offer and hands `RemoteClient` a `FrameSocket`, so the handshake, health
  checks and reconnect are the ones every other connection uses. `Connection` carries `needsAccount`
  (the way forward is signing in) next to `needsPassword`.
  - **A signaling socket outlives its call for 20 seconds** (`lib/protocol/rtc_signaling.dart`,
    `SignalingCall`). Opening one is a TCP and a TLS handshake and an upgrade before the call
    can be placed, and a reconnecting phone places several in a row — the desktop answers
    `device_offline` while its own signaling comes back. A kept socket has already said
    `hello`, so the next call sends `connect` alone. Three things keep that from being slower
    than not keeping it: a kept socket gets 2.5 seconds to answer before a fresh one replaces
    it, a network change or leaving the foreground drops it (`dropKeptSignaling`), and what
    still arrives about the previous call is told apart by its `cid` — the service answers a
    `hangup` that crossed the desktop's with `unknown_call` *for that call*, and an error that
    answers `connect` names none.
  - **Host candidates have their own share of the budget** (`CandidateBudget`: 8 in all, 4
    host, 2 relay). They are found first — the public address and the relay each wait on a
    round trip — so a phone with enough interfaces used to fill the budget before the relay
    arrived, and the relay is the one address a desktop on another network must be *told*:
    its router lets nothing in from an address it has not sent to.
  - **Neither address family takes every host place** (3 of the 4), and a unique-local IPv6
    address is not sent at all. Hosts arrive in the system's interface order, and a phone on
    Wi-Fi and mobile data had enough IPv4 ones to fill the share before its public IPv6
    address — the one that needs no NAT traversed — turned up.
  - **A network that carries no UDP is dialled again over TCP** (`_udpProbe`, `relayOverTcp`).
    Four seconds with no address beyond the phone's own ends the attempt and starts one with
    the relay alone, over TLS on 443 when the service lists it. Only then: a second relay on
    every dial would be a second allocation where UDP works.
  - **The path is the pair the transport selected** (`selectedPairFrom`), not the first pair
    that succeeded — the relay's and a direct one can both have. `rtc.path` records what it is
    made of (`direct srflx/prflx v4`) when it changes.
  - **`Disconnected` is acted on, not waited out.** ICE reports it within seconds and calls
    the path failed only much later, and the routine health check is 15 seconds apart with
    15 to answer. `RtcFrameSocket` reports it through `FrameSocket.onSuspect` and
    `RemoteClient` probes at once (`checkHealth(fast: true)`); a path that recovers answers
    the probe and nothing is dropped.
- **SCTP is tuned once, for the whole process.** usrsctp keeps one set of settings, so a
  relayed call and a direct one share them and neither can be tuned alone. Two of the
  library's defaults are moved (`peer.ts`, applied before the first peer or they are
  ignored): the delayed acknowledgement from 20ms to 5ms, because on a direct path that
  wait is the whole latency of a small frame, and the initial congestion window from 10 to
  64 MTUs, so a snapshot does not trickle out over the first few round trips. The buffers
  stay at the library's 1MB — larger only helps a transfer the relay would then have to carry.
- **The desktop gathers with STUN only.** The phone is the end that asks for a relay
  (`stunServers` in `rtc/ice.ts` says why: the account's allocation quota, and libjuice holding
  an allocation until it expires). libjuice has no TURN over TCP/TLS either, so a desktop on a
  network that blocks UDP outright cannot be reached at all.
- **The STUN list is never waited on once there is one** (`OfficialConnection.#loadIce`). It is
  fetched as signaling comes up; after that a list due for another look is handed out as it is
  and looked up again behind the call. What is kept has no credential in it, so nothing in it
  expires with the service's hour — whereas waiting on the service and getting no answer sent
  the call on with no server, which a phone off this network cannot connect through. Only a
  call with nothing to gather with waits, for three seconds rather than the request's fifteen.
- **A call's socket is set up from a plan measured before the call** (`rtc/netpath.ts`,
  `OfficialConnection.#loadPlan`). The library gives a call one socket, one STUN server picked
  at random from the list and whatever route the system hands out, and three things about that
  route decide whether a phone on another network gets a direct path. The plan is a few STUN
  requests on sockets of our own, made as signaling comes up, kept while the interfaces stay
  the same (`networkSignature`) and measured again behind a call once it is five minutes old; a
  plan for another network is never used, and a call that has none waits 1.5 seconds and goes
  on plain. It answers:
  - **Whether a tunnel owns the default route.** A proxy or VPN running as an interface carries
    the STUN request away, and the call then offers the tunnel's far end as this computer's
    public address — the phone connects through the proxy or not at all. A socket *bound* to
    the real interface's address stays off the tunnel (`bindAddress`; measured on macOS, and
    tried rather than assumed everywhere: the plan binds only when a bound probe is answered
    with a different public address). Such a socket cannot use a made-up address from a
    fake-IP resolver, so the STUN server's real one is asked for from that interface and
    handed to the library as a literal. A bound socket is IPv4 only: where this computer has
    IPv6 the tunnel leaves alone *and* the phone offers a public IPv6 address, the call is left
    unbound (`#phoneHasGlobalV6` waits 250ms past the offer to see), and a bound call drops the
    phone's IPv6 candidates rather than spend the library's few places on them.
  - **Which server answers**, so the call is given that one instead of a random pick.
  - **What the router does with a second destination** (`classifyMapping`): keeps the port,
    hands out the next one along, or picks at random.
- **A router that hands out ports in order is met with guesses** (`predictedCandidates`, sent
  as one `candidates` message so twenty lines are not twenty messages against the signaling
  rate limit; a phone that does not know the message ignores it). What makes a guess land is
  how little time passes between this side's STUN request and its first packet to the phone's
  public address, so on such a router the offer is *kept back* until the phone's
  server-reflexive candidate arrives (`PAIRING_HOLD_MS`, 700ms at most) and the phone's
  candidates follow the STUN request by 25ms instead of by its round trip. Measured with the
  real library against a listener on another continent, on a router giving out some hundred
  ports a second: applied the old way the port toward the phone was 2 to 75 past the STUN one
  (6 of 8 within 16); kept back, 2 to 5 past in seven of ten and within 20 in nine. It only
  helps a phone whose own NAT keeps its port — one that does not still needs the relay — and it
  costs a call on such a network the phone's STUN round trip before it starts.
- **A forwarded port, when the router offers one** (`rtc/portmap.ts`: NAT-PMP and UPnP IGD).
  Asked for per call on a port reserved for that call's socket, announced as one more
  server-reflexive candidate (`mappedCandidate`), renewed at half its lease and taken down with
  the call; `PortMapper.close()` runs at quit. It replaces the guesses: a forwarded port takes
  a packet from anywhere. Nothing is asked of a router that reports a private address of its
  own (it is behind the provider's NAT and its port leads nowhere), one whose address is not
  the one STUN saw, or one that only makes permanent mappings — a mapping that outlived a
  crash would stay open until somebody found it. **Not run against a real router**: the one
  this was built behind answers neither protocol; the tests speak both from the specifications.
- **Signaling is pinged from this side too** (`SignalingClient.probe`, every 15 seconds, 8 to
  answer). The service's own ping is 25 seconds apart and its silence is called dead after 70,
  which is how long this computer stayed unreachable after its network changed under it:
  every phone that called meanwhile was told `device_offline`. A call ending asks at once —
  a network change ends a phone's connection and the signaling together, and only the first
  of those says so.
- **Native module.** `node-datachannel` ships one optional package per platform;
  `pnpm-workspace.yaml` installs both macOS CPUs (the x64 release is built on an arm64
  runner) and `electron-builder.yml` prunes the other from each package. `nodeDataChannel.cleanup()`
  must run at exit (`shutdownWebRtc`) or the process never ends — tests call it in `after()`.

## 历史：密码服务的局域网发现（`src/main/server/mdns.ts`）

> 旧密码服务发现资料。当前手机端的原生服务类型、服务身份与地址校验以 mobile.md 为准；不要用本节替换当前账号发现流程。

局域网监听在跑时（远程访问开着且设了密码），桌面端用 `bonjour-service` 广播 `_fastvibe._tcp`，
实例名是电脑名称（设置里的电脑名称，留空用主机名去掉 `.local`），与账号设备列表同名。手机的「添加设备」页据此列出
「附近的电脑」，点一下就填好地址，连接名默认用这个名称。记录里只有端口和 `v=1`，不含任何凭据。

- **显示名与解析名分开。** 服务实例名供人识别，但 SRV target 和 A/AAAA 记录使用这个
  advertiser 独有的 `fastvibe-<uuid>.local`。不能让 `bonjour-service` 默认使用 `os.hostname()`：
  它会把所有网卡的地址广播到同一个名字下，与 macOS 按网卡发布的系统记录冲突，导致系统提示
  主机名被占用、不断加 `-2` / `-3`，手机也可能拿到失效的解析记录。
- **名称就是电脑名称。** 不再有单独的「主机名称」：`remote:set-device-name` 保存 `remoteDeviceName`，
  `announce()` 随后经 `syncDiscovery()` 替换广播；同端口下也比较名称才能让改名生效。名称允许句点和
  最长 64 个字符，而 mDNS 实例名不行，所以广播前过 `mdnsInstanceName()`：句点、反斜杠和控制字符换成
  `-`，63 个 UTF-8 字节封顶，重名后缀按字节截断原名称，不切断 Unicode 字符。独立的 SRV target 不随用户改名而变化。
- **`publish()` 返回不等于广播成功。** 只有 `up` 才记录已发布；探测中的同端口请求仍是空操作。
  `bonjour-service` 1.4.x 发现服务名冲突时只停掉服务、不发事件，2 秒的探测检查据 `activated`
  识别这条路径，改用 `名字 (2)` 等后缀，最多试 5 个名字。失败清理 socket 后才允许再发起；
  停止和换端口取消检查，旧实例的迟到回调不能恢复广播。底层 socket 的 `error` 要单独接住，
  库的构造回调只接查询应答错误，service 的监听器接不到绑定失败。
- **广播由服务器状态推出来，不在各调用点开关。** `remote.ts` 的 `syncDiscovery()` 挂在 announce
  路径里（启动、停止、设置或清除密码都会经过），条件是「监听正在运行」；没有监听（没密码）就不广播。
  `publish` 对同一端口和名称是空操作，换端口或名称则替换记录；失败只记日志，不能拖垮远程访问。
- **一台电脑会广播它每块网卡的地址**（Wi-Fi、VPN、虚拟机桥接……），手机侧
  `originsFor` 把私网 IPv4 排最前、丢掉链路本地地址，`firstReachable` 并发探测、按排名取第一个有响应的。
  不用 `.local` 主机名：Android 的解析器不做 mDNS。
- **监听同时收 IPv4 和 IPv6，广播只带一个地址族。** 监听是 `::` 双栈，但记录只发一族：
  IPv4 只发 A（`disableIPv6: true`），IPv6 只发 AAAA。库没有 `disableIPv4`，所以在异步探测结束前包装
  `service.records()` 过滤 A；注册、应答、重发和撤销都使用同一套记录。`nsd_android` 2.2.0 只把
  `NsdServiceInfo.host` 的一个地址交给 Rust core，即便指定 `IpLookupType.any`，已有地址时也不会再查询；如果这个
  地址是 `fe80::`，手机过滤后连行都不显示——所以两族都发是不安全的。`syncDiscovery` 在这台电脑有 IPv4
  时选 IPv4，只有 IPv6 时才选 IPv6；同端口换族也必须重新广播。
- **手机端用 `nsd` 原生浏览**（不是纯 Rust core 的 `multicast_dns`：iOS 14+ 的原始多播需要苹果审批的 entitlement）。
  iOS 要 `NSBonjourServices`，Android 要 `CHANGE_WIFI_MULTICAST_STATE`。发现不可用（拒绝本地网络、
  网络过滤多播）时列表为空，扫码和手动输入照旧。手机客户端由 Flutter 实现，业务逻辑由 Rust core 统一提供。

## 手机读取输出文件（`workspace:read-file`）

手机上点开回复产出的文件、再下载，走调用表里的 `workspace:read-file`（`engine/file-chunk.ts`），**不走 `/api/media`**：
文件字节以 base64 分片经 App Protocol 调用通道来回，不能假设官方连接另有可访问的 HTTP 媒体地址。原资料以“一条 WebRTC 数据通道”解释此约束，那是旧传输背景；当前手机连接是账号 iroh，见 [手机端合同](mobile.md)。

- **分片、不是整文件。** 一次最多 512 KiB（`MAX_CHUNK_BYTES`），应答 `{ size, mtimeMs, offset, data, eof }`；`length: 0` 只量大小。
  单个大回复会让同一条有序通道上排在它后面的转写推送等一下，所以别调大；`mtimeMs` 让手机发现文件读到一半被改写。
  超过 256 MiB（`MAX_DOWNLOAD_BYTES`）直接拒绝。
- **相对路径由 Main 解析。** 工具写的 `out/report.md` 相对于会话目录，手机不知道那在哪。请求带 `conversationId`，
  相对路径按该会话的 `cwd` 解析（`conversationCwd`，只在路径是相对时才查目录，避免每个分片都读一次目录快照）；
  绝对路径不查。同一个 `conversationId` 也是网关把调用路由到 SSH 主机的依据，SSH Agent 注册了同一个方法。
- **远程策略：允许。** 拿到密码的人本来就能让智能体跑命令，`workspace:preview` 也早就能读任意文本文件，所以这不是新的杠杆；
  `server-policy.test.ts` 的覆盖检查会在漏分类时拒绝启动。

## SSH 主机的手机连接（`phoneAccess`）

A server whose Agent was deployed over SSH is reachable from the desktop and nowhere else:
the Agent listens on `127.0.0.1`, the desktop's forward arrives from loopback and presents a
secret token, and there is no password. A phone cannot make that hop. 设置 → SSH 主机 → 编辑 →
**允许手机连接** turns the same resident Agent into something a phone can reach directly —
the same models and chats, not a second Agent — and the row then shows the usual hover-to-scan
QR icon (`QrAction`, shared with 远程访问).

- **The switch is `profile.phoneAccess = { port, publicUrl? }`, not `servicePort`.**
  `normalize` throws `servicePort === 7777` away (it was once written into every profile by
  mistake), and 7777 is the obvious phone port, so the two cannot share a field. `connect`
  asks `runningAgentFits`, which prefers `phoneAccess.port`.
- **Three things happen, in this order, in `SshManager.enablePhoneAccess`:** the password hash
  is written to the host, the Agent is restarted so it listens beyond loopback, and *only
  then* is the profile saved. A failure before the save leaves the profile as it was, so the
  pane never draws a QR code for a host that is not reachable; a password file written by a
  first-time enable that then failed is deleted again. The IPC handler disconnects the host
  first, because a live forward to the Agent being restarted would only reconnect to nothing.
- **The password is never stored on the desktop and never an `ssh` argument.** Only its scrypt
  hash is made (`hashPassword`, the server's own), and it travels on stdin to
  `~/.fastvibe/remote-access.json` (0600, written beside and renamed). `RemoteServer` re-reads
  that file on every login, so a changed password needs no restart — and because the file is
  rewritten whole, changing it signs every phone out. Leaving the password empty on an
  already-enabled host keeps the one it has, so the port can change without that.
- **The Agent knows two states, and the bootstrap/preflight compare them.** `--host=127.0.0.1`
  (default) or `--host=0.0.0.0` — nothing else (`agent/listen.ts`). It records `public: 0|1`
  in its state file as a *number*, because the bootstrap reads that file with `sed` and its
  field reader only knows digits. The preflight prints `FASTVIBE_PUBLIC`, and a running Agent
  that does not fit (wrong port, or `public` not matching the profile) is restarted instead of
  reused. An Agent from before the field reads as loopback.
- **The server's rule moved, but "no password, no server" did not.** `RemoteServer.start` used
  to refuse any non-loopback host when it had a loopback token. It now refuses only when no
  password is set. What makes listening beyond loopback safe is that the loopback token is
  honoured only for a socket whose *peer address* is loopback (`#attach`), so a phone
  presenting it is refused — `test/agent-listen.test.ts` connects to this machine's LAN
  address to prove it, because a loopback connection would pass either way.
- **An Agent too old for `--host` is reported, not restarted forever.** It ignores the flag
  and stays on loopback; the next connect would read that as a mismatch and restart it again.
  The bootstrap checks `public` after the start and fails with 版本过旧. Publish an
  `agent-runtime-v*` containing `--host` *before* a desktop build that ships this.
- **启动 Agent** (in the row's 更多 menu, with 测试 and 停止) starts the Agent without a
  project. It is `openSshAppTransport`, the connect a new project makes, with its tunnel closed
  again at once — one initialisation path, and the first project added later finds the Agent
  running and skips the deploy. `ssh:agent-progress` carries the script's own lines to a toast
  during a deploy that can take minutes. It is a push channel, so it is *not* in
  `remote-policy.ts` (the table holds registered methods); `ssh:start-agent` and
  `ssh:set-phone-access` are, and are denied remotely like the rest of SSH management.
- **The QR code is `publicUrl`, else `http://<hostName>:<port>`.** `hostName` (resolved) before
  `host`, which may be an ssh_config alias only this machine understands. A `publicUrl` must be
  an http(s) *origin* (`normalizePublicUrl`): the phone adds a machine by origin and would
  silently drop a path. The pane says so where it matters: an **iPhone refuses plain `http://`
  outside the local network** (ATS allows only `NSAllowsLocalNetworking`), and without
  `publicUrl` the password crosses the network in the clear — put https in front.
- **The port is the user's to open.** The pane names the firewall and the cloud security group
  and does nothing about them.
- Preview: `mock.html?phone=on#/settings/ssh` shows a host that already allows phone connections;
  starting an Agent and turning phone access on both play their progress.

## 账号登录（FastVibe 账号，`engine/account.ts`）

桌面端可以登录 `app.fastvibe.dev` 的账号（服务端在私有仓库 `tyuan511/fastvibe-services`，
`services/cloud`，设计见该仓库 `docs/cloud-service.md`）。目前登录只表明「这台电脑是谁的」，
**不配置任何供应商**——模型转发（`/llm`）还没做，做了之后令牌才会被拿去当 API Key。

流程是原生应用的浏览器授权码 + PKCE（RFC 8252 / 7636）：

1. 本机在 `127.0.0.1:<空闲端口>/callback` 起一个只绑回环的监听，用系统浏览器打开站点的
   `/authorize`，带 `client_id=fastvibe-desktop`、PKCE 挑战、随机 `state`、设备名。
2. 浏览器里没登录就先走 GitHub 登录再回来；用户点「允许」，站点把浏览器重定向回监听地址并带一次性 `code`。
3. 监听核对 `state`，用 `code` + 只存在于本进程的 verifier 向 `POST /api/oauth/token` 换设备令牌
   （`fvs_…`，90 天，用一次顺延）。浏览器标签页显示「登录成功，可以关闭」，Main 同时
   `app.focus({ steal: true })` 把窗口拉回前台——这就是「登录完拉起客户端」。

- **令牌只在 Main。** 存 `account.json`（0600，临时文件 + rename），**从不经任何方法返回**：
  渲染层只拿 `AccountState`（谁登录了、头像、邮箱）。令牌记录它的签发站点，换了
  `FASTVIBE_CLOUD_URL`（本地开发指向本地服务）就当作未登录，**不会把真令牌发到另一个站点**；
  `logout` 也不会删别的站点的文件。
- **监听只认自己的那一次。** `state` 不对（别的标签页、端口扫描）只回 400 不终止等待；`Host` 必须是
  我们给出的回环地址（挡 DNS 重绑定）；只有 `GET /callback` 有应答；5 分钟超时；用完即关。
  取消、超时、站点拒绝都落回「未登录」，取消与用户在浏览器里点「取消」不算错误。
- **换令牌用回调实际到达的地址，不用自己发出去的那个。** 站点把授权码绑在签发时的 `redirect_uri` 上，
  换令牌要原样交回。我们发出的是 `127.0.0.1`，但站点的 Next 中间件（`NextURL`）会把 URL 里第一个回环地址
  改成 `localhost`，查询串也不例外——未登录时经过登录页的那一趟，码就签给了 `localhost`。于是监听按
  `Host` 头把到达的地址（两种写法之一）连同 `code` 一起交出来。写死 `127.0.0.1` 的结果是：每个人的第一次
  登录都是 `invalid_grant`，重试（已登录，不经过登录页）才成功。网站那边也改了（`login-card.tsx` 在浏览器里读
  `return_to`），这里是兜底。
- **启动不依赖网络。** 文件里有令牌就直接显示已登录，之后后台 `refresh()` 核对：401 才清掉，
  离线 / 5xx 保持登录。登出先清本地，再尽力 `POST /api/auth/logout` 吊销该设备。
- **IPC**：`account:get|login|cancel-login|logout` + 推送 `account:state`。`login` 在浏览器打开后就返回，
  结果走推送。全部在 `remote-policy.ts` 里**拒绝远程调用**（浏览器开在宿主机上、令牌属于那台电脑），
  推送在 `remote-events.ts` 归为 `drop`。
- **UI**：侧栏底部那一行的最右端（`components/layout/sidebar-account.tsx`）。已登录是头像 + 弹层
  （用户名、邮箱、打开控制台、退出登录），未登录是人形图标 + 登录按钮，等待浏览器时转圈并可取消。
  文案不写登录方式（现在是 GitHub，以后可能不是）。`mock.html?account=in|out|waiting|error` 预览。
- 测试 `test/account.test.ts` 用假站点 + 一个代做「浏览器」的函数跑完整流程；服务端那一半在
  fastvibe-services 的 `internal/httpapi/oauth_test.go`。
