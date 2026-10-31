# 原生版补齐清单

目标：将原生版尚未实现的范围全部补齐。以当前代码、协议调用和测试结果为准；仅有入口、占位文字或历史记录不算完成。
按用户要求只做代码与自动化验证，不使用 computer use。

供应商范围（2026-10-26 用户修正）：仅支持用户配置的自定义端点和 API Key；不支持任何模型订阅登录、订阅令牌或内置订阅供应商。此范围不影响 MCP 服务自身的 OAuth 认证。

执行顺序（2026-10-30 已批准，取代 2026-10-26 的“旧 Electron 导入最后实施”）：本机核心 → 配置与工作区 → Electron 数据迁移 → 远程 / 手机 / SSH。各阶段仍须验收，已有实现不等于全范围完成。桌面、Flutter 与 SSH 使用当前原生 App Server / `fv-protocol` 的精确协议和版本握手；不兼容旧 Electron 服务端、App Protocol、WebRTC 帧或旧 SSH Agent，不做新旧协议双栈。其他 Agent 导入仍保留原有范围；当前证据与待验收项见下方“当前批次”。历史批次只记录当时状态，不再决定实施顺序。

## 待完成范围

- [x] 工作区文件树（macOS）：新建、重命名、删除、多文件夹根目录及草稿同步；代码与定向验收通过。其它平台仍列入交付。
- [x] 工作区 Git：hunk 跳转、多文件夹逐根目录视图、异步结果隔离和提交框状态；代码与定向验收通过。
- [x] 工作区重启恢复（macOS）：逐对话标签、目录展开、文件草稿、预览模式与面板布局持久化；代码与定向验收通过。
- [x] 工作区终端（macOS）：输入法接口、选择复制、历史回滚与颜色细节；代码与定向自动化验收通过。其它平台仍列入交付。
- [x] 工具执行：会话式 `exec_command` / `write_stdin`（管道、PTY、后台会话、超时、取消与清理），macOS 定向验收已通过。Windows PTY 仍列入跨平台交付。
- [x] 上下文：AGENTS.md 分层发现（含多文件夹）、技能发现/加载/管理。
- [x] 上下文：长期记忆；提取、整理、注入、引用统计、清除及设置页的代码与自动化验收通过。
- [x] 技能交互：composer 的 `/` 选择、原子技能徽标、消息/队列徽标及编辑/失败恢复；代码与定向自动化验收通过。
- [x] MCP：核心调用、字段表单、动态目录、诊断、图片产物、OAuth 与安装环境；最终切换前的整体验收仍列入交付。
- [x] 扩展：子 Agent 基础运行、追加输入/等待/关闭/恢复、持久化与任务列表；代码和自动化验收见第二十批。
- [x] 扩展：子 Agent 完整历史 fork、角色模板编辑、模型/工具范围与只读约束；代码和自动化验收见第二十一批。
- [x] 扩展：定时任务；持久化、调度/排队、停止/超时/重启、卡片/编辑/历史与运行对话已接通，见第二十二批。
- [x] 扩展：代码模式基础；隔离 JavaScript、工具编排、输出/等待/取消、权限/角色约束与记录已接通，见第二十三批。
- [x] 扩展：模型端网页搜索；自定义 Responses 模型按需开启，进度/来源/引用、取消与历史恢复已接通，见第二十四批。
- [x] 扩展：代码模式音频 helper 与原生音频内容链路已接通，见第二十九批。
- [x] 内容：macOS 原生浏览器基础、HTML/图片/视频/PDF 文件预览；导航、隔离、范围读取、窗口布局与恢复的代码/自动测试见第二十五批。
- [x] 内容：Office 开发资源下的静态/实时预览、选中引用与内置 CLI 子进程环境；代码和自动化验证见第二十六批，安装包资源/签名仍列入交付。
- [x] 内容：Markdown 数学公式；行内/块级 TeX 节点、常用符号、原始源码复制与安全降级已接通，见第二十七批。
- [x] 内容：辅助对话侧栏入口；复用真实子 Agent 线程、已有转写和生命周期，不创建第二套会话/状态存储。
- [x] 内容：电脑操控已改用 Cua Driver（第五十五批）；macOS、Windows 走驱动，Linux 没有驱动构建，因而连设置入口和基础 `computer` 回退工具都不提供（第五十七批）。浏览器导航控制、主页/搜索模板、下载目录、书签和历史已接通。真实桌面上的端到端验收仍列入交付。
- [x] 设置：个性化 Agent 说明；编辑、保存、跨客户端同步与每轮指令注入已接通。
- [x] 设置：快捷键（macOS）；录入、冲突处理、跨客户端持久化、原生操作分发与回车发送已接通。
- [x] 设置：使用统计（原生对话）；持久账本、公开查询、汇总/分布/活跃度/趋势/模型图表已接通。
- [x] 模型目录：手动与每小时刷新、原子快照、动态参数与价格更新；代码与自动化验收见第十六批。
- [x] 设置：自定义供应商的模型详情编辑；元数据保存/恢复、同步保护、协议继承与思考档位的代码和自动化验收通过。
- [x] 供应商：模型连通性自检；有界普通回复/工具 schema 请求、错误脱敏、并发与断连清理已接通。
- [x] 设置：导入页已提供技能/MCP 实际入口，并可扫描/预览/导入五类 Agent 会话；浏览器控制、网络代理、偏好恢复默认、诊断信息和应用更新检查已接通。远程、账号与 SSH 页已接入实际后端，验收范围单列如下。
- [ ] 远程：原生账号、LAN、RTC、SSH 与 Flutter 基础通路已实现；真实 LAN 与本地 TURN 互操作已通过定向验证。完整手机富内容/工作区对齐与真实 SSH 主机仍待验收；发现/QR 的代码与夹具测试通过，但真实 mDNS 因环境多播不可达而 BLOCKED，范围见当前批次，不兼容旧协议。
- [x] 数据：错误项持久化、失败回合恢复及压缩后的重试定位；代码与定向自动化验收通过。
- [x] 数据：压缩窗口自适应；代码与自动化验收通过。
- [x] 数据：其他 Agent 导入；Claude Code、pi、Codex、OpenCode 与 zcode 的扫描、预览和“导入为新对话”已接入 `fv-import` 与 `import/scan|read|commit`，并用源记录稳定键做用量去重；历史导入来源已持久化到 `Thread.source` 并显示在侧边栏，六个格式/缺失源回归用例通过。
- [x] 外围：i18n 已收口（第四十七至五十四批）；Dock 角标、保持唤醒、自动归档和后台回合通知已接通，见第三十四至三十七批。
- [ ] 交付：macOS arm64 测试包与独立更新已接通；Developer ID 签名、Apple 公证、票据和 Gatekeeper 已通过真实 CI 与下载复核；真实线上升级、Windows/Linux 和切换前的全范围验收仍待确认。OfficeCLI 与原生 office 技能已随 macOS 测试包分发，资源哈希和二进制重签后的包校验已接通。
- [x] 对齐：标题栏状态（第五十一至五十三批）、工具详情、菜单样式（第五十批）；进度文档已更新。
- [x] 转写：滚动吸顶的用户提示词（turn-scoped sticky，含玻璃浮层色近似）；纯函数、无头 GPUI 与截图验收见第五十六批。
- [ ] Electron 迁移：只读扫描、私有 DB/WAL 快照、显式 API Key 选择、会话/项目/供应商/映射设置与用量导入已实现；较早 importer 12 项、store 6 项通过；独立审查发现 5 个具体缺陷，涉及重复导入、凭据回滚、恢复与设置保真度，相关缺陷已修复；store 恢复 4 项与最终冻结 server lib 163 项通过（含 migration 夹具 1 项，不重复累计）；最终只读审查在发布/恢复、语言枚举、用量归属与关闭自动归档的已审范围内无剩余发现。范围内修复与复审通过，完整产品切换验收仍保留。DAG / 检查点 / 队列 / 定时任务只归档，不激活；用户图片只归档。不能称为无损完整运行时迁移。

当前设置页已接通账号、远程访问与 SSH 主机管理；电脑操控设置也已接线，但真实系统权限与输入尚未验证。Flutter 已有可工作的原生协议基础页面，尚未达到完整富内容与工作区对齐。macOS arm64 是目前唯一验证的平台；已有签名/公证包的历史证据不代表最新源码已验收，真实签名线上升级仍待完成。模型订阅 OAuth 不在目标内，MCP OAuth 继续保留。

## 当前批次：本机收口、Electron 迁移与原生远程（2026-10-30，验收进行中）

本批依批准顺序推进。下表记录协调方确认的分批结果；本次文档编辑未运行 Cargo 或 Flutter。通过项不重复累加，分批结果不代表一条最新全 workspace 命令通过。最终功能测试与冻结二进制 journey 之后又做了 store / server 的机械 lint 清理并格式化，没有新增功能；随后仅格式、git diff 与生成文件一致性检查通过；协议 snapshot 属于先前 22 项通过的证据，未完成新的 cargo check / Clippy，也未完整重跑功能测试。因此下方功能 PASS 是所记录测试/二进制的证据，不能宣称最后编辑后的源码已全量通过。

最终冻结 server lib **163 PASS / 0 FAIL / 1 ignored，22.71 秒**（ignored 为需真实多播的 mDNS 用例），已包含 migration 夹具与 official 5 项。取消生命周期已用异步任务完成屏障修复；另行 filtered official 5 项也通过（0.12 秒），不重复累计。[冻结 lib 日志](/var/folders/pn/t3byzrs54sg7wy7qqd4cznvc0000gn/T/zcode-bash-Bj5Laf/sess_subagent_agent_0dc02dc2-a002-427c-b591-b4adcb865a89/call_3f339b50597448a1a0bd2ac2d144d381-stdout.log)。较早中央联合回归 211 项曾通过（lib 162 + approvals 4 + e2e 9 + providers 14 + questions 7 + settings 11 + subagents 2 + terminal_reconnect 2），[旧批日志](/var/folders/pn/t3byzrs54sg7wy7qqd4cznvc0000gn/T/zcode-bash-Bj5Laf/session_71823f52e429294de38301d1341b17d8/call_3d420a7d99b74bee9d32562682cd1683-stdout.log) 不冒充最终冻结树的全部集成结果；最终指定 5 个集成目标 **19 PASS / 0 FAIL**（browser 3 / computer 3 / context_fork 1 / remote 2 / turns 10），包含最新双栈、LAN 认证/文件分片/撤销；[集成日志](/var/folders/pn/t3byzrs54sg7wy7qqd4cznvc0000gn/T/zcode-bash-Bj5Laf/sess_subagent_agent_0dc02dc2-a002-427c-b591-b4adcb865a89/call_dab83c13ff464bbbbe44fa1532abc475-stdout.log)。最终协议/schema 在普通非更新模式 **22/22 PASS**，含 committed snapshot，日志 `/tmp/fv-protocol-final-tests.log`；Node 生成器新鲜度测试 **1 PASS**。

GUI / browser 最新 **221 项（GUI 212 + browser 9）、all-targets check 与严格 Clippy 全部 PASS**；严格 Clippy 用时 4.61 秒，日志 `/tmp/fv-profile-final-clippy2.log`（第一方零告警；vendor gpui 文档告警不计入第一方门禁）。较早 GUI 212 项（168 单元 + 44 集成）与严格 Clippy 通过的日志为 `/tmp/fv-gui-latest-{check2,tests2,clippy2}.log`，不作为后续源码的最终门禁。

支持包模型发现最终 **8/8 PASS**：首轮预期 `localhost:1` 拒绝连接的用例被宿主代理改成 502，使用同一测试二进制、同时设置 `NO_PROXY=localhost,127.0.0.1,::1` 与 `no_proxy=localhost,127.0.0.1,::1` 后通过，日志 `/tmp/fv-model-discovery-final-retest.log`，未修改应用代理行为。Provider lib **28 PASS**；同批当前源码编出的测试可执行文件另行运行 updater **9 PASS，25.98 秒**（`/tmp/fv-native-update-binary-final-tests.log`）和 tools **35 PASS，1.18 秒**（`/tmp/fv-native-tools-binary-final-tests.log`）。tools 仅 lib 单测，这个二进制未运行 session 集成；不把首轮在 fetchModels 停止的组合命令称为通过。core 最终严格 Clippy **BLOCKED（环境 / 验证未完成），没有成功结果**，详见下方阻塞证据。

| 范围 | 已实现与验证证据 | 尚需完成的验收 |
| --- | --- | --- |
| 本机核心与供应商流 | [真实进程 journey](../scripts/native-core-journey.mjs) 覆盖配置、流式回复、Stop、重试/编辑、fork、长 patch、文件冲突、Git 与重启；较早 8/9 暴露工具参数增量缺失。[Provider 修复](../native/crates/fv-provider/src/model.rs) 后 18 项流式测试通过，最终冻结二进制（包含最新迁移/取消修复）的 `--keep` 真实 server journey **PASS 9/9，4.517 秒**；patch 104,214 字节、diff 104,513 字节 / 641 行，未放宽断言 | [临时留存报告](/private/var/folders/pn/t3byzrs54sg7wy7qqd4cznvc0000gn/T/fv-native-journey-Bhbaet/validation-report.json)、[运行日志](/tmp/fv-native-frozen-core-journey.log)；临时文件可能被清理，复现用下方仓库脚本命令；不是 GUI 验收 |
| 配置与工作区 | [onboarding](../native/crates/fv-gui/src/workspace/onboarding.rs) / 供应商配置、工作区恢复、[电脑操控设置](../native/crates/fv-gui/src/workspace/computer.rs)、浏览器、文件树/预览及[远端媒体](../native/crates/fv-gui/src/workspace/remote_preview.rs)已有代码；最新 GUI / browser 221 项（GUI 212 + browser 9）、all-targets check / 严格 Clippy 全部 PASS，日志见上 | 冻结 server lib 163 与指定集成 19 通过；core 最终严格 Clippy **BLOCKED（环境 / 验证未完成）**，电脑操控真实权限和输入未验证 |
| Electron 迁移 | [只读快照](../native/crates/fv-import/src/electron.rs) 复制 DB + 已提交 WAL 到私有目录后读取，检测源变化；[导入实现](../native/crates/fv-server/src/import/electron.rs) 区分 import / archive / exclude，API Key 默认不复制；较早 importer 12 项、store 6 项通过；独立审查已发现 5 个缺陷，涉及重复导入、凭据回滚、恢复、设置保真度 | 修复后 store 恢复 4 项与 server migration 定向 1 项通过；独立只读复审 **PASS（发布/恢复、语言枚举、用量归属、关闭自动归档的已审范围无剩余发现）**；冻结 server lib 163 项通过（含 migration 夹具，不重复累计）；迁移范围内证据已补齐，完整产品切换仍待验收。不支持的活跃 DAG / 检查点 / 队列 / schedule 与用户图片仅归档，不能称为无损完整运行时迁移 |
| LAN 与 Flutter | [Rust 真实 socket 用例](../native/crates/fv-server/tests/remote.rs) 2 项通过；[真实 Flutter → Rust LAN](../apps/mobile_flutter/test/native_server_interop_test.dart) 已通过认证、重连 resume 与文件下载。validator 集成后最终 Flutter 全套 **279 项通过、1 项环境条件跳过，analyze 零问题，i18n check PASS**；另行带真实 Rust server 环境的 LAN interop **1 项通过（6 秒）**，不与全套重复累加；已实现产出文件 chip 与 Markdown 路径的直接打开/下载 | 最新 remote 2 项已纳入指定集成 19 PASS；mDNS 真实多播 BLOCKED（见下），手机真机与完整富内容对齐仍待验收 |
| SSH | [驻留服务 relay](../native/crates/fv-daemon/src/ssh.rs) 与 GUI 主机/项目入口已接通；[进程夹具](../native/crates/fv-daemon/tests/ssh_gui.rs) 4 项通过，真实 server 的聊天/终端在 relay 断开后保留 | 使用 fake OpenSSH 包装执行本地真实进程，**没有连接真实 SSH 主机**；真实安装、网络断连和远端平台仍待验证 |
| 账号 / RTC | [fv-rtc](../native/crates/fv-rtc/src/lib.rs) 的 12 项 Rust 测试通过（包含新增 4 项后台 STUN 刷新生命周期用例；前批严格 Clippy 已通过）；[Flutter 互操作夹具](../native/crates/fv-rtc/tests/flutter_interop.dart) 使用 Flutter 3.47.6 的真实 macOS native runner、随产品使用的 `flutter_webrtc 1.6.2+hotfix.4`，强制本地 TURN：initialize、128 KiB 回复、relay stats **PASS** | 本地 TURN 证据不覆盖真实云账号、跨公网 / 网络切换与移动设备全流程；冻结 server lib 中 official 5 项已通过（filtered 5 项亦复验通过，不重复累计），core 最终严格 Clippy **BLOCKED（环境 / 验证未完成），不是 PASS** |
| 更新与平台交付 | [更新器与安装脚本](../native/crates/fv-update/src/lib.rs) 最终当前测试可执行文件 9 项通过（25.98 秒），含安装/早退进程夹具；日志 `/tmp/fv-native-update-binary-final-tests.log`；历史 macOS arm64 签名、公证证据见文末 | 真实签名线上跨版本升级未验证；Windows / Linux / macOS x64 未验证；整个原生版尚未全部完成 |

手机当前是功能可用的朴素原生切片：[NativeClient](../apps/mobile_flutter/lib/protocol/native_client.dart)、[NativeRtcDialer](../apps/mobile_flutter/lib/protocol/native_rtc.dart) 和 [NativeServerScreen](../apps/mobile_flutter/lib/screens/native_server.dart) 提供独立原生身份路由、会话、流式回复与交互；[产出文件组件](../apps/mobile_flutter/lib/chat/native_output_files.dart) 已从成功工具/文件变更显示文件 chip，并解析回复中的 Markdown 本地路径，直接进入打开/下载通路，无需手填路径；[定向测试](../apps/mobile_flutter/test/native_output_files_test.dart) 覆盖此入口。Markdown 回复已复用渲染器，但不能据此声称 Office、终端、所有富媒体和工作区功能均已对齐。发现/扫码中的原生身份见 [Rust mDNS](../native/crates/fv-server/src/remote_discovery.rs)、[桌面 QR](../native/crates/fv-gui/src/workspace/remote_qr.rs) 与 [Flutter discovery](../apps/mobile_flutter/lib/protocol/discovery.dart)；原生握手失败不会回退到旧协议。

浏览器 CDP 对未知/失效 tab 回退选错页面的问题已在 [cdp.rs](../native/crates/fv-browser/src/cdp.rs) 修复，browser 9 项与最新 server browser 集成 3 项通过；真实浏览器端到端操作仍未验收。

core 最终严格 Clippy **BLOCKED（环境 / 验证未完成），不是 PASS**。初轮 store / server 机械 lint 已修正并格式化；缓存重跑的两个 worker 超过 7 分钟保持 0 CPU，[进程采样](/tmp/fv-final-server-lint-sample.txt) 显示 `dyld dlopen → mapSegments → fcntl` 停在 `tracing_attributes` proc-macro 动态库加载。协调方停止自己的运行后，用相同字节的新 inode 缓存副本做一次有界重试，仍等待且无新诊断，已停止；只改缓存副本，未改变应用功能或系统安全设置。[clippy2 日志](/tmp/fv-native-core-final-clippy2.log)、[clippy3 日志](/tmp/fv-native-core-final-clippy3.log)、[clippy4 日志](/tmp/fv-native-core-final-clippy4.log) 中最后一次仍不完整，不能视作成功。没有遗留验证进程；最终 `fmt --check`、`diff --check` 与生成器新鲜度检查通过，机械清理后未完整重跑功能测试，不宣称全绿。

真实局域网发现 **BLOCKED（环境），不是 PASS**：[mDNS](../native/crates/fv-server/src/remote_discovery.rs) 已有 2 秒接口监控，fake publisher 2 项通过；显式启用的真实多播用例在 9 秒内没有初始/改名记录。`mdns-sd` monitor 报告 en1 / bridge Announce 而无错误，但绑定这些接口向 `224.0.0.251:5353` 原始发送返回 `EHOSTUNREACH`（errno 65），同时 OS `dns-sd` 注册/浏览能工作。未修改权限或网络设置；本机多播环境仍阻止原生库的真实发现验收，不能由 fake 测试或 LAN socket 成功推出 mDNS 通过。

实际最新开发 fixture 窗口启动/截图已通过（2200×1440）：[远程页](/tmp/fv-native-final-remote.png)、[SSH 页](/tmp/fv-native-final-ssh.png)。开发 fixture 的临时可执行文件缓存问题已修复，稳定路径复查退出 0（6.21 秒），[复查截图](/tmp/fv-native-final-stable-recheck.png)。最新 profile 修复后实际 fixture 启动也 PASS（6.66 秒，2200×1440），[最终远程页截图](/tmp/fv-native-profile-final-remote.png)；稳定捕获路径的可执行文件签名校验通过。这些 fixture 没有 live backend；窗口启动与截图不代表连续 GUI 操作验收。

### 复验入口与协调方回填

以下为从仓库根运行的复验命令，**不是本批最终通过声明**；使用协调方已构建的 server 路径可避免并行构建争用。RTC 的真实 Flutter runner 需要依夹具头部说明准备临时 macOS 工程、本地 TURN 和网络 entitlement。

```bash
# Rust 门禁与真实进程 journey；本批最终结果由协调方回填
cargo check --manifest-path native/Cargo.toml --workspace --all-targets
cargo clippy --manifest-path native/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path native/Cargo.toml -p fv-gui --lib --tests
node scripts/native-core-journey.mjs /absolute/path/to/fresh/fastvibe-server --keep

# 分批证据入口；不要把选择性测试写成全 workspace 通过
cargo test --manifest-path native/Cargo.toml -p fv-provider --test openai_chat --test openai_responses --test anthropic --test gemini
cargo test --manifest-path native/Cargo.toml -p fv-provider --lib model::tests
cargo test --manifest-path native/Cargo.toml -p fv-import
cargo test --manifest-path native/Cargo.toml -p fv-store --test usage
cargo test --manifest-path native/Cargo.toml -p fv-server migration
cargo test --manifest-path native/Cargo.toml -p fv-server --test remote
FASTVIBE_SERVER_BIN=/absolute/path/to/fresh/fastvibe-server cargo test --manifest-path native/Cargo.toml -p fv-daemon --test ssh_gui
cargo test --manifest-path native/Cargo.toml -p fv-rtc
cargo test --manifest-path native/Cargo.toml -p fv-update

# Rust schema 与 Dart 方法元数据/校验器；尚非完整 typed DTO 生成
cargo test --manifest-path native/Cargo.toml -p fv-protocol
UPDATE_SCHEMA=1 cargo test --manifest-path native/Cargo.toml -p fv-protocol schema
node scripts/generate-native-protocol.mjs
node scripts/generate-native-protocol.mjs --check

# 以下在 apps/mobile_flutter 目录运行
flutter analyze
flutter test
FASTVIBE_TEST_SERVER_BIN=/absolute/path/to/fresh/fastvibe-server flutter test test/native_server_interop_test.dart
```

最终协议/schema 普通非更新模式 **22/22 PASS**，日志 `/tmp/fv-protocol-final-tests.log`；生成器新鲜度 **1 PASS**。最新 schema 已含发现的 `RemoteConfig.name` 与 `RemoteStatus.name/installId`，Dart 元数据已重新生成；本次元数据变化后的 Flutter analyze **0 问题**、native protocol / discovery / native RTC 定向 **11 PASS**、实际带最新 Rust server 的 LAN interop **1 PASS（5 秒）**；没有在仅元数据变化后重跑全套 279 项，不重复累计。[Rust schema 生成入口](../native/crates/fv-protocol/src/tests.rs) 产出 [protocol.json](../native/schema/protocol.json)，再由 [generate-native-protocol.mjs](../scripts/generate-native-protocol.mjs) 生成覆盖 **142 个方法**的 [Dart 方法元数据与 schema 校验器](../apps/mobile_flutter/lib/protocol/native_schema.dart)，参数/响应运行时校验已集成到 [NativeClient](../apps/mobile_flutter/lib/protocol/native_client.dart)。这项生成与运行时校验已经存在；它不是完整的强类型 Dart DTO 生成器。集成后的最终 Flutter 回归已通过：279 通过 / 1 环境跳过、analyze 0、i18n check PASS；另行真实 Rust LAN interop 1 项通过（6 秒）。校验失败令 pending 请求悬挂的问题已修复并加入回归，不重复累加覆盖用例。

| 最终批次证据与回填项 | 当前状态 |
| --- | --- |
| 最新 GUI / browser 测试、all-targets check、严格 Clippy | **PASS — 221 项（GUI 212 + browser 9）**；最终严格 Clippy `/tmp/fv-profile-final-clippy2.log`；实际 fixture 捕获也通过 |
| Provider 修复后重建 server 的完整 journey | **PASS — 冻结二进制 9/9，4.517 秒**；`--keep` 报告、日志与可复现命令见上 |
| Flutter 全套 / analyze、RTC、协议/schema | validator 集成后 **PASS — Flutter 279 + 1 环境跳过 / analyze 0 / i18n check；另行实际 Rust LAN interop 1 项（6 秒）；RTC 12；协议/schema 22；生成器新鲜度 1**；实际 Flutter 强制 TURN 仍 PASS；最后 name/installId 元数据变化后 **PASS — 定向 11 / 实际最新 Rust LAN interop 1（5 秒）/ analyze 0**；全套 279 未重复运行，不重复累计 |
| 最终冻结 server lib 与指定集成 | **PASS — lib 163 / 0 failed / 1 ignored，official 5 已包含；指定 5 个集成目标 19 PASS**；不叠加较早 211 项或 filtered 复验 |
| 真实 mDNS | **BLOCKED（环境）— 多播发送 EHOSTUNREACH / errno 65；不是 PASS**；fake publisher 2 项与 2 秒接口监控不替代真实验证 |
| Electron 独立审查后的修复、回归与复审 | **PASS（已审范围）— store 恢复 4 项 / migration 夹具 1 项（包含在 lib 163 内）；最终只读审查在发布/恢复、语言枚举、用量归属、关闭自动归档范围内无剩余发现**；完整产品切换仍待验收 |
| core 最终严格 Clippy 与支持包回归 | 模型发现 **8/8 PASS**、Provider lib **28 PASS**、updater **9 PASS**、tools **35 lib PASS**（不含 session 集成）；**BLOCKED — core 严格 Clippy 环境加载停滞，验证未完成，最后重试未成功；功能测试后机械清理未完整重验** |

## 已存在的基础（不重复实现）

对话、队列/插话、分叉/重试/检查点、项目/多文件夹/worktree、搜索、模型与价格、文件预览与编辑、Git 树与并排 diff、PTY 终端、24 套主题和玻璃效果已有实现。
它们仍须随相关改动验证，不能据此宣称整个原生版完成。

## 已落地的第一批

- 每轮按会话 cwd 和项目的其它文件夹读取 AGENTS.md；支持 override、空 override 回退、目录作用域和内容去重。
- 技能从项目、私有、全局、内置目录发现，按名称覆盖并显示冲突原因；普通请求只加载元数据，`/skill:名称` 加载全文。
- 公共协议支持技能列表、全文、创建、单个/集合导入、删除；变更通知各客户端。只允许删除私有目录中添加的技能。
- 设置 → 技能已接通上述协议；异步响应核对请求与设置页实例，避免晚到结果覆盖新的页面。
- 导入保留支持文件；重名不覆盖，批次失败清理本次新建目录，符号链接与特殊文件不会被悄悄复制到其它位置。
- 新增 context 测试覆盖层级、覆盖、刷新、跨会话隔离、多文件夹、批次回滚、重启发现和真实协议到模型请求的通路。

验证记录：GUI 编译、`fv-server` / `fv-gui` / `fv-protocol` 的 all-targets clippy（`-D warnings`）、workspace 格式及 diff 检查已通过。
服务端回归发现的自定义 system 指令顺序问题已修复，相关 turns/context 测试通过。新增 6 个 context 测试和 1 个阻塞读取取消测试均通过。
完整 workspace 的 386 个主测试及全部文档测试通过（退出码 0），1 个子进程夹具按原设计忽略；另外新增的阻塞读取取消测试单独通过。
验证日志为 `/tmp/fastvibe-native-goal-tests.log`，clippy 日志为 `/tmp/fastvibe-native-goal-clippy.log`。
GUI 的 rustdoc 曾较长时间等待宏动态库加载；保留原验证进程等待后正常结束，没有跳过或禁用文档测试。
测试中的 localhost 请求曾被本机代理改成 502；仅在测试进程设置 `NO_PROXY=localhost,127.0.0.1,::1` 和同值 `no_proxy` 后复现用例通过，未修改应用的代理行为。
完整目标保持进行中，未完成项仍需实现和验证。

## 第二批：MCP（核心与设置已接通；安装环境补齐见第三批）

- 使用官方 Rust SDK `rmcp`；stdio 与 Streamable HTTP，每个服务端进程维护一组连接，所有会话共享。
- 工具接入现有 registry/deferred/tool_search，保留工具结果中的图片、结构化内容和失败标记；补齐资源与资源模板的列举和读取。
- 连接在后台建立，握手有界；停止回合取消调用，服务端退出后状态变为断开。保存、重连和退出通过代次检查清理旧连接，避免迟到连接复活。
- stdio 只继承必要环境加显式配置；配置与凭据不进入普通 settings 广播。公共协议穷举处理和远程策略分类同步更新。
- 设置页提供配置、JSON 导入、启停、状态、逐服务重连与 OAuth 登录/退出。
- 测试使用真正的本地 MCP 测试服务，覆盖握手、工具/图片/错误、资源、取消、断连、配置竞态和重启恢复。

SDK API 以[官方 Rust SDK](https://github.com/modelcontextprotocol/rust-sdk)及其当前文档为准。
新增 `fv-mcp` crate，锁定 `rmcp =3.7.0`：Rust 最低 1.88，HTTP 使用 reqwest 0.13，与现有依赖对齐。
客户端入口是 `ClientServiceExt` / `ClientConfig`；连接由 `RunningService` 持有，`Peer` 可供工具共享。
该版本的高级请求使用取消即丢弃的 guard，已用本地 MCP 进程验证收到取消通知，之后仍能继续调用。

已接通：

- 共享 stdio / Streamable HTTP 连接，10 秒连接上限；请求 60 秒上限，停止回合取消在途请求。子进程环境清空后仅继承白名单和显式 env。
- 各回合复制工具目录并持有连接快照；配置变更保留未变服务，退役连接供已有回合收尾，退出时一并取消。代次检查拒绝迟到的连接结果。
- 延迟工具进入现有 BM25 `tool_search`；工具与服务器指南使用同一次快照。图片、结构化内容和 isError 保留，超长文本存入 0600 文件，模型内仅保留有边界的内容。
- 资源、模板、分页、读取接入模型工具和公共 RPC。慢资源读取独立处理并限制每连接 16 个，不阻塞停止或问题答复；断连撤回在途读取。
- `mcp/list|set|update|import|reconnect|resources|resourceTemplates|readResource` 和空载荷 `mcp/changed`。配置写入独立 0600 文件，不进入 app settings。
- 设置 → MCP 提供状态、JSON 导入/完整编辑、启停、删除确认、重连和资源查看。专用 list 请求按旧版信任模型返回 env/headers 供编辑；推送不携带这些值。
- 排队回合等待有界的 MCP 连接过程，交互回合保留 3 秒启动宽限。握手修正为仅成功 initialize 后开放方法，孤立 initialized 通知不能绕过门禁。

已通过第一轮：5 个 MCP 客户端测试、1 个真实 HTTP 传输测试、2 个公共协议到模型回合测试，以及 11 个队列和 1 个上下文取消测试。
本批继续补齐：

- 服务器发送 `notifications/tools/list_changed` 后，后台合并通知并重新读取工具目录；新回合使用新目录，已开始回合的工具 schema 不变。无效目录保留最后有效版本并显示错误。
- stdio 的 stderr 持续排空，只保留 32 KiB 尾部，已配置的环境变量/请求头值做脱敏；设置页可查看诊断。启动失败与进程退出前的尾部输出也保留，继承管道的子进程不能无限拖住清理。
- 模型不能看图、超过 8 张或单张 base64 达 12 MiB 的图片保存到私有结果目录，返回文件路径；文件 0600、目录 0700。解码在阻塞线程执行，保存失败如实标记工具错误。
- 设置页支持逐项编辑命令/参数/环境变量/地址/请求头、启用和延迟加载，敏感值默认遮住；JSON 导入与完整配置编辑保留。
- 新增 `mcp/update`：在服务端锁内比较原配置，仅修改对应 id；并发编辑其它服务器不会互相覆盖，同一配置被改后拒绝陈旧保存。启停和删除使用同一路径。
- HTTP 自定义凭据头标为敏感，只跟随同源、有限次数的重定向；GUI 要求 `mcpConfigEdit` 能力，避免复用不支持新保存接口的空闲旧服务端。

OAuth 前完整回归（`83635`，已结束）记录为 400 项通过、1 项 HTTP 用例失败、1 项夹具按原设计忽略，文档测试通过。
失败发生于首个请求发出前的系统 HTTP 客户端初始化；移到阻塞线程后计时器正常工作。随后通过可注入 ClientBuilder 显式隔离 HTTP 测试的系统代理初始化；同源跳转策略由 Manager 统一追加。
本批两次新编译的真实 HTTP 测试均通过（2 项，约 0.23 秒），覆盖同源跳转与跨源自定义凭据保护。

### OAuth 与客户端回调

- 公共协议 `mcp/auth/begin|complete|cancel|forget`，授权流程归调用连接所有；发现与换令牌在有界异步任务中执行，不阻塞 Stop。断连会清理未完成授权。
- GUI 在自己的机器打开授权页并绑定回环回调端口，适用于连接远端 server；回调先检查 Host 与 state，再由服务端校验精确 URI、state、issuer、PKCE 与单次使用。
- 支持动态客户端注册和手动 Client ID/Secret；保留 confidential DCR 的 client secret，重启后仍能刷新。
- 凭据按 MCP id 和完整服务地址隔离，私有文件 0600、目录 0700，原子替换；公共列表只报告是否保存 OAuth，令牌与 client secret 不返回客户端、不进入 settings 或推送。
- 同一凭据的刷新串行化并保存旋转后的 refresh token；暂时失败保留凭据，invalid_grant 清除并要求重新登录。
- 退出/重新授权使用代次隔离，正在刷新的旧连接不能重新写回令牌；配置变化与取消后的旧授权不能提交，删除或更换服务地址会清除旧地址的凭据。
- 配置中显式填写的 Authorization 请求头优先使用；OAuth 登录入口要求先移除该头，避免两套认证相互覆盖。
- GUI 登录支持可选 Client ID/Secret、权限范围、取消、重新打开授权页及退出；要求 `mcpOAuth` 能力以替换空闲旧后端。

验证：`fv-mcp / fv-server / fv-gui / fv-protocol` all-targets clippy（`-D warnings`）通过，日志 `/tmp/fastvibe-mcp-oauth-clippy.log`。
`98261` 已退出 0：85 项定向回归通过（MCP 客户端 10、HTTP 2、OAuth 4、协议/schema 12、server 单测 42、上下文取消 1、公开 MCP 集成 3、队列 11）。日志 `/tmp/fastvibe-mcp-oauth-gate-tests.log`。
OAuth 使用真实本地 AS/MCP 服务验证 PKCE、回调归属、错误 issuer、重复参数、取消/断连、重启、secret 保留、刷新旋转、暂时/永久错误、退出刷新竞态和地址隔离。
两个 GUI 后端回调网络测试已通过（`20703` 退出 0）：非法 Host/state 不消耗合法回调，关闭登录取消远端流程并释放本机监听；日志 `/tmp/fastvibe-mcp-oauth-gui-tests.log`。不使用 computer use。
补查发现回调已进入令牌交换时，原取消路径只清理等待队列，不能阻止稍后落盘。已让取消控制随交换一直保留到提交，并把容量许可保留到提交结束；单个取消、断连、配置变化及关闭服务都能使未提交的交换失效。新增延迟令牌交换测试验证取消/断连后原登录不被覆盖。
该补充修复最终验证通过（`11929` 退出 0）：all-targets 严格 clippy 与 5 个 OAuth、3 个公开 MCP 集成测试通过；日志 `/tmp/fastvibe-mcp-oauth-final-clippy.log` 与 `/tmp/fastvibe-mcp-oauth-final-tests.log`。本批累计覆盖 88 个不同用例（85 项定向回归 + 2 项 GUI 回调 + 1 项换令牌取消竞态），最后的控制改动重跑了 OAuth 与公开协议用例。
本批验证进程均已结束，没有遗留的验证任务需要重启。

## 第三批：会话式命令与安装环境

- 各 `ThreadRuntime` 持有独立 `ExecSessions`，`exec_command` 可在 yield 后返回 session id；`write_stdin` 后续输入或轮询，只返回新输出。正常回合结束和客户端重连保留进程，不能跨对话操作。
- 支持管道和真实 PTY；默认 yield 10 秒，无默认硬超时；显式 `timeout_ms` 等待到完成或到期杀掉，不返回后台会话。管道保留 stdin，单独 Ctrl-C / Ctrl-D 分别中断与关闭输入。
- Stop 取消当前回合操作的进程；删除对话、服务端退出或丢弃会话池清理进程组。启动/交互 future 被丢弃也会终止正在操作的进程；输入满队列可被取消，不遗留阻塞读写线程。
- 64 个运行进程上限，先保留容量再启动；每流独立解码 UTF-8，输出头尾合计 1 MiB，按调用预算截断。修复了 stdin 副本阻止 EOF 和末行换行导致截断丢尾的问题。
- 延续现有沙箱和审批；策略收紧后拒绝向权限更宽的旧进程写入普通输入。握手的忙碌状态包含存活命令，阻止升级误杀后台命令；GUI 要求 `execSessions` 能力，转写区分输入与输出轮询。
- 新增 `fv-env`：异步读取一次登录 shell 的 PATH / SHELL / locale，不修改多线程进程的全局环境；GUI、daemon、直接启动的 server、MCP、命令与终端共用快照。只保留指定字段，不记录 shell 输出；3 秒与 256 KiB 上限，失败回退并清理探测进程组。没有显式 locale 时补 UTF-8，保留用户的 `LANG=C` 等设置。
- stdio server 也通过 SIGINT / SIGTERM 进入同一清理路径；启动时的环境探测可被信号取消。清理后给 Tokio 运行时 1 秒关闭上限，避免 SSH 客户端仍握着 stdin 时阻塞退出。
- Windows PTY 与平台打包仍未完成，不以 macOS 本批验证代表跨平台完成。

定向验证已结束：`fv-tools` 67 项（含 11 项真实管道/PTY 会话用例）、`fv-server` 4 项公开协议/真实进程集成测试、`fv-env` 5 项测试通过，共 76 项。环境用例实际启动隔离的 zsh 登录 shell，验证 profile 加入的 npx 可被找到，欢迎文字不干扰解析、秘密变量不进入快照，启动超时后父子进程均退出。过短的 150 ms 夹具启动等待曾在冷启动时来不及写 PID 文件，已改用实际的 3 秒探测期限，最终用例通过。
日志 `/tmp/fastvibe-exec-tools-fixed.log`、`/tmp/fastvibe-exec-server-final-tests.log`、`/tmp/fastvibe-shell-env-final-tests.log`。
最终 `fv-env / fv-tools / fv-server / fv-mcp / fv-daemon / fv-gui` all-targets 严格 clippy 通过，日志 `/tmp/fastvibe-exec-env-final-clippy.log`。该定向验证链已退出 0。
额外的 workspace 全量回归已结束（退出 101），日志 `/tmp/fastvibe-exec-env-workspace-tests.log`：310 项通过、1 项失败、1 个子进程夹具按设计忽略。失败是 `fv-server/tests/tools.rs` 的工具注册清单仍缺 `write_stdin`，同一用例的真实文件/命令通路已通过；已更新清单并补跑该用例通过。daemon 的真实启动/重启与环境、GUI、MCP 客户端/HTTP/OAuth、协议和供应商均已通过该轮。后续未跑到的包与本批改动另行回归，不能把这些局部结果称为全量 workspace 通过。

## 第四批：文件树操作

- 公共协议 `workspace/createEntry|renameEntry|deleteEntry`；全局 `workspace/entryChanged` 通知各客户端。GUI 要求 `workspaceEntries` 能力，不继续复用缺少接口的空闲旧后端。
- 路径以所操作的根目录为界，拒绝越界、根目录改名/删除、`.git` 及其大小写变体；解析父目录的真实路径，拒绝符号链接绕到外部或 Git 元数据。符号链接条目本身改名/删除时只操作链接。
- 名称限一个分量、255 个 UTF-8 字节，拒绝空名、点、分隔符及控制字符。新建使用排他创建；重命名使用 macOS `RENAME_EXCL` / Linux `RENAME_NOREPLACE`，文件和目录均不覆盖已有目标，仍允许卷支持的仅大小写改名。
- 默认移到服务端机器的废纸篓；macOS 直接调用 NSFileManager，不使用 Finder 自动化。废纸篓失败原样报错，绝不转为永久删除；永久删除是独立菜单与明确确认。Windows 的排他重命名仍在平台交付范围内。
- 文件系统操作放在阻塞线程；同一连接的变更按到达顺序执行，所有客户端的文件树修改与已有保存调用共用锁。停止、问题答复和读取目录列表等控制请求不被等待中的树操作卡住。操作开始后即使调用者断连，也会通知其它客户端实际发生的变更。
- 文件树显示项目各根目录，worktree 替换主目录；每根按自身边界执行操作，`@` 搜索同样带入其它文件夹。
- 目录改名同时迁移展开状态、子目录列表、文件标签、当前与暂存草稿；删除确认后关闭受影响标签与草稿。全局通知更新各对话，读取代次拒绝迟到的旧目录结果；保存回调只更新原文件的原编辑器，避免晚到结果覆盖其它标签的 dirty 状态。

已通过 49 个 server 单测（其中本批新增 7 项）及 3 个文件树公共协议集成测试，日志 `/tmp/fastvibe-workspace-entries-tests.log`；另 21 个服务端回归通过，覆盖会话式命令、MCP、问题、设置与更新后的工具清单，日志 `/tmp/fastvibe-workspace-entries-regression.log`。
新协议 schema 已生成，12 个协议用例（含快照）通过。GUI 的 30 个无界面单测通过，包含本批新增 3 项目录改名/草稿迁移、删除范围和路径显示用例，日志 `/tmp/fastvibe-workspace-entries-gui-final-tests.log`。GUI 测试编译曾暴露一处跨模块字段可见性遗漏，修正后最终用例通过。
最终 `fv-protocol / fv-server / fv-gui` all-targets 严格 clippy 通过（退出 0），日志 `/tmp/fastvibe-workspace-entries-final-clippy.log`。本批已验证 73 项服务端回归、30 项 GUI 单测与 12 项协议用例。
前轮未跑到的 protocol / store / theme / tools / xtask 已补跑完成（退出 0）：118 项通过，文档测试通过，日志 `/tmp/fastvibe-workspace-entries-remainder-tests.log`。其中 tools 的会话/PTY 用例再次通过；不把分批回归称为一条完整 workspace 命令通过。
废纸篓路由/失败不永久删除通过注入回收函数验证，真实 NSFileManager 路径目前以代码和编译检查为证；没有操作系统界面验证。

## 第五批：逐根目录 Git 视图与差异块跳转

- 每个对话的各项目根目录分别保存 Git 状态、提交草稿/编辑器、历史与分页、所选文件、差异模式和列表/差异/历史的滚动位置。主目录不是仓库时也能通过始终可见的目录栏选择其它仓库；worktree 仍替换主目录。
- 状态、差异与历史请求携带根目录和读取代次。切换文件、刷新、写操作后的旧结果不能覆盖新状态；切换到其它仓库时，迟到结果只更新其原属缓存。
- 暂存、提交和丢弃按钮绑定渲染它的对话与根目录。每个根目录视图同时一个写操作，期间显示活动状态；写入前后使旧读取失效，避免用旧 diff/状态覆盖写入后的结果。
- 补齐提交编辑器 Change 订阅及提交时读取实际值；成功后只清理本次提交的文字，在提交过程中或清理前继续输入的内容保留。
- 差异块使用解析出的 hunk 标题和 GPUI 布局锚点定位，统一/并排模式共用；上一处/下一处首尾循环，初始显示 0/N，与 Electron 版一致。并排模式只在面板足够宽时使用，横向滚动已接入。
- 历史加载合并校验页偏移与固定 tips，重复“加载更多”不重复入队；刷新使旧分页失效。
- 刷新状态或重新选择目录时也后台刷新当前差异，带回原提交 revision；内容未变时保留差异位置与当前 hunk，内容变化后重置，避免拿缓存冒充新的 diff。

最终验证已结束（均退出 0）：GUI 36 个无界面单测通过，含本批新增 6 项缓存归属、旧差异失效、提交草稿竞态、历史分页竞态、循环跳转和后台刷新保持位置；两个临时 Git 仓库的同名文件公共协议测试通过，实际验证暂存/提交只影响第二个仓库，第一仓库仍保留未暂存修改，历史和差异分别读取。
`fv-gui / fv-server` all-targets 严格 clippy 通过。最后的刷新修正重跑了严格 clippy 与 36 个 GUI 用例；日志 `/tmp/fastvibe-git-refresh-clippy.log`、`/tmp/fastvibe-git-refresh-tests.log`、`/tmp/fastvibe-git-projects-tests.log`。格式与 diff 检查通过，本批没有遗留的验证进程。
跳转的代码接到 GPUI 测量布局后的滚动锚点，不依赖固定行高；本批按要求以代码与自动化验证为证，没有声称做过界面视觉验收。
下一批继续终端交互、工作区重启恢复和其它完整范围。

完整目标保持进行中，未勾选项不代表已完成。

## 第四十三批：原生构建入口

- 根目录新增 `pnpm native:fmt`、`pnpm native:check`、`pnpm native:test` 和 `pnpm native:build`，分别覆盖 Rust workspace 格式、编译、测试和 server/GUI release 构建。
- 新增 `pnpm native:stage`，按平台/架构复制 `fastvibe` 与 `fastvibe-server`，并生成包含字节数和 SHA-256 的 `native-manifest.json`；支持 `--target`、`--profile` 和 `--no-build`，可供后续安装包流程复用。
- 本机已通过 `pnpm native:fmt` 与 `pnpm native:check`；安装包签名、OfficeCLI 随包和 Windows/Linux 构建仍需对应平台环境。
- `NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 pnpm native:test` 全 workspace 通过；未设置代理例外时唯一失败是本机代理将 localhost 夹具改写为 502，已在测试环境隔离代理后复核。

## 第四十四批：原生 bundle 资源与工作区语言覆盖

- `pnpm native:bundle` 在原生二进制旁生成可运行的 `bin/` + `Resources/` 布局。内置技能完整复制到 `Resources/skills`；OfficeCLI 只复制目标平台/架构目录，并强制带上 `LICENSE`、`NOTICE` 和版本清单。符号链接资源拒绝进入 bundle，二进制和资源文件都写入相对路径、字节数和 SHA-256 的 `native-manifest.json`。
- 原生 GUI 的语言设置继续沿用 `AppSettings.language`，新增输入框占位、停止/排队/发送提示、模型菜单、上下文压缩、项目/文件夹管理、侧栏排序/归档确认、搜索面板、会话状态、回复动作、变更卡片、终端/Git、文件/预览面板、浏览器/Office 预览、关于页、个性化 Agent 说明、长期记忆、技能页、MCP 设置页、使用统计、定时任务列表/历史/编辑器、模型详情、审批/提问面板、快捷键设置和通用外观设置的中英文映射。未迁移的低频文案仍保留中文回退，未把这一批误标成完整 i18n。
- 新增 `pnpm native:verify -- --bundle DIR`：默认严格核对二进制和资源哈希；完成签名后使用 `--allow-resigned` 接受签名造成的二进制哈希变化，同时仍强制检查两个可执行文件、文件大小/路径和全部资源哈希，避免把重签当成绕过资源校验。
- 新增 `.github/workflows/native-bundles.yml`：在 macOS arm64、Linux x64 和 Windows x64 runner 上分别获取固定 OfficeCLI、构建 release bundle、执行 `native:verify`，启动 staged `fastvibe-server --help` 做最小运行烟测并上传产物；工作流支持手动触发，也会在 native/交付脚本变更时运行。签名和发布仍由后续平台交付流程负责。
- 修复 Office 进程验收夹具的 PID 读取竞态：测试现在等待 PID 文件内容可解析后再检查进程，避免把“文件已创建但尚未写入”误判成服务失败。

验证：`node --check scripts/stage-native-app.mjs`、`node --check scripts/check-native-bundle.mjs`、actionlint、macOS arm64 debug bundle（`--no-build`）及严格/重签模拟校验通过；`pnpm native:build` 的 macOS arm64 release 构建、release bundle、`native:verify` 和 `fastvibe-server --help` 烟测通过；`fv-gui` 编译、90 项 GUI 测试、严格 Clippy 和 `NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 pnpm native:test` 全 workspace 回归通过（最终日志 `/tmp/fastvibe-native-final-regression-fixed.log`）。原生 bundle 的 Windows/Linux 交叉构建、安装包签名和真实安装验收仍留在交付阶段；界面深层低频文案仍留在外围 i18n 阶段。

## 第四十二批：Linux 与 Windows 电脑操控

- `computer` 在 Linux 下使用 `grim`、`gnome-screenshot` 或 `scrot` 截图，使用 `xdotool` 执行点击、文字输入和有限按键；Windows 使用 PowerShell/System.Drawing 截图和 user32/SendKeys 动作；缺少桌面依赖时返回明确错误。Windows 动作分支已放在正确的 `perform` 路径，避免 Windows cfg 编译引用错误作用域。
- macOS 的 Accessibility/每次确认流程保持不变；Linux 的副作用动作仍逐次经过用户确认，不通过 shell 拼接参数。
- Windows 使用 PowerShell、System.Drawing/System.Windows.Forms 截图，并通过 user32.dll 与 SendKeys 完成点击、输入和有限按键；文本通过 UTF-16 Base64 传递，避免把用户输入拼接进脚本。

验证：`fv-tools` computer schema、Windows UTF-16 payload 用例、全包本机检查和严格 Clippy 通过。Windows 目标检查已进入 cfg 分支，但本机缺少 `x86_64-w64-mingw32-gcc`，交叉检查在 C 依赖初始化处停止；Linux/Windows 的真实桌面权限按要求不使用 computer use，留到跨平台交付环境验收。

## 第四十一批：其它 Agent 导入的第一条原生管道

- 新增 `fv-import` crate，按流读取 Claude Code 的 `projects/*/*.jsonl`，不把源文件全部载入内存，也不修改源目录。
- 扫描结果包含标题、首条用户内容、cwd、创建/更新时间、消息数量和文件大小；支持自定义标题与 RFC3339 时间戳。
- 读取转换会合并同一 assistant message id 的分块，保留文本、thinking、tool call、tool result、模型和 token 用量；meta 与 sidechain 条目被过滤，并记录跳过原因。
- 原生协议新增 `import/scan`、`import/read` 和 `import/commit`。服务端只允许读取 Claude Code 项目目录中的真实 `.jsonl` 文件，并在阻塞线程执行扫描/转换；确认导入会创建新对话，保留 cwd、标题和源消息时间戳。
- 导入写入使用源路径和消息序号生成稳定的 usage origin，重复导入同一源到不同对话不会重复计入用量；设置页提供刷新、预览和确认导入按钮。
- 同一设置页扫描 Claude Code、pi、Codex、OpenCode 与 zcode，会在候选标题前显示来源；pi 的 session、session_info、model_change、thinking、tool call/result、custom message 和压缩标记，Codex 的 response_item、reasoning、tool call/output、token_count 和注入消息过滤，以及 OpenCode/zcode 的 SQLite session/message/part、文本、reasoning、tool 和 token 记录均按原生规则转换。

验证：`fv-import` 两个单测、`fv-store` 导入用量去重用例、`fv-protocol` schema 用例、`fv-server` 105 个库测试和 GUI/server/protocol/store/import 严格 clippy 通过。按要求只做代码与自动化验证，不使用 computer use。

## 第六批：工作区重启恢复

- GUI 在自己的 data_dir 下维护 `gui-workspace.json`，保存逐对话标签顺序、当前标签、目录展开、文件源代码/预览模式、树宽与面板宽度/折叠/最大化状态，以及上次选择的对话；不加入广播给其它客户端的普通设置。
- 未保存的可编辑文件保存原文基线与草稿；切换标签后停放的草稿也保存。干净文件重新从服务端读取，不拿旧缓存冒充磁盘现状；只提取文本的 Office 预览不会成为可回写草稿。
- 返回文件树保留当前编辑器和草稿，隐藏的编辑器不会被快捷保存误写；读文件请求按标签与代次隔离，目录变更会取消旧请求的采用。恢复编辑器延迟到打开面板时创建，继续保留原 dirty 基线。
- 标签恢复时分配新运行时 ID，避免重启后的计数器碰撞。终端只记录服务端会话标识，显示标签时再连接；旧会话失效或已经退出时提供在原标签重开的入口，不在恢复时自动执行新 shell。隐藏终端停止帧轮询，同一标签最多一个读取/定时任务。
- 面板终端的存活状态进入服务端升级忙碌检查，关闭 GUI 不会让活跃 shell 被当作空闲引擎替换；结束终端后解除升级保护。
- 保存经 300 ms 合并，后台同时最多一次写盘；临时文件 0600、同步后原子替换，较晚执行的旧任务不能覆盖退出时的新快照。关闭窗口和退出应用补存最后状态；损坏/未来版本的原文件保留并显示错误，不覆盖为默认值。删除对话成功后清理该对话的面板、草稿和终端。

首轮 GUI 44 个无界面用例通过，包含新增 8 项磁盘恢复、Unicode 草稿、原子替换失败、旧任务防覆盖、权限、标签与同名文件隔离、隐藏草稿和干净文件重新读取测试；日志 `/tmp/fastvibe-pane-recovery-tests.log`。
最终 `fv-gui / fv-server` all-targets 严格 clippy 已通过，日志 `/tmp/fastvibe-pane-recovery-final-gate-clippy.log`。64 项服务端回归通过（49 个单测、4 个命令会话、1 个终端重连、10 个回合用例），日志 `/tmp/fastvibe-pane-recovery-server-regression.log`。真实 PTY 用例保留并验证了断连前的 shell 变量、同一会话的尺寸和 cwd；终止后升级忙碌状态解除，存活的面板 shell 则阻止自动替换服务端，完整服务端重启后旧会话 ID 被拒绝。
重连夹具最初使用内存双工流，释放客户端未关闭写端，导致关闭连接等待超时；已改为与 GUI 相同关闭行为的真实 Unix socket，最终用例通过。工作区格式和 diff 检查通过。最后一轮 GUI 的 44 个用例已重跑通过，日志 `/tmp/fastvibe-pane-recovery-final-tests.log`。验证链 `43183` 已退出 0：本批最终覆盖 64 项服务端回归和 44 项 GUI 用例，共 108 项；严格 clippy、workspace 格式和 diff 检查通过。所有本批验证进程均已结束，没有遗留进程需要重启；没有把分批定向回归写成一条全量 workspace 测试通过。按用户要求未使用 computer use。

完整目标继续，终端输入法/选择复制/历史回滚和其它未勾选范围仍需完成。

## 第七批：终端交互

- 每个终端有独立原生 `EntityInputHandler` 与本地组字状态，UTF-16 范围按 Unicode scalar 边界处理；普通文字只经原生提交发送，确认/取消标记只提交一次。切换标签、对话或失去终端焦点会取消尚未确认的组字；迟到提交核对原输入实体和当前标签，不写入另一个终端。候选位置来自真实单元格光标，并限制在当前视口内。
- 终端文字按解析器给出的单元格宽度绘制，使用实际等宽字体 advance 测量尺寸。中文、emoji、组合字符与宽字符换行填充不会改变后续单元格位置；保留 ANSI/256 色、RGB、背景、反色、dim、粗体、斜体、下划线、隐藏与删除线。无变化的屏幕轮询不会重复通知重绘。
- 拖动选择、双击词、三击行、全选、Command-C/V 与 Ctrl-Shift-C/V；跨屏幕拖动会自动回滚。复制由 `terminal/copy` 读取被选中的真实历史，软换行连接、显式换行保留、真实行尾空格在软换行中保留，宽字符填充不混入文本。历史过期、清空、切换屏幕或尺寸变化后拒绝旧选择。
- `terminal/read` 增加独立 offset/anchor，旧的仅 id 请求仍可读取当前屏幕。每客户端保留自己的位置，新输出到来后仍锚定原历史；回到底部、输入新文字或 Shift-End 恢复实时视图。滚轮、Shift-PageUp/Down/Home/End、替代屏幕的箭头滚动已接入；退出后的屏幕也能继续回滚。
- 同一终端的输入按确认顺序发送；粘贴遵守 bracketed-paste 模式，规范换行并移除可伪造结束标记的 ESC。方向键遵守 application-cursor 模式与 xterm 修饰键。调整尺寸时合并后续目标并串行发送，旧尺寸的画面不采用；退出后的最后画面也会随尺寸重新读取。
- Alacritty 0.26.0 小幅源码补丁在 `native/vendor/alacritty_terminal`：仅在 Grid 真正追加历史时记录单调行号，显式清空或新 Grid 切换历史身份；不改共享 display offset，局部滚动不影响历史坐标，超出 5,000 行后仍能定位。源文件、Apache 许可与补丁说明保留；上游 46 MiB 参考夹具未复制，上游内联单测单独执行。
- 公共协议与远程策略包含 `terminal/copy`，复制在有界后台任务中执行。GUI 要求 `terminalInteraction` 能力，避免静默复用不支持新交互的空闲后端。新的 JSON schema 已生成。

首轮 12 个协议、58 个服务端（56 单测、2 个真实 PTY 协议）和 51 个 GUI 无界面用例通过；日志 `/tmp/fastvibe-terminal-protocol-tests.log`、`/tmp/fastvibe-terminal-interaction-server-tests.log`、`/tmp/fastvibe-terminal-interaction-gui-tests.log`。真实 PTY 验证两个客户端的滚动独立、输出后历史保持位置、复制仍指向原行，以及缩放后旧选区失效；纯解析器用例另覆盖 8,000 行输出、局部滚动、软换行/空格、宽字符与组合字符、颜色和输入模式。
最终修正了输入法 unmark 确认只发送一次、原生菜单粘贴遵守 bracketed-paste、组字范围按实际字体 shaping 定位，以及 Escape / Ctrl-S 被全局快捷键抢先处理的问题。真实 GPUI Keymap 回归验证了终端放行规则的注册顺序。最终 GUI 严格 clippy 与 52 个用例通过，日志 `/tmp/fastvibe-terminal-ime-geometry-clippy.log`、`/tmp/fastvibe-terminal-ime-geometry-tests.log`。

服务端完整一轮的 56 个单测、4 个命令会话和 2 个 PTY 协议用例通过；12 个协议用例和 132 个上游终端内联单测通过，日志 `/tmp/fastvibe-terminal-complete-{server-tests,protocol-tests,upstream-tests}.log`。随后复制改用解析器自身的 Tab 停靠位规则，避免 Tab 后填充空格被重复复制；新增默认/自定义 Tab 停靠位和部分选区回归。改动后的 14 个终端单测、2 个真实 PTY 协议用例及服务端 all-targets 严格 clippy 通过，日志 `/tmp/fastvibe-terminal-tab-{tests,protocol-tests,clippy}.log`。这些是分批定向验证，不代表最新的整个 workspace 测试已一次通过。

全程按用户要求只做代码与自动化检查，没有真机输入法或视觉验收的声明。

完整目标继续，长期记忆及其余未勾选范围仍待完成。


## 第八批：技能选择与徽标

- 输入框的 `/` 菜单按当前工作目录与多文件夹项目读取 `skill/list`，支持名称/描述筛选、手动专用技能、方向键选择、Enter/Tab 确认和 Escape 关闭；无结果或仍在加载时 Enter 不会误发半条指令。
- 技能徽标使用输入框原子 token，底层文字仍是 `/skill:名称`。发送、排队、插话和编辑沿用同一原始指令；没有额外隐藏状态需要在失败重试时拼回。关闭按钮按当前 token 身份及 UTF-16 范围删除；移动到普通正文中的指令不显示为有效选择。
- 手动输入已确认的指令会标注为徽标；历史提示词编辑和发送失败恢复通过 `InputContent` 恢复标注，不依赖该技能是否仍安装。消息与队列显示同一徽标及正文。
- 菜单请求核对当前目录与代数，切换项目、刷新目录或后端重连后旧结果不覆盖新结果。每次重新打开菜单重新读取目录，外部技能变更不会永久留在旧缓存中。
- 键映射在实际输入控件层匹配菜单上下文，避免被输入框自身的方向键、Tab、Escape 或全局 Escape 抢先处理；纯状态及真实 Keymap 用例验证上述路由，另覆盖空输入框 Tab 接受回复推荐的相同匹配层级问题。

- `@` 附件选择保留技能 token，并按返回的字节位置恢复光标，避免下一次输入落到技能指令之前；只有技能、没有正文的消息只显示徽标。

验收通过：56 个 GUI 无界面用例、6 个服务端技能/上下文协议用例，GUI all-targets 严格 clippy（`-D warnings`）、workspace 格式与 diff 检查。日志 `/tmp/fastvibe-skill-picker-final-tests.log`、`/tmp/fastvibe-skill-picker-protocol-tests.log`、`/tmp/fastvibe-skill-picker-verified-clippy.log`。协议用例验证技能管理、目录隔离与明确选中的全文确实进入模型请求；本批未改变公共线协议，不需要新的 schema。全程没有 computer use 或视觉验收。

完整目标继续；长期记忆及其余未勾选范围仍待完成。

## 第九批：长期记忆

- 原生服务端持有默认关闭的记忆管理器，配置和提取/重试/引用/基线账本保存在现有 SQLite；会话转写仍为只追加的 JSONL。公开 `memory/read|configure|run|clear` 与全局状态推送，远程策略穷举包含这些方法。
- 启动 45 秒、每 15 分钟、开关开启及「立即整理」触发单次流水线。按真实转写 mtime 筛选闲置 6 小时、10 天内且未运行的会话，每轮最多 2 个并发提取；逐行限长、首尾预算截断和常见凭据脱敏，跳过思考、隐藏记忆和图片内容。失败按 1 小时/3 次重试。
- 保留 30 天内使用/生成的记录，按使用次数和最近触达排序最多 256 个；删除会话的记录一并移除。机械更新笔记与 rollout 摘要，生成含删除信息的 git 风格差异。
- 整理阶段使用同一份已带来源 NOTICE 的提示词，临时 agent 只拿到私有 `memory_workspace` 接口。接口访问有界的内存暂存树，可分页读取、列出、搜索、写入、替换和删除；不能运行 shell、访问网络、跟随链接或修改原始证据。没有把旧 read/write 等工具重新注册到正常会话。
- 只有完整 `MEMORY.md` 和首行 `v1` 的摘要通过校验才发布。磁盘暂存和重命名保留原文件；进程在目录切换途中退出时，重启依据事务标记恢复原目录，清除也处理带标记的遗留暂存副本。整理期间的人工修改触发重试，不能覆盖。关闭、清除和过期延迟触发由取消令牌与代次隔离；读取摘要也核对发布版本，迟到结果不能回写旧缓存。批量文件准备、校验和旧目录清理在后台线程执行；取消会等待私有写入收尾，发布锁仅保护最后的切换与账本更新。
- 对话持久化独立隐藏快照；相同摘要不重复追加，变化时追加新快照，压缩后再次注入。关闭时从后续模型请求投影中过滤，原转写保留。压缩不把隐藏地图混成用户输入或固化到摘要中。引用 id 作为使用计数信号；显示和搜索去除完整/流式引用块及其独立代码围栏。
- 设置页接通开关、整理模型、状态/计数、立即整理、打开目录及二次确认清除；状态 revision 防止迟到读取覆盖较新的推送。
- 提取明确返回空结果时成功结束，不启动整理或创建空目录；失败诊断在写账本与推送到设置页前脱敏。虚拟路径限制深度、分量长度和最终路径长度，归一化重复分隔符，拒绝文件/目录冲突。

验收已结束：全 workspace 回归退出 0，497 项通过、0 失败，1 个子进程夹具按设计忽略，文档测试通过；协议/schema 的 12 个用例通过。该全量命令使用本批较早的源码，日志 `/tmp/fastvibe-memory-workspace-tests.log`、`/tmp/fastvibe-memory-protocol-tests.log`。

后续记忆修正逐批定向重验：最终源码的 workspace all-targets 严格 clippy、65 个服务端单测和 6 个记忆公共协议集成用例全部通过；日志 `/tmp/fastvibe-memory-noop-clippy.log`、`/tmp/fastvibe-memory-noop-tests.log`。此前另通过 6 个 core 用例、2 个 agent 记忆用例和 57 个 GUI 无界面用例，覆盖引用围栏、隐藏快照、关闭/压缩后的请求投影及状态 revision；日志 `/tmp/fastvibe-memory-verified-{core-tests,gui-tests}.log`、`/tmp/fastvibe-memory-agent-tests.log`。最终 workspace 格式与 diff 检查通过。本批没有遗留验证进程，全程没有 computer use；这些分批结果不冒充最后一次源码的单条全量测试命令。

长期记忆本项完成；旧版完整数据导入、子 Agent、代码模式及其余未勾选范围保持待办，完整目标仍在进行中。

## 第十批：失败回合与重试恢复

- 转写新增独立的回合开始/结束记录，保留原回合 id、时间、结束原因及错误项 id/原文。错误不伪装为用户或模型消息，后续请求、记忆提取和压缩仍只读取原消息。旧转写继续按原有消息位置恢复。
- 重启按回合边界重建；同一轮中的插话和自动压缩仍留在该轮。没有输出的供应商失败、流中途失败和没有新消息的手动压缩失败都能恢复自己的错误卡片。
- 分叉同时复制有效消息与回合结果；回退仍只追加标记，不删除原文。标记能区分同一消息位置上的空手动回合，旧分支错误不会在后续重启时重新出现。
- 重试改用完整转写中的绝对消息位置，修正压缩后的偏移及插话计数；手动回合没有用户提示词时明确拒绝，不能借用下一轮的提示词。回退前先占用回合，跨客户端的新回合不能插入通知等待的间隙；无效回退释放占用并保留原转写。
- 模型或压缩任务 panic 后收完已提交事件，记录单条内部错误并释放回合。删除转写在同一锁内留下本进程的删除标记，迟到的提交和结束通知不能重建已删文件。追加前只检查最后一个字节，截断末行与后续记录不会粘连。

验证已结束：31 项存储测试及文档测试通过；较广的 56 项服务端协议回归通过，覆盖压缩、握手、长期记忆、重启持久化、队列/插话、文件回退、新增错误恢复、回合事件及 worktree。回退占用保护修正后的最终源码另通过 67 个服务端单测、3 个文件回退和 3 个错误恢复协议用例；这些分批测试合计 154 个不重复用例，不冒充一条全 workspace 测试命令。日志 `/tmp/fastvibe-turn-results-final-store.log`、`/tmp/fastvibe-turn-results-verified-server.log`、`/tmp/fastvibe-turn-results-claim-tests.log`。

最终 `fv-store / fv-server` all-targets 严格 clippy（`-D warnings`）通过，日志 `/tmp/fastvibe-turn-results-claim-clippy.log`；workspace 格式与 diff 检查通过。原持久化测试的总行数断言已改为核对真正的消息数量、开始记录和中断结束状态，继续验证消息及时落盘。本批所有验证进程均已结束，全程没有 computer use。

错误项持久化本项完成。压缩窗口自适应仍是独立未完成项，完整目标未缩减；下一批继续处理实际容量学习与有界压缩恢复。

## 第十一批：压缩窗口自适应

- 每个会话维护自己的实际容量预算，按物理地址、协议、模型及声明窗口隔离；供应商别名或凭据变化不会误清同一物理路由的预算，容量学习不改写模型配置。仅真实超窗或达到输出上限的摘要触发缩减，按被拒绝请求及输出余量计算，不机械减半一个过大的声明窗口；一次恢复最多六次缩减。
- 普通请求把系统指令、工具声明和记忆地图计入预算；模型用量可用时优先采用测量值。压缩后仍被拒绝可以继续有界恢复，成功的普通请求结束本轮恢复计数。容量耗尽后保存失败历史的指纹，追加错误或继续提示不能反复花费请求；编辑/回退历史、改变模型或显式整理可以恢复。
- 摘要输入独立计量，不复用包含普通工具声明的旧请求用量。超出预算的原始对话按 UTF-8 边界分片，逐片携带已生成的摘要；旧摘要本身也可重排，完整用户要求、工具调用和结果均参与处理，不再遇到超窗就丢掉最旧消息。分片用量累计，较大序列化在后台执行，取消能停止后续请求。
- 摘要输出与触发余量分开，最多 4K，并为后续普通请求中的必需指令、工具和记忆地图留位。发布前检查实际请求投影，自动压缩还必须缩小输入；失败和取消保留原历史。完整用户原文保存在转写，只有发给模型的原文桥接按实际空间分配预算。
- 显式压缩重新探测声明容量；只有验证通过的压缩点才提交新保护，失败或取消恢复此前预算。普通回复达到主动输出上限时直接报告截断，不自动重跑，也不执行截断的工具调用。逐请求输出限制与供应商原有限制取较小值。
- 有效窗口与用量通过现有公共协议推送；恢复快照在同一把回合锁中采用最后的请求投影，换物理模型或声明窗口时不误用旧测量值。没有新增旧版专用工具或修改供应商设置。

本批基线 `f1ee6e3` 的完整 workspace 回归已退出 0：527 项通过、0 失败，1 个子进程夹具按设计忽略，文档测试通过；workspace all-targets 严格 clippy 与最终引擎/服务端源码的严格 clippy、格式和 diff 检查通过。日志 `/tmp/fastvibe-adaptive-verified-workspace.log`、`/tmp/fastvibe-adaptive-verified-clippy.log`、`/tmp/fastvibe-adaptive-final-source-clippy.log`。引擎专项、供应商请求参数与公开协议均纳入验证；后续自动压缩偏好的增量验证另列第十二批。容量自适应本项完成，其余完整目标保持原范围。

自动压缩偏好及关闭时的回合行为见第十二批；其余未完成设置继续保留在原范围内。


## 第十二批：自动压缩偏好

- 通用设置增加「自动压缩上下文」，公共协议字段 `autoCompactionEnabled` 默认开启，兼容旧数据，补丁不会重置其它偏好。设置保存在数据库，持久化成功后更新运行中的共享策略，再广播给客户端。
- 引擎在下一次请求边界读取策略。关闭时，接近容量或收到真实超窗会明确提示手动整理或更换更大窗口的模型，不发起自动摘要；真实容量证据仍被保留。显式手动整理始终可用，后台记忆整理使用相同策略。
- 服务端声明 `autoCompaction` 能力，GUI 连接时要求该能力，避免复用忽略新字段的旧后台进程。已有的上下文菜单继续提供手动整理入口。
- 152 项代码与自动化用例通过：协议 13、引擎 50、服务端定向集 32、GUI 无界面 57。覆盖默认兼容、跨客户端广播、实时关闭、重新开启、手动整理及重新构建服务端后的偏好恢复。相关包 all-targets 严格 clippy、格式与 diff 检查通过，没有 computer use 或视觉验收。


## 第十三批：个性化 Agent 说明

- 个性化页面接通多行编辑与显式保存，使用 Electron 对应的 `customSystemPrompt` 字段；旧数据默认空串，原文保存在数据库，空串或纯空白在请求中停用。其它设置补丁不会重置说明。
- 每轮构建请求时读取当前说明，接在项目与显式服务端指令之后。已有对话、新对话、排队回合与手动压缩都走同一构建路径；运行中的回合保留自己的提示词，下一轮使用新值。说明不写入转写，不随回合叠加，也不改进程环境变量。
- 公共 `settings/set` 可选 `expectedCustomSystemPrompt`，服务端在设置锁内比较再完整提交。陈旧保存拒绝整份补丁，其它字段也不写；未提供前值的旧调用仍可正常修改。通知同步所有客户端，GUI 要求 `personalization` 能力，避免复用不支持该字段的旧服务端。
- 编辑器自动跟随未修改的保存值；本地草稿、保存期间的继续输入或撤销、失败后的内容均保留。并发修改时明确显示冲突，提供载入保存值或覆盖保存，两条路径都不静默丢失草稿。请求绑定编辑器实例与请求号，旧保存结果不能结束新请求；保存响应不回写可能已过时的设置快照，设置读取也受本地代次保护。
- 定向验证共 121 项通过：协议/schema 14，服务端 45（个性化 3、上下文 6、设置 6、容量自适应 3、压缩 6、队列 11、回合 10），GUI 无界面 62（新增 5 项草稿/竞态用例）。严格 all-targets clippy、格式与 diff 检查通过。最终补充将排队回合纳入个性化协议测试，并重跑该集；GUI 代次保护补充后也重跑了严格 clippy 与完整 GUI 单测。

日志：`/tmp/fastvibe-personalization-protocol.log`、`/tmp/fastvibe-personalization-clippy.log`、`/tmp/fastvibe-personalization-server-tests.log`、`/tmp/fastvibe-personalization-final-server-tests.log`、`/tmp/fastvibe-personalization-final-server-clippy.log`、`/tmp/fastvibe-personalization-final-gui-tests.log`、`/tmp/fastvibe-personalization-final-gui-clippy.log`。本批未使用 computer use，也未把代码验证作为视觉验收。第十三批结束时剩余十个设置页，完整目标保持进行中。


## 第十四批：快捷键与回车发送

- 统一 11 项快捷键目录，与 Electron 的操作名和默认绑定对应：搜索与命令、设置、新建对话、打开文件夹、聚焦输入、发送、停止、上/下一个对话、侧边栏与侧面板。上/下对话按创建顺序循环并跳过归档，侧面板默认组合键对齐为 `mod+j`。
- 公共设置增加 `sendOnEnter`（旧数据默认开启）、`shortcuts`（覆盖表，`null` 表示禁用）与单项 `shortcut` 编辑补丁。单项修改在设置锁内合并，修改不同操作的两个窗口不会相互覆盖；同一组合键移给新操作时禁用原绑定。支持单项恢复与全部恢复，恢复快捷键不重置回车发送或个性化说明。
- 服务端规范化组合键和别名，拒绝普通文字、多个主键、无效按键及系统/编辑保留键。完整覆盖表拒绝重复组合键；无效设置拒绝整份补丁，不会偷偷修改同一请求中的其它偏好。数据库持久化、全客户端通知和重启恢复均走现有设置通路；GUI 要求 `shortcuts` 能力。
- 设置页支持搜索、录入、清除禁用、单项/全部恢复和回车发送开关。录入期间先截获按键，Esc 取消、Backspace/Delete 清除，非法组合保留录入并显示原因；失去录入焦点、点击搜索框或切换页不继续捕获。旧的固定应用绑定已移除，不会让已禁用或重设的快捷键继续执行旧操作。
- 每个窗口持有自己的分发订阅，在编辑器键表之前匹配当前设置；释放窗口时释放订阅。已执行命令在松键前抑制重复，窗口激活变化清理按住状态。终端中的 Ctrl 输入和 Escape 留给终端，原生字符/AltGr 输入和 composer 的输入法组合状态不被应用操作截获；停止键在设置、菜单、编辑/重命名和权限交互期间保留原有取消路径。
- Enter/Shift+Enter 的换行与提交使用原生文本输入状态，关闭回车发送后不再从 Enter 事件启动回合；发送快捷键继续使用同一个发送/排队/停止路径。技能和文件候选菜单中的 Enter 先选择候选，不能直接发出半截选择。

验证：116 项定向用例通过（协议/schema 19、服务端 32、GUI 无界面 65）。包括新增 5 项组合键/配置用例、2 项跨客户端/重启/原子拒绝的公开协议用例和 3 项原生按键/终端/对话循环用例。`fv-protocol / fv-server / fv-gui` all-targets 严格 clippy、格式与 diff 检查通过，录入焦点收尾后另重跑 GUI 严格 clippy 与 65 项单测。日志 `/tmp/fastvibe-shortcuts-protocol.log`、`/tmp/fastvibe-shortcuts-verified-clippy.log`、`/tmp/fastvibe-shortcuts-server-tests.log`、`/tmp/fastvibe-shortcuts-final-gui-tests.log`、`/tmp/fastvibe-shortcuts-final-gui-clippy.log`。

本批按要求仅检查代码与自动化用例，没有 computer use、真机键盘/输入法或视觉验收。macOS 本项代码完成；Windows/Linux 的整体验证继续保留在跨平台交付范围内，其余九个占位设置页与完整目标仍在进行。


## 第十五批：原生使用统计

- SQLite schema 4 增加独立 `usage_ledger`，保存原始请求身份、时间、模型、Token 和模型发出的工具调用数量，不保存正文、思考或工具参数，也不把价格固化进账本。账本不依赖对话外键，重试与回退保留已发生的请求；删除对话不减少历史用量。
- 回复写入转写前先尝试提交账本，事务采用 `synchronous=FULL`；统计存储失败仍保存回复与稳定来源标识，撤回扫描缓存，恢复后可以从转写回填。删除先强制回填并验证成功，再在写锁内复查后移除源文件；数据库不可写时保留唯一来源。迟到回复仍可记入账本，但已删除对话的转写不会复活。同步策略依据 [SQLite synchronous 文档](https://www.sqlite.org/pragma.html#pragma_synchronous)。
- 分叉保留逐消息的原请求来源，继承部分不重计，新请求归新对话。已有原生转写逐行回填，忽略回退标记对计费历史的裁剪；有共享回合 id 的旧副本也按原始回合/消息位置去重，坏尾行不会遮住前面的有效记录。缓存以文件长度、修改时间和 inode 判定，正常写入推进缓存；查询扫描在阻塞任务中执行，文件解析不持有实时转写写锁，账本按批提交。
- 公共 `stats/usage` 支持 7/30/90/365 天和全部范围，按观看客户端的 IANA 时区归日并应用历史夏令时；空数据、未来日期、无效时间与极大计数有明确行为。返回总量、逐日/模型/对话明细、活跃天数、对话跨度与连续天数。模型费用逐请求使用当前加载目录和缓存/长上下文价格阶梯；未知费用为 `null`，部分估算带未定价请求数，不把未知当作免费。
- 设置页接通范围切换、刷新、估算费用与缓存命中率、按项目/对话分布、每日/每周/累计热图、7/30 天逐模型趋势及模型占比和明细。热图每页最多一年，365 天范围完整显示，较长范围可前后翻页；周总量跨页仍完整，累计值包含可见页之前的用量。异步结果绑定设置实例和请求号，切换范围丢弃旧结果，在途通知合并为后续刷新。
- 服务端广播空载荷 `stats/usageChanged`，不携带会话 id 或内容；会话视图忽略它，序号与订阅隔离保持原规则。新 RPC 在远程策略中明确放行，耗时查询不占据该连接的控制请求处理路径，GUI 要求 `usageStats` 能力。

验证全部结束（退出 0）：协议/schema 19 项、存储包全部 35 项、服务端包全部 194 项、GUI 无界面 68 项，共 316 个不同用例，0 失败，存储/服务端文档测试通过。新增 12 个用例覆盖原始账本、回退/分叉/删除/迟到写入、数据库故障与修复回填、公开协议与远程分类、时区/DST、价格阶梯与重估、未知/溢出数据、热图翻页与费用分组。全球通知加入后，旧会话测试辅助函数明确排除该提示，并额外断言其参数为空；会话消息的严格序号与未订阅隔离断言继续通过。

`fv-protocol / fv-store / fv-server / fv-gui` all-targets 严格 clippy、格式与 diff 检查通过；年度热图边界的最终补充另重跑 GUI 严格 clippy 和 68 项单测。日志 `/tmp/fastvibe-usage-protocol-tests.log`、`/tmp/fastvibe-usage-final-verified-clippy.log`、`/tmp/fastvibe-usage-final-verified-store-tests.log`、`/tmp/fastvibe-usage-final-verified-server-tests.log`、`/tmp/fastvibe-usage-final-calendar-tests.log`、`/tmp/fastvibe-usage-final-calendar-clippy.log`。没有 computer use 或视觉验收。

口径与边界：和 Electron 的助手回复账本一致，本项统计已记录的对话模型回复，不把标题、回复推荐、后台记忆或压缩摘要计为普通对话请求，页面明确说明。现有价格源是当前加载的 models.dev 目录；模型价格按现有客户端设计为只读目录数据，不增加手动定价或折扣编辑。旧 Electron 账本和其他 Agent 数据尚未迁入；没有原来源和共享回合身份的旧副本不能凭内容猜测去重，保留在完整数据导入范围，不能声称旧数据统计迁移已完成。其余八个占位设置页与完整目标继续进行。


## 第十六批：模型目录刷新与关于页基础

- 公共 `model/catalog/get|refresh` 与空载荷 `model/catalog/changed`，手动和自动更新共用一条单次下载通路。请求不接受下载地址，LAN/官方连接显式放行；耗时刷新独立处理，不阻塞同连接的设置读取或 Stop。客户端断开会结束其等待，但已开始的下载、保存和全局失效通知继续完成。
- 接通原先未编译的原生 models.dev 编码器，修正供应商排名方向、同级别名冲突、价格阶梯字段/缺省值与构建错误。模型按稳定顺序折叠，订阅套餐不给厂商权重；与现有 Electron 编码器对拍，价格和别名选择一致。目录身份忽略更新时间、对象键顺序和整数/小数的等价 JSON 写法，不因编码器不同而反复重绑模型。
- 固定 models.dev 地址、60 秒网络时限、32 MiB 流式读取上限；下载与解码失败、空模型目录或文件替换失败均保留原目录。折叠和落盘离开异步执行线程，临时文件与目标同目录，先完整写入和同步再替换；成功后原子发布不可变快照。模型列表、供应商列表和新请求即时读取新参数，在途模型保留已构造的参数。
- 过期或缺失目录启动后等 15 秒拉取，新目录等满一小时；手动更新会移动已有时钟，失败从尝试结束起退避一小时。修正了「启动定时器等待期间手动失败」仍立即重试的边界；未来时间戳最多推迟一小时。后台仅持有弱服务端引用，不因计时器延长进程寿命。
- 内容变化才重估已打开对话并推送新费用、通知模型列表与使用统计；相同目录只更新年龄与关于页状态。新增逐会话投递锁，让目录重估与聊天流共用事件投递顺序；旧的费用快照事件改为发送当前统计，不能把稍后重估的值回滚。重估只额外保留模型名与用量，不复制消息正文、图片或工具参数。
- 关于页显示应用版本、开源仓库、模型/别名数量、来源、更新时间和路径；提供更新、忙碌、成功与失败状态，旧请求以设置页实例/请求号隔离。GUI 要求 `modelCatalogRefresh` 能力，避免连接缺少新方法的闲置后端。

范围纠正：上一批把手动定价/折扣写入待办没有现有客户端依据；`engine/providers.ts` 明确价格不可编辑，AGENTS.md 也要求目录作为参数和参考价格的单一来源。本批保留只读价格，将真实缺口「模型详情编辑」继续留在待办。关于页的应用更新、诊断导出和偏好重置等尚未接通，不能据本批基础入口声称整页或整个原生版完成。

验证全部结束（退出 0）：供应商包 54 项、协议/schema 19 项、服务端整包 197 项、GUI 无界面 68 项通过；新增启动定时器后目录集成的 3 项再次通过，其中 1 项为新用例，共覆盖 339 个不同用例，0 失败，相关文档测试通过。新增 11 项覆盖编码器对拍/乱序、目录身份、共享/取消下载、落盘失败和重试时钟、公开协议与参数/费用生效、跨客户端通知、事件投递顺序，以及真实 15 秒启动定时器。最后的等价数字解码补充重跑供应商/协议与 3 项目录集成用例；没有把分批回归表述为一条全量 workspace 命令。

`fv-provider / fv-protocol / fv-server / fv-gui` all-targets 严格 clippy、格式和 diff 检查通过。日志 `/tmp/fastvibe-catalog-server-tests.log`、`/tmp/fastvibe-catalog-gui-tests.log`、`/tmp/fastvibe-catalog-finished-provider-protocol-tests.log`、`/tmp/fastvibe-catalog-finished-api-tests.log`、`/tmp/fastvibe-catalog-finished-clippy.log`。本批仅代码与自动化验证，没有 computer use 或视觉验收；完整原生版目标仍在进行。


## 第十七批：模型详情与元数据编辑

- 模型行可打开详情，编辑名称、协议（包括明确继承供应商）、正整数上下文/输出上限、推理、图片/视频/文件能力及 6 档思考强度。文本始终保留，推理开启至少选一档；关闭后不发送思考强度，也不发送关闭思考的猜测。视频/文件和现有客户端一样记录为模型能力，不能据此宣称原生 Office/媒体处理已经完成。只读参考价显示四类 Token 与长上下文阶梯，未知保持未知。
- 公共 `provider/model/get|update`（含详情响应 schema）；更新只替换对应模型并强制标记 `edited`，目录刷新和重新同步保留已编辑参数。恢复操作重新读取当前目录并清除标记。供应商读写加锁，单模型保存比较原模型，另一模型的并发编辑正常合并；同一模型变化、已删除模型或供应商拒绝陈旧保存。公共详情不带 API Key，LAN/官方连接明确放行；全局变更提示为空载荷。
- 普通供应商替换支持可选 `expected`，GUI 提交时带当前完整公开供应商值；校验失败、无效元数据和陈旧替换都在改凭据前拒绝。设置页的供应商和模型列表读取以请求号/页面实例过滤，旧响应不能回滚新列表。模型选择保存失败保留选择，重复提交被抑制，新打开的表单不被旧请求关闭或填入其它供应商的模型。
- `ModelInfo` 增加向后兼容的编辑标记、推理/输入模态和可用思考档位；未知新模型使用 128K / 8192 / 文本默认，旧未知模型保留已存的能力和上限。composer 与默认设置只列当前模型支持的档位，服务器与显示共用「先向上、再向下」夹取规则，与现有 SDK 一致；用户原始选择可用于切换回其它模型。
- 协议只在读取提供方模型列表时按前缀自动固定，已保存模型的 `None` 真正继承供应商。旧原生版本曾在请求时猜测且未保存固定值，启动时以 `model_detail_protocol_v1` 私有迁移标记一次性记录其原路由，保留原生提供方的旧规则、已有固定值和已编辑继承选择；不改凭据，重复启动不重新猜测。偏好重置不能清除此迁移标记。
- 一个 Base URL 可保留逐模型协议；Google 模型经过非 Google 提供方时同时带网关 Bearer 和 `x-goog-api-key`，提供方本身为 Google 时只带后者。当前回合保留已构造参数，后续回合读取保存后的窗口/输出/能力/档位，编辑不取消在途回复。
- 编辑器保留保存期间继续输入、选择能力和本地草稿；新目录/其它客户端修改只更新未改动的表单，有冲突时明确提示重新载入。重新载入与延迟写回都比较它们开始时的表单，不能覆盖稍后输入；保存回执不会被较旧读取覆盖，新打开的详情以实例和请求号隔离。模型行显示固定协议与已编辑状态；GUI 要求 `modelDetails` 能力。

验证：386 个不同用例通过，0 失败。服务端整包 202 项、供应商 54 项、存储 35 项、协议/schema 21 项与 GUI 无界面 73 项通过；补充 Google 混合网关鉴权后重跑模型详情 5 项、提供方 13 项和目录 3 项，新增 1 项，不重复计数。相关文档测试通过。新增 12 项覆盖协议兼容/档位夹取、表单校验/同步/草稿与延迟重置、公开编辑/冲突/原子拒绝/删除/重启/价格只读、旧路由迁移、真实 HTTP 的在途/后续参数、协议继承与双鉴权。已修正旧供应商用例对未知新模型默认看图的错误假设，改为断言保守参数。

`fv-protocol / fv-provider / fv-store / fv-server / fv-gui` all-targets 严格 clippy、格式与 diff 检查通过。日志 `/tmp/fastvibe-model-detail-server-tests.log`、`/tmp/fastvibe-model-detail-other-tests.log`、`/tmp/fastvibe-model-detail-finished-gui-tests.log`、`/tmp/fastvibe-model-detail-final-api-tests.log`、`/tmp/fastvibe-model-detail-final-verified-clippy.log`；最终行内标签调整另作 GUI 严格 clippy 验证。本批没有 computer use 或视觉验收，没有把分批回归称为一条全 workspace 命令通过。模型连通性自检、7 个占位设置页、关于剩余功能及完整迁移目标仍在进行。

## 第十八批：供应商模型连通性自检

- 公共 `provider/model/test` 只接受已保存的供应商和模型 id，使用与普通回合共用的协议、端点、鉴权和元数据解析；不接受调用方的 URL、密钥、请求头或提示词。LAN/官方连接明确放行，GUI 要求 `providerModelTest` 能力。
- 自检分别发送独立的普通回复与固定 `fastvibe_probe` schema 工具请求，工具只验证参数、从不执行。不带项目或自定义系统说明、历史、记忆和工具运行时，不创建会话、转写、用量账本或广播。四种模型协议均通过真实本地 HTTP/SSE 服务验证。
- 每个请求最多 20 秒、整体最多 45 秒，不重试；输出默认 256 Token，声明推理的模型留 1024 Token，并受模型上限约束。流式文本最多 128 KiB、事件最多 4096；首字与总耗时独立记录。普通回复成功但未返回指定工具是部分通过，后续工具失败保留普通回复结果。HTTP、网络与超时只映射安全分类，不返回提供方原文或凭据。
- 全局最多 4 个检查，超额明确拒绝；耗时检查独立处理，同连接的设置读取和 Stop 不被阻塞。断连撤回请求、释放配额与网络连接，活跃检查纳入后端忙碌判定。完成时比较包含私有密钥的配置快照，密钥轮换、模型或端点修改、停用和删除使旧成功结果失效。
- 模型行显示运行状态并以短暂通知呈现结果，失败可进入详情编辑。设置实例、页面和配置变更以票据隔离回调，旧通知定时器不能移除新结果；切换设置页清除旧状态。密钥保存失败保留输入，成功后仅清除仍等于所提交值的草稿，迟到回执不覆盖新输入。

提交前联合回归已结束（退出 0）：`cargo test -p fv-provider -p fv-protocol -p fv-server -p fv-gui -p fv-store` 共 427 项通过、0 失败、0 忽略，相关文档测试通过；分别为供应商 64、协议 22、服务端 207、GUI 单测与集成 99、存储 35。新增自检用例 18 项覆盖四种协议、错误分类/脱敏、不重试、空或错误工具参数、流式错误/超量、首包/整体/工具超时、取消连接、公开协议隔离、全局配额、断连回收、控制请求并行、密钥轮换和界面过期结果。

上述五个包 all-targets 严格 clippy（`-D warnings`）、workspace 格式与 diff 检查通过；日志 `/tmp/fastvibe-pre-push-tests.log`、`/tmp/fastvibe-pre-push-clippy.log`。仅代码与自动化验证，没有 computer use 或视觉验收。7 个占位设置页、关于剩余功能及完整迁移目标仍未完成。


## 第十九批：供应商范围调整

按用户要求撤回未提交的全部模型订阅工作：Claude/ChatGPT 登录入口、订阅授权 RPC、令牌持久化/刷新/撤销、账号注册与模型请求适配、专用测试及签名夹具均已移除，相应依赖和协议 schema 恢复。供应商只保留自定义 Base URL、API 格式与 API Key，以及已完成的模型同步、详情编辑、目录刷新和连通性自检。MCP 服务认证继续使用原有实现。后续完成验收不再要求任何模型订阅功能，也不迁移旧模型订阅凭据。

验证已结束（退出 0）：协议/供应商/存储整包 121 项、服务端供应商/模型详情/自检集成 22 项、GUI 无界面 76 项，共 219 项通过、0 失败。五包 all-targets 严格 clippy、workspace 格式和 diff 检查通过；原生目录与提交 `1749e61e` 一致，新增订阅文件与依赖均无残留。日志 `/tmp/fastvibe-custom-only-data-tests.log`、`/tmp/fastvibe-custom-only-server-tests.log`、`/tmp/fastvibe-custom-only-gui-tests.log`、`/tmp/fastvibe-custom-only-clippy.log`。没有 computer use；其他迁移事项继续按本清单执行。


## 远程设计与执行顺序调整（2026-10-30 更新）

批准后的执行优先级：本机核心 → 配置与工作区 → Electron 迁移 → 远程 / 手机 / SSH；旧 Electron 导入不再放在远程之后。迁移与远程均已有实现和定向验证，最终验收仍进行中，证据与待回填门禁见文首“当前批次”。

原生桌面、手机与 SSH 统一使用当前 `fv-protocol`；Flutter 原生客户端使用精确方法名与 JSON 结构；Rust schema 与 Dart 方法元数据/schema 校验器已有生成入口，完整强类型 Dart DTO 生成尚未落地。旧 Electron App Protocol、新旧双栈、旧 WebRTC 分片头与旧 SSH Agent 的兼容均不属于验收要求。新远程实现与边界见 [重写方案第六节](native-rewrite.md#6-远程访问与手机端按新架构重新设计)；鉴权、权限分类、事件顺序、重连快照和资源清理仍按新架构验收。

Electron 迁移是显式扫描、确认和导入；只转换已支持的数据，未支持的运行时状态与用户图片留在私有归档。旧目录保持只读，API Key 复制须显式选择，不迁移订阅或远程凭据。完整原生版、完整手机富内容与真实线上更新均未完成验收。后续历史批次中的“最后实施 / 尚未开始”仅描述当时状态。

## 第二十批：子 Agent 基础运行与任务列表

按用户最新顺序优先补齐应用本身；没有开始实现远程连接或 Flutter 适配。原生子 Agent 沿用 `native-rewrite.md` 的 Codex 控制模型，不恢复旧 `dag_*` 工具。

- `fv-server/subagents.rs` 把 `spawn_agent`、`send_input`、`wait_agent`、`close_agent`、`resume_agent`、`list_agents` 接入每轮工具表。子任务复用现有回合、MCP、项目规则、技能、沙箱、压缩、错误恢复与用量账本；输入为独立的文本任务，默认继承选中的自定义模型，也可指定 `provider/model` 和思考强度。
- SQLite schema 5 原子保存子会话与归属；普通会话列表不混入子任务，完整输出仍在子会话 JSONL 中。结果预览最多 8000 字符，任务说明最多 32000 字符。每个根对话保留最多 100 个子会话；全局列表只读最近 100 条，具体对话读取其完整子任务列表。
- 默认每个根对话最多 6 个未关闭子 Agent、委派 1 层；设置可调整为 1–16 个、1–3 层。创建和恢复原子校验名额；模型工具只能控制自己的直接子任务，关闭级联停止子树。正在收尾的任务/命令仍占名额，恢复不自动启动工作。
- Stop 覆盖子树，新建子任务的取消令牌关联创建它的回合；关闭停止后台命令但保留可重新使用的命令池。删除会话清除整个子树、转写、图片、队列与检查点，迟到的写入不能恢复已删除记录。重启仅在取得监听权后把未结束任务标为中断，不自动重跑，第二个启动失败的服务不改动现有运行状态。
- 子任务的提问/审批也发送给只订阅主对话的客户端；主对话重新连接会重放未答的问题。等待调用可返回“等待输入”，客户端任务栏可打开子会话回答。完整结果、工具过程与用量通过原有 `thread/resume` 查看。
- 设置里的子 Agent 页接入启用开关、数量/层级限制与任务记录；composer 上方增加默认折叠的任务栏，支持查看、关闭、恢复、返回主对话和停止全部。异步读取按所选对话及请求代次隔离，设置加载完成前不提交默认值覆盖已有设置。
- 顺带修复队列连续回合仍持有旧回合 ID、导致后续消息不能正常衔接的问题；关闭或删除的子会话也不能通过队列绕过生命周期检查。

第二十批结束时尚未实现完整历史 fork 与角色模板编辑；后续已在第二十一批补齐。代码模式、托管网页搜索、定时任务及其余内容/外围功能仍在待完成范围中。远程与手机适配后置，旧 Electron 完整导入最后实施。

验证已结束：六个相关包（`fv-agent`、`fv-tools`、`fv-protocol`、`fv-store`、`fv-server`、`fv-gui`）联合回归 495 项通过、0 失败；后续有界列表、删除后的迟到队列写入及子会话用量归属修正，又通过子 Agent 生命周期 12 项、队列 12 项、公开委派/提问 2 项、用量 2 项和存储 37 项定向验证。GUI 99 项与协议 22 项也在列表适配后复验通过。以上有重复验证，不累计相加。

六包 all-targets 严格 Clippy（`-D warnings`）、workspace 格式和 diff 检查通过。全程未用 computer use。日志：`/tmp/fastvibe-subagents-final-tests.log`、`/tmp/fastvibe-subagents-tests.log`、`/tmp/fastvibe-subagents-followup-tests.log`、`/tmp/fastvibe-subagents-queue-final.log`、`/tmp/fastvibe-subagents-usage-final.log`、`/tmp/fastvibe-subagents-store-final.log`、`/tmp/fastvibe-subagents-clippy.log`。用量查询保留子会话标题/定位，普通侧栏仍隐藏子会话，不将其误判为已删除对话。

## 第二十一批：子 Agent 历史派生与角色模板

仍按“本体功能优先 → 远程与手机适配 → 交付验证 → 旧 Electron 完整导入”的顺序推进。本批补齐上一批明确保留的两项子 Agent 功能，不改变模型仅支持自定义端点/API Key 的范围。

- `spawn_agent` 支持 `fork_context`。派生前以父回合 ID、调用 ID 和有效消息数确认本轮消息已经落盘；写入回执驱动等待，取消、损坏或超时明确失败，不拿旧快照代替本轮输入。复制保留完整转写、压缩边界、已完成的工具结果与调用前的可见说明；本批尚未完成的工具调用及调用后的内容不带入子任务。
- 复制沿用原请求的用量来源，不把父请求再次记为子任务消费。图片复制到子任务自己的目录，父图片删除后仍能读取。继承的未结束父回合被收束为历史记录；重启后子任务继续使用自己的转写，不再读取父会话的新内容。继承上下文不会复用父进程句柄或审批许可。
- 增加角色列表、保存、删除的公开协议和 schema。提供可编辑的代码探索/执行模板；自定义角色支持职责说明、模型、思考强度、工具子集及只读模式。角色 ID 不变，保存/删除带原始定义进行并发比较；过期编辑不能覆盖另一个窗口的修改。
- 子任务保存创建时的角色快照。修改或删除模板不改变已有子任务，关闭/恢复和重启也不重新套用新模板。模型与思考强度按“本次显式参数 → 角色 → 父会话 → 默认设置”取值；仍通过原来的自定义模型解析和能力约束。
- 工具集合在每轮快照中裁剪，`tool_search` 也看不到未授权工具。角色显式允许的延迟工具直接加载，因此只授权某个 MCP 工具而不授权搜索工具也能调用；普通父工具表不受修改。后代只能进一步收窄祖先的工具授权，选择另一个角色不能扩大范围。
- 只读角色强制只读文件系统和禁止提权，仅提供受限的本机工具，不提供 MCP 或继续委派；运行时与创建时都校验。普通角色仍可显式选择已连接 MCP 工具；服务或工具缺失时给出错误，不偷偷扩大授权。
- 设置页接入角色新建/编辑/删除、模型与思考强度选择、工具授权和只读开关，任务行显示角色与派生标记。保存期间的新输入保留，迟到读取不覆盖编辑器；删除需再次点击确认，已不可用的选中工具仍可单独移除。此处仅做代码/自动化验证，未做 computer use 或视觉验收。

验证：六包联合回归 504 项通过、0 失败；之后补充显式延迟工具授权、模型/思考优先级与本轮调用前说明的覆盖，最终子 Agent 定向单测 18 项、存储派生测试 3 项、公开协议完整派生/角色编辑/重启/用量链路 1 项通过（与联合回归有重叠，不累计相加）。六包 all-targets 严格 Clippy、workspace 格式和 diff 检查通过。日志：`/tmp/fastvibe-fork-regression.log`、`/tmp/fastvibe-fork-server.log`、`/tmp/fastvibe-fork-store.log`、`/tmp/fastvibe-fork-integration.log`、`/tmp/fastvibe-fork-clippy.log`。

第二十一批结束时定时任务仍是侧栏占位，后续已在第二十二批接通。代码模式、托管网页搜索及清单中的内容、外围、交付等事项仍需完成；整个补齐目标保持进行中。原生版不恢复已从计划删除的 `schedule_*` 旧工具。


## 第二十二批：本机定时任务

继续按本体功能优先推进，本批没有实现远程连接或旧 Electron 数据导入。

- 增加 `schedule/list|upsert|delete|runNow|stop|history` 与 `schedule/changed`，GUI 仅调用共享协议，调度器由 App Server 持有。关闭窗口不取消后台任务；电脑休眠或服务停止期间无法执行，恢复后依所选补跑策略处理。没有恢复旧的 `schedule_*` Agent 工具。
- 支持指定时区的单次、每天和每周计划；单次必须有明确时区偏移，重复计划使用 IANA 时区。夏令时缺失的时间顺延至当天第一个有效分钟，重复的分钟只执行第一次；休眠后按日历重新计算，不以间隔累计漂移。错过时可选择 24 小时内补跑最近一次，或延迟超过一分钟即跳过。
- schema 6 在原生 SQLite 增加任务、运行和元数据表，保存配置版本、FIFO 序号、触发时间、独立运行对话与有界结果摘要。创建运行对话和领取执行权在一个事务中提交；更新失败不改内存快照。数据库约束限制全局一个执行中记录、每任务一个排队记录，历史保留最近 500 条已结束记录，待执行/执行中记录不裁剪；最多 200 个任务。
- 全局一次执行一个任务。排队时冻结任务定义，后续编辑不修改已排队项；自定义模型、项目路径、提示词和时限都取该快照。未指定模型/思考强度仍按普通原生对话在执行时继承默认设置，模型目录、凭据和权限也使用执行时的有效配置。每次创建独立真实对话，使用指定项目或私有临时目录，保留完整过程、提问/审批、文件、错误与正常用量来源，且不额外请求回复推荐。
- 暂停取消排队但让当前运行继续；停止取消该任务排队及当前运行，等待所属模型、子任务和后台命令真正收尾后才让出执行槽。运行超过设定时限自动停止并标记失败。已完成父回合不能使仍在工作的子任务或命令脱离任务生命周期；未处理的失败子任务使运行失败。独立对话被删除后仍通过持有的运行时清理后台工作。运行期间的提问/审批沿用原有权限，不自动同意；列表和历史显示等待输入，并能打开运行对话回答。
- 手动执行重复任务不移动下次计划；手动或自动执行单次任务都消费该计划并增加配置版本，旧表单不能重新启用它。修改、暂停、删除带版本比较；排队去重，错过和冲突明确记入历史。运行中的任务不能直接删除，删除任务保留已有输出对话。
- 每个数据目录以进程锁防止第二个服务抢占或恢复活跃任务。服务停止取消当前工作并保留队列；重启将已领取的运行标记中断，不自动重放，队列仍可继续。执行结果写入失败时保留执行槽并重试，避免落盘仍是运行中却重复启动下一项。
- 侧栏定时任务进入卡片列表，支持新建/编辑、时区和星期选择、项目/模型/思考强度、时限和补跑策略、立即运行、启用/暂停、停止、分页历史与打开输出。保存使用版本比较，迟到读取不覆盖草稿，保存期间的新输入保留；删除需第二次点击确认。页面打开时隐藏对话输入/审批的快捷操作，避免误操作背景会话。GUI 握手要求新服务能力，忙碌的旧服务不会被直接终止。

验证：六个相关包（`fv-agent`、`fv-tools`、`fv-protocol`、`fv-store`、`fv-server`、`fv-gui`）联合回归 523 项通过、0 失败，包含新增定时任务服务/日历 12 项、存储事务/约束/裁剪 3 项、公开 RPC 断连/提问/重连/项目产物 1 项。之后修正启动恢复的锁顺序及空缓存竞争边界，定时任务服务 12 项与启动/持久化/执行会话/公开调度 18 项复验通过；最终 GUI 99 项通过（与联合回归有重叠，不累计相加）。六包 all-targets 严格 Clippy、workspace 格式和 diff 检查通过。全部使用代码与自动测试，未做 computer use 或视觉验收。日志：`/tmp/fastvibe-schedules-regression-final.log`、`/tmp/fastvibe-schedules-server-final.log`、`/tmp/fastvibe-schedules-final-targeted.log`、`/tmp/fastvibe-schedules-startup-final.log`、`/tmp/fastvibe-schedules-gui-final.log`、`/tmp/fastvibe-schedules-clippy-final.log`。

代码模式、托管网页搜索、内容/系统等其它本体功能仍未完成；整个补齐目标保持进行中。远程与手机适配后置，旧 Electron 完整导入最后实施。


## 第二十三批：原生 JavaScript 代码模式

继续本体功能优先。本批接通原生工具编排，不实施远程、手机适配或旧 Electron 完整导入。

- 对照本地 OpenAI Codex `60adfa8513f77c27826f0c5b770e7a7d4eca538e` 的执行/等待与 helper 契约，使用固定版本 `rquickjs =0.14.0` / QuickJS 独立实现，无需 Node 或外置 V8 服务。每个脚本使用新 async module；不安装文件系统、网络、进程、console 或模块加载器。原生工具以 `{code,...}` JSON 参数提供 `code_mode`，在四类现有模型协议上沿用普通工具路径；这是对上游自由文本 `exec` 参数的明确适配，不引入订阅或内置供应商。
- 工具通过 `tools.<原生名称>()` 调用，`ALL_TOOLS` 给出当前授权目录及 schema。包含授权范围内的延迟工具；被角色或祖先上限移除的工具不能通过脚本重新找回，也不能递归调用编排器。嵌套操作进入同一工具调度器与读/写门，保留工作目录、沙箱、审批、图片能力和工具搜索状态。独立读取可并行，写入保持互斥；编排器自身不占用会使内部调用死锁的门。
- 支持 `text`、`image`、`generatedImage`、`audio`、JSON `store/load`、`notify`、`yield_control`、`exit`、`setTimeout/clearTimeout`。每次只返回明确打印的内容、图片与音频，嵌套工具错误作为 JS promise 拒绝，可由脚本处理。存值在同一对话的后续脚本和回合可读，重启后清空；JS 局部变量、权限许可和进程对象不进入存值。音频的 MIME、base64、大小和批量数量有界，完整链路见第二十九批。
- 执行可按 `yield_time_ms` 或首行 `@exec` 提前返回 cell ID，`wait` 继续读取或终止，只交付新输出。显式 yield 冻结输出分批，即使快速脚本已结束，也不把多批输出合并或丢弃。完成但未取走的结果保留，创建另一个脚本不会将其清掉。旧 ID、跨对话 ID 和重复领取已完成结果明确失败。
- 每个脚本工作线程独立；64 MiB JS 堆、512 KiB JS 栈、10 分钟墙钟限制，每对话最多 4 个活跃脚本、32 个待领取结果、128 个/1 MiB 存值，全局最多 16 个工作线程。限制未读文字、图片、待领取输出分批、参数大小和嵌套调用总数/并发数；在构造 host promise 前限制参数捕获，避免 JS 堆外的大量 Rust 字符串绕过限制。运行死循环可由中断回调停止，不占服务端异步执行线程。
- 脚本结束或终止取消未完成的嵌套调用，等待调度器清理后才报告结束。已返回会话 ID 的后台命令保留原回合归属，可在后续脚本继续 `write_stdin`；用户停止回合仍会取消它们。Agent 正常结束、失败、取消和 panic 恢复都会收尾未完成脚本，删除对话与服务退出也发出取消。
- 嵌套调用发出原生实时工具项，补丁继续参与文件变化展示；调用参数/结果作为独立 `toolActivity` 转写记录保存。它们不增加模型历史中的 tool/result 对，也不产生额外请求或用量来源。重启投影保留记录，未完成项明确显示中断；完整分支复制记录，重试/编辑移除被替换回合的记录。嵌套派生通过外层已落盘调用定位父历史，仍排除当前未完成批次，并能继续等待子任务。
- 设置 → 偏好设置增加默认开启的代码模式开关；下个回合采用最新值，关闭后同时移除执行与等待入口。旧设置缺字段默认开启。GUI 握手检查 `codeMode` 能力；工具行显示代码模式/脚本等待，展开时显示原始 JavaScript，而不是包含转义换行的 JSON。

验证：六包联合回归 543 项通过、0 失败，全部文档测试通过。随后补齐只读角色的编排入口，公开代码模式链路最终 8 项、子 Agent 18 项复验通过；GUI 展示调整后的 99 项也通过。运行时定向 11 项、记录/分支/重试 1 项包含在联合回归内，与复验有重叠，不累计相加。最终六包 all-targets 严格 Clippy、workspace 格式与 diff 检查通过，全程未用 computer use 或视觉验收。日志：`/tmp/fastvibe-codemode-regression-final.log`、`/tmp/fastvibe-codemode-rpc-final.log`、`/tmp/fastvibe-codemode-roles-final.log`、`/tmp/fastvibe-codemode-gui-final.log`、`/tmp/fastvibe-codemode-unit-final.log`、`/tmp/fastvibe-codemode-store.log`、`/tmp/fastvibe-codemode-clippy-final.log`。

只读角色也可使用编排器，但内部目录仍只有只读角色允许的工具；不能找回补丁/MCP/委派，shell 写入仍由只读沙箱拒绝。真实进程测试还覆盖后台会话跨脚本读取，以及停止已 yield 脚本时取消正在执行的命令。

其它内容/系统/交付功能仍需完成；整个目标保持进行中。远程与手机适配后置，旧 Electron 完整导入最后实施。


## 第二十四批：自定义 Responses 模型的托管网页搜索

继续应用本体优先。远程连接与 Flutter 适配后置，旧 Electron 完整导入最后实施。

- 模型详情增加默认关闭的托管网页搜索开关，由用户确认自定义端点/模型支持。仅 Responses 模型且角色拥有 `web_search` 授权时发送原生 `{type:"web_search"}`；Chat、Anthropic、Gemini、探测/压缩等未授权请求不添加搜索参数。不增加模型订阅、OAuth 或内置供应商。
- 沿用 `genai =0.7.0` 的原生工具声明；通过每请求 raw frame sink 补齐归一化流丢弃的搜索活动、来源与引用，保留现有普通函数工具、自定义地址/API Key、推理加密内容 include、取消与用量路径。搜索已经开始后不自动重试，避免重复执行托管动作。
- 搜索准备/进行/完成、打开网页和页内查找作为模型托管活动保存；不作为本地函数执行，也不伪造 tool result。JS 工具目录排除托管能力，子 Agent 的角色与祖先工具上限继续生效。跨协议后续请求保留带引用的普通助手文本，搜索元数据不变造为函数调用。
- 只保留必要文字、动作、来源和 URL citation，不保存原始响应头/帧；限制活动、来源、引用、标题/动作长度并去重。来源与引用仅接受无内嵌凭据的 HTTP(S) URL，不主动抓取来源网页。
- 对话中实时显示托管活动，工具详情展示查询、状态与可点击来源；正式答案按 Unicode 字符位置/内容片段偏移渲染 Markdown 引用。无增量但有完整 output 的回复正常显示；位置无效的引用作为来源链接保留。停止或断线使未完成搜索变为中断，响应缺失完成帧明确失败，避免永远运行或误报成功。
- 元数据独立于本地调用/结果保存在原生转写中，重启、历史搜索和分叉保留来源；取消时保留已经收到的文字与引用。活动完成不会增加模型请求数或用量来源；使用统计说明托管搜索的额外费用不在 token 估算内。

实现参考 [OpenAI 网页搜索指南](https://developers.openai.com/api/docs/guides/tools-web-search)及 [Responses 流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)。验证仅使用本地模拟端点、真实本地 HTTP/RPC 与代码检查，没有使用真实付费端点或 computer use；用户配置的端点仍须实现所启用的能力。

验证：八个相关包（`fv-core`、`fv-agent`、`fv-tools`、`fv-provider`、`fv-protocol`、`fv-store`、`fv-server`、`fv-gui`）联合回归 625 项通过、0 失败、0 忽略，文档测试通过。包括托管搜索 Provider 的 7 项本地 HTTP 测试、取消历史的 Agent 用例与公开 RPC 的恢复/分叉/用量/关闭开关用例；这些已计入联合回归，不重复相加。八包 all-targets 严格 Clippy、协议 schema 快照、workspace 格式和 diff 检查通过。第一次联合回归的模型列表错误用例收到本地代理的 502，给测试进程设置 `NO_PROXY/no_proxy=localhost,127.0.0.1,::1` 后定向复验和最终联合回归通过，未改应用代理行为。日志：`/tmp/fastvibe-search-full-final.log`、`/tmp/fastvibe-search-clippy.log`、`/tmp/fastvibe-search-schema.log`、`/tmp/fastvibe-search-fetch-recheck.log`。

内容面板、系统设置、导入、外围和交付等清单项仍需完成，完整目标保持进行中。


## 第二十五批：macOS 原生浏览器和本地文档视图基础

继续应用本体优先。本批不实施远程连接或 Flutter，旧 Electron 完整数据导入保持最后。

- 引入固定版本 `wry =0.57.1`，在 GPUI 主线程创建真正的原生 WebView 子视图。侧栏“浏览器”创建会话专属标签，提供地址/搜索、后退/前进、刷新/停止、系统浏览器打开、网页标题与加载状态；新窗口请求落在同一会话的新标签。`⌘L`/`⌘R` 和原生菜单接通地址栏/刷新，编辑菜单的系统动作支持 WebKit 的复制、粘贴、选择和撤销。普通浏览器使用持久网站数据，文档视图使用独立的非持久数据。
- 浏览器 URL 与标签顺序/归属纳入现有私有面板恢复，重启后使用新运行时 ID；首条消息把发送前打开的草稿标签移入新会话，不带到下一条新对话。不序列化 WebView、网站凭据或页面内容。拒绝把保存的 file/data/javascript 地址当作网页恢复。关闭标签、删除会话或文件标签被移除时销毁原生视图；异步回调核对当前文档版本，不能更新被替换的预览。
- HTML 文件从源码占位变成可执行的独立文档预览，仍可切换源码和保存；图片/视频/PDF 从文件信息占位变成媒体视图，提供手动刷新。视频有原生控制条，PDF 交给 WebKit 按 MIME 加载。此处仅接通 macOS 实现，Windows/Linux 仍属于平台交付，未以外部浏览器打开代替嵌入预览。
- 每份文档独占随机令牌与回环监听，只服务授权的 HTML 或已打开的单个文件句柄，没有工作区路径、目录列表、调用 API 或页面到应用的 IPC。HTML CSP 沿用 Electron 的内联脚本/HTTPS 资源边界；拒绝表单提交和本地文件导航。文档不能自动导航或弹出系统浏览器；可打开的外部链接显示为原生按钮，由用户点击。文档使用临时网站数据，设备权限拒绝，下载暂由用户在系统浏览器中完成。
- 媒体支持 GET/HEAD、单段/后缀/开放结束 Range、206/416、正确长度与 MIME；每次至多拷贝 64 KiB，不把整个视频读进界面或转成 base64。固定文件句柄不追随同路径的替换文件；服务与当前预览共同释放，活跃请求也检查取消。监听只绑定回环、校验 Host/Origin、有请求头/并发/读写时限，来源路由不能访问任意文件。
- 子视图位置和大小由 GPUI 实际布局与裁切矩形推导。切会话/标签、收起、菜单/模态框、拖动侧栏/文件分栏时隐藏旧视图，重新出现保持原网页；完全进入裁切区前不显示，避免动画期间覆盖其它面板。隐藏时把键盘交回 GPUI；网页进程退出后给出重试，重建使用最后已知地址。宽窄文件面板都避免给原生网页/编辑器再套外层滚动容器。

API 对照 [Wry 0.57.1 文档](https://docs.rs/wry/0.57.1/wry/)及其本地固定版本源码。验证只使用编译、单元测试与真实回环 HTTP，不使用 computer use，也不宣称做过视觉/浏览器进程渲染验收。

验证：`fv-gui` 全包回归 109 项通过、0 失败、0 忽略，文档测试通过；包括新增地址/导航/裁切、真实 HTTP 文档与路径边界、媒体 Range/并发/大文件 HEAD/撤销、浏览器恢复和首条消息的标签归属 10 项。macOS 桌面二进制构建、GUI all-targets 严格 Clippy、workspace 格式与 diff 检查通过。本批未改共享调用协议或模型引擎，未重复上一批的八包 625 项联合回归。日志：`/tmp/fastvibe-webview-tests-final.log`、`/tmp/fastvibe-webview-clippy-final.log`、`/tmp/fastvibe-webview-build-final.log`。

完整浏览器控制、书签/历史/下载、资料导入与设置、辅助对话、Office 静态/实时渲染、公式、产物查看器和其它清单项仍未完成；完整目标保持进行中。


## 第二十六批：OfficeCLI 预览与运行环境

应用本体继续优先。API 为当前原生 App Server 协议，不接入旧 Electron 数据目录、订阅模型或旧远程协议。

- 新增共享 `office/render|watchStart|watchStop|watchState|selection`，GUI 只调用公开协议。静态渲染可用于任意已授权客户端；实时预览/选中租约仅允许本机客户端，拒绝把回环地址交给 SSH、LAN 或官方连接。长调用在连接的有界后台集合里运行，轻量关闭/状态查询不占长调用名额，停止、回答和关闭仍能处理；断连先取消并收尾后台请求，再释放本连接租约。
- 开发资源使用现有清单固定的 OfficeCLI `v1.0.157`；本次通过 `scripts/fetch-officecli.mjs` 下载 mac-arm64 原始资源并校验仓库固定 SHA256，没有安装到用户 PATH。`fv-env` 从应用资源目录解析内置程序，核对清单、可执行权限和原始二进制哈希；不回退搜索用户自己的 OfficeCLI。应用启动后资源解析结果固定。
- Agent 的管道/PTY 命令、侧栏终端、MCP 子进程和预览进程共享内置 OfficeCLI 的 PATH 前缀、绝对程序地址 `FASTVIBE_OFFICECLI_BIN`、禁止更新/自动安装、逐次落盘与每个 data-dir 独立的绝对状态目录。仅修改所启动子进程的环境，不修改 HOME 或多线程进程全局环境。原生 office 技能明确使用绝对程序地址，避免登录脚本重排 PATH 后误用另一版本；使用文件链接交付，去除已从原生计划删除的 `present` 调用；专项说明仍由同版本 CLI 的 `load_skill` 提供。
- 静态预览只接受 docx/xlsx/pptx，拒绝其它扩展名、目录或超过 256 MiB 的输入；规范化真实路径后执行 `view ... html -o ...`。按真实路径、大小、mtime 与 CLI 版本缓存，输入在渲染期间变化不发布旧结果。合并相同键的并发请求，最多四个渲染、十六个待完成键，60 秒时限、16 MiB HTML 上限、受限输出与临时页；成功后才原子发布。缓存以 512 MiB 为软上限，超限清理到 75%，保护当前页并过期清理崩溃遗留临时页。
- 每个静态请求与实时视图都带连接内唯一租约。关闭在启动之前到达也会记住，迟到请求不能重新打开；取消一个静态等待者不影响其它窗口，取消最后一个则停止渲染并收尾进程。关闭界面、删除标签或断连都会释放，不依赖 RPC 成功返回后才知道要关哪一个请求。
- 实时进程按真实路径共享，最多十六份文档，每连接三十二个租约；最后一个引用释放后延迟三秒退出，重新打开使旧的释放定时器失效。选回环空闲端口、至多三次启动尝试、每次十五秒，校验页面的文档标题与三种格式共有的 OfficeCLI 标记，不能把另一个占用端口的应用误认作就绪。探测和刷新绕过网络代理，不跟随跳转。
- 定时比较源文件以覆盖外部原子替换，防抖后 `POST /api/switch`；失败重试有上限，不能一直把旧页当作已经更新。预览进程退出、文件消失和服务关闭都有终态。启动/更新/退出清理受当前服务取消约束；Unix 终止进程组并等待所启动的子进程退出，不把残留子进程当作结束。活跃渲染和实时预览计入服务忙碌，开发重载不会抢在工作中替换它。
- GUI 并行准备静态页与 live：静态快照先可用时先显示，实时 WebView 在隐藏状态预加载，只有预期文档的完成事件才替换；实时失败保留快照并提供刷新。页面与原生浏览器资料隔离、没有应用 IPC；切会话/收起/拖动/菜单仍沿用前一批的原生遮挡处理。Office 与不支持的旧 Office 格式提供“用系统应用打开”。
- docx/pptx 显示“引用选中内容”，执行同版本 CLI 的 `get ... selected --json`，保留稳定元素路径、最多二十四项与 Unicode 安全短引文。响应同时核对标签租约与当前对话，不能把旧窗口的选中内容塞入另一个会话；追加时保留 composer 技能徽标。xlsx 不提供元素路径引用。已有 Git 树检查点按字节覆盖 shell/OfficeCLI 改出的二进制文档，无需恢复旧版按工具名快照的机制。

验证：七个相关包（`fv-env`、`fv-tools`、`fv-mcp`、`fv-protocol`、`fv-store`、`fv-server`、`fv-gui`）联合回归 535 项通过、0 失败；常规运行明确忽略 1 项需要资源的真实 CLI 烟测，该项随后已显式执行。Office 全套公开 RPC/进程/真实 CLI 验收 5 项通过、0 忽略，覆盖三种格式、跨窗口复用、外部原子替换的实际页面内容、最后引用释放后退出、取消/断连、后台请求槽满时关闭仍可响应。随后加强取消用例，先确认部分 HTML 已落盘再停止，复验通过。最终 GUI 109 项、协议 23 项、环境测试、七包 all-targets 严格 Clippy、桌面/服务端二进制构建、workspace 格式与 diff 检查通过；这些集合重叠，不累计相加。首轮回归发现旧 Ctrl-C 用例把默认 250ms 提前返回误当成子进程已退出，已改为在必要时继续收集并断言正常退出或信号终态，仍断言受限输入不能写文件；未改变 Ctrl-C 的执行语义。

日志：`/tmp/fastvibe-native-office-regression-final.log`、`/tmp/fastvibe-native-office-acceptance-final.log`、`/tmp/fastvibe-native-office-cancel-final.log`、`/tmp/fastvibe-native-office-gui-final.log`、`/tmp/fastvibe-native-office-protocol-final.log`、`/tmp/fastvibe-native-office-env-final.log`、`/tmp/fastvibe-native-office-clippy-final.log`、`/tmp/fastvibe-native-office-build-final.log`。测试全部是代码、进程、真实本地 HTTP/RPC 与 CLI，不使用 computer use 或视觉验收。

交付边界仍在待完成范围：当前原始二进制哈希校验针对开发资源；macOS 打包重签会改变二进制，签名阶段必须对齐已封装资源的运行时校验并完成真实安装包验收。资源二进制、许可证/NOTICE、清单与原生 office 技能都须纳入打包。Windows 进程树收尾与原生 WebView 仍随平台交付验证；远程内容字节传输随后续新协议/手机适配完成。

辅助对话、公式、产物查看器、完整浏览器功能、其它设置、导入、外围与交付仍未完成，完整目标保持进行中。


## 第二十七批：原生 Markdown 数学公式

继续应用本体优先，远程、Flutter 和旧 Electron 数据导入保持后置。

- `fv-gui` 的 Markdown 视图启用 GPUI 自带的 math text / math flow AST，并注册行内与块级公式节点。行内公式在文本流中保持 baseline，块级公式有独立边框、主题色和间距；列表、表格和流式 Markdown 仍沿用同一解析管线。
- 常见 Greek 字母、无穷、根号、求和、乘号、不等式、箭头和短幂指数转成清晰的原生字形；未知命令保留原始 TeX，半写公式不会抛异常。公式节点仍保留原始源码，复制/无障碍文本不会丢失作者输入，也不会执行、联网或读取文件。
- 这批使用无外部浏览器、无动态 HTML 和无远程字体的原生降级渲染，避免公式内容突破消息渲染边界。完整 KaTeX 字体/复杂宏布局仍属于后续视觉与平台交付评估，不把未验证能力宣称为完整 TeX 引擎。

验证：`fv-gui` 88 项单元/集成测试通过、0 失败，严格 Clippy、格式和 diff 检查通过；新增公式符号、安全降级和原始源码保留测试。未使用 computer use。

浏览器完整控制、辅助对话、产物查看器、电脑操控、剩余设置/外围/交付、远程与手机、其它 Agent 导入和旧 Electron 导入仍未完成，完整目标保持进行中。


## 第二十八批：辅助对话入口对齐原生子 Agent

- 侧栏“辅助对话”不再显示迁移占位。它读取当前对话的真实子 Agent 列表，选择一个未关闭的子线程后进入同一原生转写、问题/审批和停止/恢复路径；没有子 Agent 时给出明确提示，让 Agent 先使用 `spawn_agent` 创建任务。
- 入口不复制 transcript、模型凭据或工具状态，也不在 UI 侧创建伪造子线程。子 Agent 的角色、只读限制、祖先工具上限、持久化和重启恢复继续由现有 App Server 负责。

验证：`fv-gui` 88 项测试通过，新增路径与现有子 Agent RPC/存储测试共同覆盖；没有使用 computer use。

剩余工作仍包括完整浏览器控制/资料库/下载配置、产物查看器、电脑操控、扩展/系统设置的其余操作、外围/交付、其他 Agent 导入、远程与手机适配及最后的旧 Electron 数据导入。


## 第二十九批：原生音频产物链路

继续应用本体优先。本批没有实现远程连接、Flutter 适配或旧 Electron 数据导入。

- `code_mode` 增加 `audio()` helper，接受受限 MIME 的 base64 data URL 或 `{mimeType,data}`，单个不超过 16 MiB、每批最多四段；无效格式、非法 base64 和超限明确报错。
- 音频从 `ToolOutput`、Agent 回合提交、持久化历史一路进入当前 `fv-protocol` 的 `Item::Audio`，协议 schema 已同步；文件源会在服务端转换为 base64，避免依赖额外媒体端点。
- 代码模式嵌套工具也保留音频产物；GUI 原生转写显示 MIME、名称和播放入口，用户点击后用 data URL 交给系统播放器/浏览器，不把音频当图片或普通文本伪造。

验证：workspace `cargo check` 通过；代码模式音频用例、Agent 全量测试、服务端 104 项单元测试和协议 schema 快照通过。全部仅使用代码与自动化验证，没有 computer use。

内容面板、完整浏览器功能、系统设置、导入、外围和交付等清单项仍需完成；远程与手机适配后置，旧 Electron 完整导入最后实施。

## 第三十批：浏览器控制与下载配置

继续应用本体优先。本批没有实现远程连接、Flutter 适配或旧 Electron 数据导入。

- 浏览器设置页已提供主页、地址栏搜索 URL 模板和下载目录编辑，保存走共享 `settings/set`，服务端校验 HTTP(S)、`{query}` 占位符和绝对路径。
- 地址栏输入按已保存模板搜索，打开新浏览器标签使用已保存主页；浏览器 WebView 的下载回调写入配置目录，留空使用当前用户的 `Downloads` 目录，并在界面显示下载路径。
- 配置字段有默认值和旧设置兼容，协议 schema 已同步；本地原生 WebView 的网页隔离和文档视图边界保持不变。

验证：workspace 编译通过；新增浏览器地址模板单测、服务端设置校验/持久化用例、协议 schema 快照通过。全部仅使用代码与自动化验证，没有 computer use。

电脑操控、其它设置、外围、交付、远程与手机适配、其他 Agent 导入和旧 Electron 完整导入仍需完成。

## 第四十五批：深层工作区语言覆盖

继续应用本体优先。本批没有实现远程连接、Flutter 适配或旧 Electron 数据导入。

- 子 Agent 列表、状态托盘、并发/委派限制和角色模板编辑器现在随界面语言切换；角色保存、冲突、删除和只读工具范围提示也有英文路径。
- MCP 服务器表单支持中英文名称、命令、参数、环境变量/请求头、启停和保存错误；OAuth 登录表单、授权状态、重连和退出提示同步切换。
- 文件树新建/重命名/废纸篓/永久删除菜单和确认描述、终端启动/读取/调整尺寸错误、Office 预览按钮与回退状态、面板标签菜单均补齐英文路径。
- 转写里的工具类别、批量工具摘要和处理/耗时文案使用当前语言；底层协议和历史数据格式不变。
- 深层设置的导入、电脑操控、浏览器/代理、供应商与模型默认值、沙箱/审批、归档、技能、搜索、快捷键和模型自检提示同步切换；Git、浏览器控制、定时任务、项目对话、个性化 Agent 说明和工作区恢复的常用状态也不再强制回退中文。

验证：`fv-gui` 90 项无界面单测、workspace 编译和 all-targets 严格 Clippy 通过；全部仅使用代码与自动化验证，没有 computer use。

少量后台异步错误摘要、部分低频无障碍标签和编辑器占位仍保留中文回退；电脑操控跨平台安装验收、i18n 全量收口、签名安装包、远程与手机适配以及旧 Electron 完整导入仍按清单顺序保留。

## 第四十六批：原生本体回归与 bundle 烟测

本批继续应用本体优先，没有开始远程连接、Flutter 适配或旧 Electron 导入。

- 原生服务端增加 `fastvibe-server --help` / `--version` 的无副作用入口，bundle CI 在 macOS、Linux 和 Windows staged 产物上先做哈希/资源校验，再启动 server help 烟测，避免只验证文件存在而漏掉不可启动的产物。
- GUI 语言迁移后的工作区、设置、浏览器、Git、定时任务、模型详情、技能、供应商自检和转写路径保持同一协议与状态模型，没有引入第二份数据存储或订阅登录流程。

验证：`NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 pnpm native:test` 全 workspace 通过；`fv-gui` 90 项通过；workspace all-targets 严格 Clippy、`fastvibe-server --help` 和 `actionlint .github/workflows/native-bundles.yml` 通过。OfficeCLI 真实资源烟测仍按既有清单要求在对应交付环境执行，全部验证只使用代码、进程和自动化检查，没有 computer use。

## 第三十四批：自动归档旧对话

偏好设置增加“自动归档旧对话”开关。开启后服务端每小时检查一次，将 30 天未活动、未置顶且没有运行任务的对话归档；关闭后不再执行。手动归档、恢复和删除仍沿用原协议，自动归档只修改归档标记，不删除转写、文件或用量记录。新字段对旧设置默认为关闭。

验证：服务端旧对话/置顶/运行状态筛选用例、协议 schema、workspace 编译和严格 Clippy 通过。全部仅使用代码与自动化验证，没有 computer use。

电脑操控、i18n、通知、Dock 角标、保持唤醒、其它设置、交付、远程与手机适配、其他 Agent 导入和旧 Electron 完整导入仍需完成。

## 第三十五批：保持唤醒

偏好设置增加保持唤醒开关。服务端启动时读取设置，设置变更即时启动或停止 macOS `caffeinate -dimsu` 子进程，服务销毁时回收子进程；非 macOS 平台安全忽略该开关。默认关闭，旧设置自动使用默认值。

验证：协议 schema、设置持久化、workspace 编译和严格 Clippy 通过；未在真实桌面上执行或验证睡眠行为，全部仅使用代码与自动化检查。

电脑操控、i18n、通知、Dock 角标、其它设置、交付、远程与手机适配、其他 Agent 导入和旧 Electron 完整导入仍需完成。

## 第三十六批：后台回合通知

GUI 现在会监听共享 `turn/completed` 事件：当未选中的对话完成、停止或失败时，在侧栏通知中显示状态；打开该对话后不重复弹出。失败消息沿用服务端的安全错误摘要，通知不改变回合事件序号或历史。

验证：GUI workspace 编译和严格 Clippy 通过；全部仅使用代码与自动化检查，没有 computer use。

电脑操控的完整跨平台验收、i18n、其它设置、交付、远程与手机适配、其他 Agent 导入和旧 Electron 完整导入仍需完成。

## 第三十九批：网络代理设置

网络代理页已接入共享 `settings/set`。代理 URL 经服务端校验后用于模型请求、模型目录刷新和模型列表读取；模型客户端通过 `genai` 的自定义 reqwest 客户端统一使用该代理，留空继续使用系统默认。代理凭据只保存在设置存储，不会进入诊断摘要或普通模型上下文。

验证：代理设置持久化用例、协议 schema、provider/server/GUI 编译和严格 Clippy 通过。全部仅使用代码与自动化检查。

远程访问、SSH 远程主机、i18n、其它设置、交付、远程与手机适配、其他 Agent 导入和旧 Electron 完整导入仍需完成。

## 第四十批：应用更新检查

关于页增加应用更新检查，通过服务端使用当前网络代理访问 GitHub 最新发布 API，返回当前版本、最新版本、安全发布链接和有界说明文本；网络失败或无效元数据只返回通用错误，不泄露请求细节。检查只读取发布信息，不自动下载、替换或重启应用。

验证：协议 schema、URL 安全校验、workspace 编译和严格 Clippy 通过。自动更新下载、签名、安装和回滚仍列入交付验收。

远程访问、SSH 远程主机、i18n、其它设置、交付、远程与手机适配、其他 Agent 导入和旧 Electron 完整导入仍需完成。

## 第三十八批：受控电脑操控工具

原生工具表增加 `computer`：macOS 上支持截图、点击、输入和有限按键；截图只读，点击/输入/按键每次都通过现有用户确认流程，动作范围和文本长度有界，依赖系统 Accessibility 权限。截图以受限图片产物返回模型；非 macOS 平台明确返回不支持，不伪造成功。

验证：工具 schema、编译和严格 Clippy 通过；未执行真实桌面操作、未使用 computer use 做验证，系统权限和真实窗口行为仍需平台交付验收。

电脑操控的完整跨平台验收、i18n、其它设置、交付、远程与手机适配、其他 Agent 导入和旧 Electron 完整导入仍需完成。

## 第三十七批：Dock 角标

macOS GUI 为未选中对话的后台回合完成/停止/失败状态维护未读数量，并同步到 `NSApplication` 的 Dock tile badge；打开任意对话后清零。其它平台保持无操作，通知正文仍由现有 GUI 通知卡显示。

验证：GUI workspace 89 项回归、编译和严格 Clippy 通过；未使用 computer use 或真实桌面视觉验证。

电脑操控、i18n、其它设置、交付、远程与手机适配、其他 Agent 导入和旧 Electron 完整导入仍需完成。

## 第三十三批：关于页诊断信息

关于页增加 `diagnostics/get`，返回版本、协议、平台以及模型/供应商/线程/MCP/记忆状态的有限摘要；不返回数据目录、API Key、请求头或转写内容。GUI 读取后提供复制到剪贴板，服务端策略与 schema 已同步。

验证：服务端脱敏诊断用例、协议 schema、workspace 编译和严格 Clippy 通过。全部仅使用代码与自动化验证，没有 computer use。

电脑操控、其它设置、外围、交付、远程与手机适配、其他 Agent 导入和旧 Electron 完整导入仍需完成。

## 第三十二批：偏好恢复默认

关于页增加“恢复默认”操作，通过新的 `settings/reset` 原子替换主题、沙箱、快捷键、浏览器和 Agent 说明等应用偏好；供应商、模型、会话、MCP 和记忆数据不在该操作范围。所有客户端收到同一份设置通知，旧设置缺少新浏览器字段时继续使用默认值。

验证：协议 schema、服务端恢复默认/广播路径、GUI 编译和严格 Clippy 通过。全部仅使用代码与自动化验证，没有 computer use。

电脑操控、其它设置、外围、交付、远程与手机适配、其他 Agent 导入和旧 Electron 完整导入仍需完成。

## 第三十一批：图片产物查看链路

工具图片此前只进入模型请求和文件存储，没有作为客户端转写项目展示。本批把 `ToolImages` 映射为当前协议的 `Item::Image`，历史恢复与分叉保留图片数据，GUI 提供 MIME、名称和查看入口；音频使用同一套产物模型。协议 schema 和现有图片落盘路径保持兼容。

验证：workspace 编译、协议 schema、存储历史、服务端图片回归和 GUI 代码检查通过；全部仅使用代码与自动化验证，没有 computer use。

电脑操控、其它设置、外围、交付、远程与手机适配、其他 Agent 导入和旧 Electron 完整导入仍需完成。

## 第四十七批：异步错误提示的英文路径

继续应用本体优先，没有开始远程连接、Flutter 适配或旧 Electron 导入。

- 设置里模型菜单的“暂无模型”提示、MCP 读取失败和“配置已更新”提示也已切换。
- 关于页的检查更新失败、恢复默认成功/失败提示，使用统计读取失败，以及模型详情保存时的正整数和思考强度校验错误，现在随界面语言切换。
- 异步回调在结果到达时读取当前语言，而不是发起请求时的语言。

验证：`fv-gui` 90 项单测、all-targets 严格 Clippy 通过；仅代码与自动化验证，没有 computer use。

仍保留中文回退的：部分低频无障碍标签、编辑器占位及其它后台错误摘要，i18n 全量收口未完成。

## 第四十八批：i18n 基础设施（rust-i18n）

GPUI 不带 i18n，此前文案靠手写 `if english { … } else { … }`，漏翻译编译器发现不了。本批引入 `rust-i18n`（只有中英两种语言、以带变量的短句为主，用不到 Fluent 的复数/语法性别规则；`t!(key, locale = …)` 可按调用传语言，不依赖全局状态）。

- 文案放在 `crates/fv-gui/locales/app.yml`，`_version: 2`，每个键下 `zh` / `en` 并排；v1 格式把文件名当语言，不能用。`lib.rs` 里 `rust_i18n::i18n!("locales", fallback = "zh")`。
- `workspace/mod.rs` 的 `text` 模块的 18 个函数改由 `texts!` 宏生成，键为 `text.<函数名>`；返回类型由 `&'static str` 改为 `String`。语言到 locale 的映射是 `text::locale`。
- 测试 `locale_file_tests` 直接读 yml，检查每个键 zh/en 都非空（缺英文时 `fallback = "zh"` 会静默回退成中文），并钉住几条中英文渲染结果。
- `pane_office.rs` 的 8 条文案（返回/系统打开/刷新、引用选中、预览准备与失败提示）已迁入，键前缀 `office.`；带变量的用 `%{name}` 占位，调用点 `rust_i18n::t!(key, locale = text::locale(lang), name = v)`，无变量的用 `text::tr(lang, key)`。新增测试检查两种语言的占位符一致。
- 其余 `if english { … }` 尚未迁移；后续按模块逐批搬进 `app.yml`，每批保持中文逐字不变。

验证：`fv-gui` 92 项单测、all-targets 严格 Clippy 通过；仅代码与自动化验证，没有 computer use。

## 第四十九批：界面文案全部迁入 locale 文件

`fv-gui` 里约 610 处 `if english { … } else { … }` 全部迁入 `crates/fv-gui/locales/<模块>.yml`，每个模块一个文件，键为 `<模块>.<英文前几个词>`，同一模块内相同的中英文对复用一个键。

- 调用点：无变量的用 `trs!(english, "模块.键")`（返回 `&'static str`，每个（键，语言）只泄漏一次，键集合编译期固定）；带变量的用 `tr!(english, "模块.键", name = value)`（返回 `String`，yml 里写 `%{name}`）。两个宏在 `workspace/mod.rs` 顶部、子模块声明之前，所以子模块可直接用。位置参数 `{}` 在迁移时改成 `%{arg1}`、`%{arg2}`。
- 思考强度标签统一为 `composer::thinking_label_in(level, english)`；两个 `|zh, en|` 闭包改为只传键。
- 个性化页把已存的中文状态翻译成英文的那段逻辑保留（`if english` 只剩这一处），其中的文案同样走 locale 文件。
- 测试 `locale_file_tests` 现在读全部 yml：键不重复、每个键 zh/en 都非空、两种语言的占位符一致，并扫描源码里所有 `tr!`/`trs!`/`text::tr` 的键确认都存在（缺键时 `t!` 会直接显示键名）。迁移过程中它抓到了两处重复定义。
- 仍在 `workspace/mod.rs` 里的 `text` 常量、`presentation.rs` 的 `label(中, 英)` 辅助、`fixture.rs` 的示例数据不属于 `if english`，未动。

验证：`fv-gui` 95 项单测、all-targets 严格 Clippy 通过；仅代码与自动化验证，没有真实窗口里的视觉验证。

## 第五十批：macOS 菜单栏对齐

原生菜单栏此前只有 FastVibe / 浏览器 / 编辑三项，全是中文，不随界面语言，没有关于、隐藏、窗口、帮助。

- 新增 `workspace/app_menu.rs`：应用菜单（关于 FastVibe、设置…、服务、隐藏 / 隐藏其他 / 全部显示、退出）、文件（新对话、搜索…）、编辑（撤销…全选）、视图（地址栏、重新加载）、窗口（最小化、缩放）、帮助（官网）。隐藏与最小化的 `⌘H` / `⌥⌘H` / `⌘M` 仅 macOS 绑定。
- 文案在 `locales/app_menu.yml`；`Workspace` 记录菜单当前语言（`menu_english`），渲染时发现界面语言变了就重建整个菜单栏，所以切换语言后菜单立即跟随。
- `⌘,` 没有另绑：它是可配置的“打开设置”快捷键（默认 `mod+,`），由窗口自己分发，再绑一次会触发两遍。
- 关于 → 打开设置的“关于”页；官网 → `https://fastvibe.dev`。

验证：`fv-gui` 95 项单测、all-targets 严格 Clippy 通过；locale 测试覆盖菜单的键。没有在真实菜单栏里看过，“标题栏状态”和“工具详情”两项对齐仍未做，清单里的“对齐”因此保持未勾选。

## 第五十一批：标题栏的 Git 状态

Electron 的会话标题栏在“项目 / 标题”后面有一个仓库状态按钮（分支图标、分支名、`+N -M`，干净时是对勾），原生版没有。

- 新增 `workspace/header_git.rs`：对当前会话项目的主文件夹读 `workspace/gitStatus`，切换会话时立即重读，之后每 5 秒刷新一次（代理在窗口之外改文件，没有可订阅的事件）。读失败时保留上一次的状态，不让按钮闪没；不在仓库里、或还没有结果时不画，与 Electron 一致。
- 点击打开右侧的 Git 面板（暂存、提交和审查都在那里）。Electron 的气泡里还有拉取/推送和提交框，见第五十二批。
- 标题栏里原来写死中文的三个无障碍标签（展开侧边栏、新对话、展开侧边面板）改走 locale 文件。
- capture 夹具给按钮塞了一个手写状态，截图对照过：分支图标、分支名、绿色 `+8`、红色 `-0` 的位置和 Electron 一致。

验证：`fv-gui` 全部单测、all-targets 严格 Clippy 通过；离屏截图目检了标题栏。工具详情的对齐这批没有动，清单里的“对齐”保持未勾选。

## 第五十二批：拉取 / 推送与标题栏气泡

协议新增 `workspace/gitPull`、`workspace/gitPush`（参数 `CwdParams`，返回新的 `GitStatus`），标题栏按钮改成带气泡的版本。

**服务端**（`fv-server/src/git.rs` 的 `sync`）
- 拉取是 `git pull --ff-only`，推送是 `git push`，与 Electron 一致。分叉时拉取直接失败并说明原因，不合并、不变基，也不会留下冲突的工作区。
- 不能等人：`GIT_TERMINAL_PROMPT=0`，stdin 为空，没设 `GIT_SSH_COMMAND` 时用 `ssh -o BatchMode=yes`，所以要密码的远程直接报错而不是挂住。
- 60 秒超时，到点杀掉整个进程组（ssh 和凭据助手一起），不遗留子进程。handler 在 `spawn_blocking` 里跑，不占异步线程。
- 远程策略里归为允许（与 `gitCommit` 同一理由）；`schema/protocol.json` 已重新生成。
- 测试：`git::tests` 三个真实仓库用例（一个裸 origin 加两个克隆）——推送后 ahead 归零、另一克隆快进拉取、分叉拉取失败且 HEAD 不变且工作区干净、落后时推送被拒；`tests/git_projects.rs` 再走一遍公共协议。

**标题栏气泡**（`workspace/header_git.rs`）
- 点击按钮在按钮下方弹出：分支名 + 拉取/推送图标（进行中变成加载图标，其余按钮变淡），改动摘要行（`N 个改动 +a -d`、已暂存数、↓落后 ↑领先，点它打开 Git 面板），提交信息框，「提交」（暂存全部后提交，与 Git 面板的按钮一致）和「提交并推送」。
- 提交后推送失败时提示“已提交，但推送失败：…”，提交本身保留；成功后关闭气泡并给出提示，输入框清空，已打开的 Git 面板同步刷新。
- 同一时刻只做一件事；提交信息为空时提示而不发请求。气泡并入统一的 `any_menu_open` / `close_menus`，点别处或 Esc 关闭。
- AI 生成提交信息和隔离工作区的解除绑定行见第五十三批。
- 开发开关 `--git-menu` 配合 `--fixture theme` 可截图查看。

验证：`fv-gui` 95 项、`fv-protocol`、`fv-server` 测试与 all-targets 严格 Clippy 通过；气泡用离屏截图目检过布局。没有连真实远程（SSH、凭据助手）验证，只用本地裸仓库。

## 第五十三批：AI 提交信息与气泡里的隔离工作区行

**协议与服务端**：`workspace/gitGenerateCommitMessage`（`cwd`、`conversationId`、`includeUnstaged`）返回 `{ message }`。

- 用的是会话自己的模型（`suggestion_model`，与回复推荐同一入口，所以测试能注入脚本模型）；原生版没有“轻量模型”设置，所以不另选模型。
- 提交信息一律英文，与会话语言无关：它是仓库历史的一行，`git log`、CI 和同事都在读。提示词沿用 Electron 的措辞（一行、祈使句、不超过 72 字符、倾向 conventional commit、把路径与 diff 当不可信数据）。
- 给模型看的材料由 `git::change_material` 拼：文件清单（状态、`+a -d`）加上按预算截取的补丁——单文件 6000 字符、总计 60000，源码优先、锁文件和生成物只列名字不读内容，二进制跳过；未跟踪的文件只带前 40 行。`includeUnstaged: false` 只读暂存区（提交路径刚暂存完），`true` 读整棵树对 `HEAD`。没有改动时直接报错，不去问模型。
- 答案取第一行，去掉标签、引号、反引号和结尾句号，最多 100 字符；失败或超时（60 秒）会报给用户，不吞掉。
- 与 Electron 不同：材料过大时是按预算采样，不做“按目录分组再汇总”的分层摘要。
- 测试：`commit_message::tests`（清洗与提示词）、`tests/commit_message.rs` 走公共协议（模型看到了源码补丁和新文件内容、锁文件内容没进提示词、只读暂存区且没暂存时不问模型、未知会话被拒）。

**气泡**
- 提交信息框右上角有一个 AI 生成按钮（生成中变加载图标），结果填进输入框，可以再改。
- 提交信息为空时，点「提交」/「提交并推送」会在暂存全部之后先让模型写一句再提交；生成失败会提示，提交不会发生（暂存已经做了）。
- 会话在隔离工作区里时，气泡底部多一行“隔离工作区：路径”和「解除绑定」，走会话菜单同一个 `unbind_worktree`；解除后会话回到项目目录，标题栏按钮随之重读新目录。

验证：`fv-gui` 95 项、`fv-protocol`、`fv-server` 测试与 all-targets 严格 Clippy 通过；离屏截图目检了新增的按钮和隔离工作区行。没有用真实模型试过生成，只用脚本模型。

## 第五十四批：工具详情对齐与 i18n 收口

**工具详情**：用 Electron 的 `mock.html` 与原生离屏截图对照批量摘要行、思考行和终端失败行，结构一致，没有发现需要改动的差异：连续的已完成调用折成一行（“已写入 App.tsx，运行 1 个命令”）、思考独占一行并带时长、终端行是 `终端 命令 执行失败`、点开是 `$ 命令` 加输出。`presentation.rs` 里批量摘要的英文原先是“先出中文再用字符串替换翻成英文”，会出现 `Ran 2 commands，Read x` 这种中英文标点混用、后续分句首字母大写的错误；现在直接按语言取文案。没有逐像素比对，也没有在 Electron 里逐类展开每种工具。

**i18n 收口**
- `describe`、`run_summary`、`format_duration` 改为接收 `english`，文案走 `locales/presentation.yml`；删掉 `describe_localized`、`run_summary_localized`、`format_duration_localized` 和没人调用的 `tool_title`。英文批量摘要现在是 `Ran 2 commands, read pic.png`（第一个分句大写、之后小写，分隔用 `, `），单个命令是 `Ran 1 command`。
- `tr!` / `trs!` 宏从 `workspace/mod.rs` 移到 `lib.rs`，所以任何模块都能用；`static_text` 的缓存改成按语言、再按键两层表，命中时不再分配。
- `Workspace::english()` 取代到处重复的语言比较。把 118 处只有中文的提示迁到各自的 locale 文件：气泡和菜单项、重试对话框、所有“无法…”类错误提示、审批面板、用量页的月份与星期、转写里的“刚刚/N 分钟前”、复制与编辑、侧栏与面板的无障碍标签等。思考强度菜单和各处标签统一用 `thinking_label_in`，删掉只有中文的 `thinking_label`。
- 测试：locale 扫描现在也认 `self.english()` / `this.english()` 形式的键；`tests/presentation.rs` 钉住中英文批量摘要、时长、各类工具的中英文标签（这些键是运行时拼的，源码扫描看不到，所以单独遍历每个工具族）。

**没有迁的**：测试用夹具 `fixture.rs`；`mcp_oauth.rs`、`webview.rs`、`web_content.rs` 里回给用户的错误句子（它们不在持有语言的结构上）；几个本来就是中英并排的输入框占位符（`名称 / Name`）；个性化页把已存的中文状态译成英文的转换逻辑。

验证：在干净的工作树里单独验证了本批改动（工作区里同时有别的会话未提交的编辑，已分开）：`fv-gui` 95 项单测 + 12 项展示层测试、all-targets 严格 Clippy 通过。

## 第五十五批：电脑操控改用 Cua Driver（照 Electron 版的方式）

原来的 `computer` 工具只有截图、坐标点击、输入和 8 个键，调的是 `screencapture`/`osascript`/`xdotool`/PowerShell。现在接入 Electron 版用的同一个驱动 `cua-driver-rs 0.28.2`（MIT，Rust），约 60 个工具：窗口与应用列表、界面元素树加元素令牌、后台点击与输入、滚动、拖拽、菜单、剪贴板、浏览器等。

**权限在谁身上**：macOS 把辅助功能和屏幕录制记在发起进程所属的*应用*上，不是可执行文件路径。所以**由持有授权的 GUI 直接拉起驱动守护进程**（`cua-driver serve --embedded`，`CUA_DRIVER_EMBEDDED=1`，不经 shell、`open` 或 LaunchServices），驱动留在 FastVibe 的责任链里，用户只给 FastVibe 授权一次。守护进程盯着我们持有的 stdin 管道，GUI 退出或崩溃它就退出；`Host` 被丢弃时也会停掉它。服务端是独立进程，不拉起驱动，只经 `computer/host` 知道守护进程监听在哪里，并把 `cua-driver mcp --embedded --socket …` 作为一个**受管 MCP 服务器**接进来：不落盘、不出现在 MCP 设置页、用户保存自己的 MCP 列表也不会把它带走。

**协议**：`AppSettings.computerControl`（默认关）；`computer/status`、`computer/install`、`computer/host`；通知 `computer/changed`、`computer/installProgress`。`install` 与 `host` 远程一律拒绝（驱动操作的是这台电脑的桌面，socket 也只该由宿主指定），SSH 同样；GUI 的能力串里加了 `computerControl`，旧的空闲服务端会被替换。

**服务端**（`fv-server/src/computer.rs`）：固定版本和 SHA-256（与 Electron 版同一份），下载先走 GitHub、超时或校验失败换镜像；先落到临时文件，校验通过才解包，只取压缩包里叫 `cua-driver(.exe)` 的那一个成员（不按压缩包里的路径写盘），再原子替换；失败不动原来能用的版本。macOS 用一个通用二进制（43 MB），Windows 分 x64 与 arm64；Linux 不提供（驱动的 Linux 版要靠合成器相关的辅助程序，Electron 版也是这个结论）。已装版本不等于固定版本不算已安装：守护进程和代理必须是同一个发行版。

**批准**：照 Electron 版的口径，FastVibe 不在驱动之上再加每次动作的确认层——驱动的 `standard` 模式下常规自动化不弹窗，由宿主负责权限体验；总开关、OS 授权、屏幕上可见的代理光标是控制手段。原来的 `computer` 工具逐个动作确认，现在：开关关着时模型根本没有桌面工具；开着且驱动在跑时由驱动的工具取代它；开着但驱动没起来（还没装好、守护进程死了、授权没给）时它仍作为回退；没有驱动构建的平台连回退也没有，设置里整项隐藏（第五十七批）。驱动的工具标为“延迟”，通过 `tool_search` 取用，因为每个工具的 schema 约 7 KB，直接放进每次请求要十万 token。内置技能 `computer-use` 重写了一份，讲的是这批工具的真实名字和流程。

**设置页**（`workspace/computer.rs`）：开关（打开时若没装就自动下载，并在 macOS 上请求授权）、下载进度、组件版本和运行状态、辅助功能与屏幕录制各一行（未授权时有“打开系统设置”）、错误提示。`computer_sync` 是唯一的决定点：设置开着、组件已装、macOS 上两项授权齐了，守护进程才跑；设置推送、服务端通知、授权轮询（每 2 秒，只在等授权时）都调它。服务端重启后守护进程会被重新登记。

**验证**：`fv-server` 的 6 个新单测（下载校验与镜像回退、替换不破坏原版本、tar.gz 与 zip 取成员、空文件拒绝）加 3 个走公共协议的集成测试（用一个会记录启动参数、再扮成真 MCP 对端的假驱动：参数是 `mcp --embedded --socket …`、环境里 `CUA_DRIVER_EMBEDDED=1` 和遥测关闭、工具经 `mcp_computer_*` 到达并可调用、保存 MCP 列表不丢它、关开关立刻撤走工具、开关关着没有 `computer` 工具）；`fv-gui` 的 `Host` 用假守护进程测了：参数与环境变量、不带 `RESPONSIBILITY_DISCLAIMED`、丢弃即退出、启动即死时带回它的 stderr；设置页用离屏截图看过。

**没有验证的**：没有在这台机器上启动真正的驱动守护进程，也没有跑真实的点击或截图——那需要把辅助功能和屏幕录制授权给 FastVibe，应由你来操作；我也没有验证“授权后屏幕录制要重开应用才生效”在这个应用的签名下是否成立。Windows 的命名管道就绪检测、Windows 解包路径只有代码，没有在 Windows 上跑过。`--host-bundle-id` 用的是 `dev.fastvibe.desktop`（它只是驱动日志里的一个标签，不是信任依据）。`Cargo.toml` 里另一个会话加的 `gpui-test` 开发依赖和 `capture` 特性冲突（同一个包用了两个名字），带 `--features capture` 的构建过不了；我截图时临时去掉了它，没有改动提交内容。（该冲突已在第五十六批修掉：dev-dependency 改名 `gpui-capture`，与同名可选依赖合一。）

## 第五十六批：转写吸顶提示词（滚动时 pin 住用户提示词）

Electron 版滚动转写时把最近一条滚出视口的用户提示词 pin 在顶部（`message-list.tsx` 的 turn-scoped sticky：只在自己回合内生效、被下一回合的提示词顶起、两个回合的间隙里不 pin；玻璃下 pin 行自己不画底色、回复用 `mask-image` 在行底切断）。原生版此前完全没有这个行为。

**实现**（`workspace/sticky.rs` + `workspace/transcript.rs`）：GPUI 没有 `position: sticky`，用「第二份副本」做。每个回合从「多个平级子节点」改成一个 `.relative()` wrapper（间距不变），wrapper 与提示词行各埋一个 `canvas` 度量：prepaint 的 bounds 是屏幕坐标，减 `window.element_offset()` 与滚动容器 `bounds()` 的原点即内容坐标，按回合索引写进 `Workspace.sticky: Rc<RefCell<Vec<TurnSpan>>>`（`{top, bottom, 提示词行高}`）。下一帧 `transcript()` 读上一帧的区间（`mem::take` 取走，换线程/分叉留下的旧区间自动清空），`view_top = -scroll.offset().y`，某个区间满足 `top < view_top < bottom` 就把绝对定位的提示词副本画在 `top(clamp(view_top, …, bottom - 提示词高))`，作为滚动容器最后一个孩子（最后绘制、在最上层）；该回合流内那份 `.invisible()`（`Visibility::Hidden` 只跳过 paint，度量照跑）。副本的元素 id 带 `-pin` 后缀，避免与流内副本撞 GlobalElementId；两份的按钮都可点（滚出视口的流内副本因 content mask  hit 不到）。绝对副本计入滚动容器 content_size 但撑不大它（y 恒落在自己回合区间内），不影响跟随底部。

**玻璃差异（登记为近似项）**：GPUI 没有逐元素的渐变/alpha 遮罩，Electron 的「pin 行不画 + 回复 `mask-image` 切断（`GLASS_CUT_FEATHER` 16px 羽化）」无法复刻；改为整条带子铺浮层色——实色 `Token::Background`（与 Electron 的 `bg-background` 一致，视觉上隐形），玻璃 `Palette::overlay()`（96% 暗 / 98% 亮），回复在带子底边硬切断。`Palette::c()` 在实色下对玻璃专用 token 会 panic，填色必须按 `palette.glass()` 分支。

**测试与验收**：`sticky.rs` 六个纯函数用例（未滚/边界不 pin、回合中段 pin、顶起时 y = bottom − 提示词高、间隙不 pin、无提示词回合不 pin）；一个无头 GPUI 用例钉住度量区间是内容坐标、滚动后不变，且滚动后 `pinned()` 给出正确位置。`cargo test -p fv-gui` 全过、`cargo fmt --check` 干净。离屏截图目检：最后一回合不够高的夹具不画带子（正确）；markdown 夹具带子贴顶、回复在带子底边切断；玻璃下带子是高密度浮层、文字清晰。

**顺带修好 capture 构建**：第五十五批留下的 `gpui-test` dev-dependency 与 `capture` 特性给同一个 `gpui-pre` 包用了两个名字，任何 `--features capture` 构建都报 `the crate fv-gui depends on crate gpui-pre v0.3.9 multiple times with different names`（上一批靠截图时临时删 dev-dependency 绕过）。dev-dependency 改名 `gpui-capture`、与同名可选依赖合一后，`scripts/compare-ui.sh` 与 `--screenshot` 恢复可用，普通测试构建不受影响。

## 第五十七批：没有驱动构建的平台不提供电脑操控入口

第五十五批在 Linux 上留下一个「灰掉但还在」的入口：设置里「系统 → 电脑操控」照样列出，点进去开关按 `status.supported` 变灰、下面写一行「Linux 暂不支持电脑操控组件。」；而基础 `computer` 工具（xdotool）在开关为真、驱动又永远起不来时仍作为回退留给模型。两件事都不对：一个永远打不开的开关是噪音，而那个回退只能靠手写设置文件打开——界面上再没有地方能看见它或关掉它。

现在 Linux（以及任何没有驱动构建的平台）**根本没有这一页**。平台判定只有一处：`fv_protocol::types::computer_control_supported(os)`（`macos | windows`），界面和服务端读的是同一个函数，所以两边不会对某个平台各说各话。

- **界面**：`settings::section_available(section, os)` 是导航唯一的过滤器，`settings_nav` 按它跳过整行；一组里的页全被隐藏时连组标题一起不画，不留空标题。dev capture 的 `--settings computer` 仍直接开这一页——夹具要在它实际被截取的那个平台上可达，Linux 上不跑它。页内的 `!supported` 降级分支保留：它现在服务的是「共享判定按 OS 说有、`artifact()` 按 OS+CPU 说没有」的平台（32 位 Windows）。
- **服务端**：`computer::keep_basic_computer_tool(control_on, driver_running, supported)` 取代 `turn.rs` 里内联的三态判断，`!supported` 与「开关关着」「驱动在跑」一样撤掉基础工具。macOS / Windows 的行为逐位不变（那里 `supported` 恒真，函数退化成原来的 `control_on && !driver_running`），驱动的下载、校验、守护进程与授权轮询一个字没动；`computer_sync` 本来就要求 `status.supported`，Linux 上从不会去拉守护进程。
- **一致只有一个方向是硬性的**：有构建的平台**必须**显示这一页，否则用户没法装——`every_os_with_a_build_shows_the_pane` 钉住 `artifact()` 成功的每个 os/arch 都被共享判定认为支持。反过来允许不同：共享判定按 OS 回答，所以 32 位 Windows 保留这一页并在页内读到不支持的原因，那正是 `unsupported_reason` 存在的理由。

**验证**：`fv-server` 两个新单测（回退工具的四态真值表、构建与页可见性一致），`fv-gui/tests/settings_sections.rs` 三个用例（驱动平台每一页都可见、Linux 只少电脑操控这一页、未知平台同样隐藏）；后者遍历 `all_sections()` 而不是手写变体列表，所以以后新增一页会自动被覆盖。

## 第五十八批：界面逐屏对照 Electron 版

方法：Electron 预览（`mock.html`，`pnpm exec vite src/renderer --config vite.config.ts --port 5199`）与原生 `--fixture … --settings …` 在同一 1100×720 窗口截图，逐屏对比后改原生。新增的开发用入口：`--settings <任一分区 id>`（与 Electron 路由同名）、`import-sample`、`mcp-form`、`usage[-en][-tail]`，`--fixture schedules|schedules-empty|schedules-detail|schedules-edit|goal|skills`。

**协议与服务端**（schema 已重新生成）：
- `AppSettings` 增加 `aiLanguage`（AI 偏好语言，每轮作为系统提示的语言要求，与 Electron `output-language` 措辞一致）、`toolSearchEnabled`（关掉则不提供 `tool_search`）、`collapseThinking`（折叠思考内容，仅界面）、`notifications`（系统通知）；`keepAwake` 默认改为开，与 Electron 一致。
- 压缩记录 `Message::Compaction.stats`（原因 `threshold|overflow|manual`、压缩前后请求 token），`Item::ContextCompaction` 带出 `reason/tokensBefore/tokensAfter`，分隔线显示「已压缩上下文 · 接近上限 · 128.0K → 24.4K」。

**界面**：
- 设置导航宽度跟随主侧栏、行距/图标与 Electron 一致；卡片圆角 12；行标题 14/20。
- 偏好设置按 语言 / 外观 / 运行时 / 对话 分组，补齐 AI 偏好语言、系统通知、工具搜索、折叠思考内容；自动归档挪到「归档对话」页并改为天数选单（永不/7/14/30/90/180/365）。
- 快捷键页改为 Electron 的分组卡片行（发送/通用/对话/视图），文案与说明按 Electron；导入页按来源分行（品牌图标、会话数、最近日期）+ 勾选导入；网络代理改为 开关 → 协议/主机/端口 → 应用；浏览器设置改为行式。
- 会话模型选择器、供应商行字号；回复下方「用时」与「从此处分叉」文案；推荐回复的 Tab 键帽。
- 工具折叠行：文件名是下划线路径链接（查询仍是 chip），折叠箭头紧跟文字；折叠思考内容打开时已写完的思考并入批次并计为「思考 N 次」。
- 系统通知（`notify.rs`，`NSUserNotification`）：窗口失焦时任务完成/出错提醒；会话在等回答且不在屏幕上时提醒。
- 使用统计、子 Agent、长期记忆、MCP（表单改为对话框）、技能、关于、个性化、定时任务、⌘K 面板、`/` 与 `@` 菜单、项目对话框、队列/目标托盘、右侧面板逐一按 Electron 重排（详见各文件）。

**仍不同的（功能缺口，不是样式）**：插件页（原生无 pi 扩展）、电脑操控的后台投递/剪贴板开关、浏览器的系统浏览器与 Cookie 导入、按项目默认模型、CC Switch 导入、远程访问与 SSH 页（按计划后置）。（内置子 Agent 角色已在第五十九批、队列拖动排序/编辑已在第六十批补齐。）

## 第五十九批：照 codex 的方式内置子 Agent 角色

此前 explorer / worker 是 `defaults()` 写进 `subagent_roles_v1` 的种子数据——落库、可编辑可删除，和用户自建角色混在一起；删掉之后 `spawn_agent` 就不再有这两个角色。这批改为 codex `core/src/agent/role.rs`（`mod built_in`）的模型：**内置角色编译进二进制，永不落库、不可编辑删除**。

- `fv-server/src/subagents/roles.rs::built_ins()`：静态定义 explorer（只读）与 worker，随 `spawn_agent` 的描述与 enum 一并提供，`description` 采用 codex 的使用指引（并行多个 explorer、信任其结果、复用已有实例；worker 明确文件所有权、告知共享工作区、不回退他人改动）。用户角色仍存数据库，最多 32 个。
- **同名覆盖语义**（codex 的 `resolve_role_config`：用户配置优先，内置补位）：`merged()` 先列用户角色，再补未被覆盖的内置角色；保存一个同 id 的自定义角色即覆盖内置（`upsert` 强制把客户端送来的 `builtin` 标志清掉——只有编译进二进制的定义才叫内置），删掉覆盖后内置回来。老版本种进库里的 explorer/worker 副本与内置逐字段相同，`merged()` 视其为内置本身，不会列出第二行可删的重复。
- `for_spawn()` 改经 `merged()` 解析：未保存任何角色时 `agent_type: "explorer"/"worker"` 直接可用；`"default"` 仍是通用子会话。
- 协议 `SubagentRole` 增加 `builtin`（serde 默认 false，旧载荷可读），`native/schema/protocol.json` 已重新生成。快照随子会话持久化的 `role` 字段带该标志，仅用于展示。
- 设置页：内置角色行显示「内置」徽标，模型/思考一栏为纯文本，不提供编辑与删除；自定义角色的编辑、CAS 保存、删除与只读约束不变。截图夹具增加一个内置行供目检。
- codex 里没有 planner/reviewer 内置角色（review 是独立任务类型、plan 是模式），故不添加；`awaiter` 在 codex 侧已被临时移除，不引入。

验证：`fv-server --lib` 126 项通过（新增 2 项：内置不落库且删除无操作后仍在、同名覆盖与删除后恢复、`spawn_agent` 描述含内置角色）；`fv-protocol` 24 项与 schema 快照通过；`fv-server`/`fv-protocol` all-targets 严格 Clippy 通过。`fv-gui` 编译通过、`FV_FIXTURE_SAMPLE=1 --settings subagents --screenshot` 目检内置行（同轮另一会话在并行修改 queue/resources/web_content，那三个文件的失败用例与本批无关；`fv-gui` 的严格 Clippy 因其 `fv-daemon` 在途改动暂无法完整跑通）。全程未使用 computer use，无真实模型请求。

## 第六十批：队列的拖动排序与就地编辑

队列条此前只有「立即」和「×」：顺序只能在打字时决定，写错的一条只能删掉重打——而重打会把它挪到队尾，丢掉用户排好的顺序。

- 协议新增 `turn/queue/reorder { threadId, itemIds }` 与 `turn/queue/edit { threadId, itemId, text }`，`native/schema/protocol.json` 已重新生成；两者都进远程策略的允许集（与 `turn/queue/remove` 同一理由）。
- 排序提交**整份顺序**：拖动产出的本来就是整份，而整份让过期的客户端无害（不在队列里的 id 跳过，没点名的 id 留在原处）。`fv-store` 的 `reorder_queue` 在一个事务里重写全部 `position`；正在发送的那条（`preferred`）不参与。数据库先写、再改内存。
- 编辑保持 id 与位置；空文本与「已在发送」都被拒绝。`fv-store` 的 `edit_queued` 只改 `text`，行不在队列里时返回 `false`，不会把已经发出去的提示词变回来。
- GUI：队列行左侧抓手可拖动，落点用 2px 插入线画在目标行上缘/下缘（沿用侧栏 `sidebar_state::reordered` 的规则）；行内新增「编辑」铅笔，把该行换成输入框——Enter 保存、失焦保存、Esc 取消、空文本取消，编辑中的行不参与拖动，切换会话结束编辑。编辑不借用 composer：那里是写下一条消息的地方，借它会丢掉正在打的草稿。
- 队列推送（`thread/queue/changed`）若发现被编辑/被拖动的行已经不在了，两个状态都直接结束，而不是改指向顶替它位置的另一条。
- 预览：`--fixture queue-editing`（第一行处于编辑态）。

验证：`fv-server --test queue` 14 项（新增 2 项：拖动后的顺序既被推给客户端、也落在库里，并按新顺序发送；编辑保持位置并发送新文案，空文本被拒）、`fv-store --test store` 21 项（新增 2 项：整份排序保留未点名的行、编辑保持 id 与位置）、`fv-gui --lib` 新增 2 项拖动算术单测；`fv-protocol` schema 快照通过；相关 crate all-targets Clippy 与 `cargo fmt` 通过。`fv-gui` 的 `i18n_keys`/`locale_file_tests` 仍因并行在途的 `resources.*` 文案缺键而失败（与本批无关）。截图 `--fixture queue-editing` 目检了编辑态与插入线所在的行高。全程未使用 computer use，无真实模型请求。

## 第六十批：子 Agent 生命周期照 codex MultiAgentV2 重做

按用户要求「完全参考 codex 实现」，模型侧的子 Agent 工具面从 v1 形态（spawn/send_input/wait/close/resume）整体替换为 codex `core/src/tools/handlers/multi_agents_v2` 的 durable-agent 形态。依据 `/tmp/codex-src`（`23934d3`）的 `multi_agents_v2/*`、`agent_path.rs`、`completion.rs`、`residency.rs` 取证。

**工具面**（`fv-server/src/subagents.rs`，注册于每轮工具表）：
- `spawn_agent`：必填 `task_name`（小写字母/数字/下划线，codex 的 `validate_agent_name` 规则），返回**规范任务路径**（`/root/<name>/…`）而非 agent id。`fork_turns: "none"|"all"` 取代 `fork_context`；**默认仍是 `none`**（FastVibe 的委派一直是新上下文起步，codex 默认 `all` 是一处记录在案的分歧）。子会话的开场消息前缀 `You are the agent "<path>"`（codex：「The new agent's canonical task name will be provided to it along with the message」）。路径名在树内唯一，重名拒绝。
- `followup_task`：对已有 agent 下新任务——运行中的投递到下一个消息边界（steer），空闲/已结束的开新回合（复用全部历史，鼓励复用而非重开）。GUI 关闭的 agent 拒绝并提示去任务栏重开。
- `send_message`：queue-only——运行中投递到消息边界，空闲只入队不启回合。
- `interrupt_agent`：中断当前回合并返回先前状态；agent 保持可用。有界等待旧回合收尾，使紧随的 followup 不会 steer 进垂死回合。
- `wait_agent`：v2 形态——**无 targets**，等树内任一 agent 的终态/未投递答复/等人作答，返回「谁更新了」不返回内容（codex：「Does not return the content」）。
- `list_agents`：可选 `path_prefix`，列出整棵树（用户关闭的除外），行返回 `{agent_name, agent_status}`。
- **模型侧没有 close/resume 工具**（codex v2 也没有）：容量改为只数**正在运行**的 agent（codex 数常驻、靠逐出；原生运行时不逐出，改数活跃回合，终态 agent 持久存活、100 条上限不变）。用户侧 `subagent/close` / `subagent/resume` JSON-RPC 保留给任务栏。

**寻址**（`subagents/agent_path.rs`，逐条测试）：目标是 agent id 或路径——相对引用接在调用者自己的路径上（只能向下，`..`/`.` 保留），绝对引用必须 `/root` 开头；同树解析，`resolve` 对应 codex 的 `resolve_agent_target`。

**完成通知**（`settled()`，对应 codex 的 `notify_parent_of_terminal_turn`）：子会话到达 Completed/Failed 时，向父线程投递 `Message Type: FINAL_ANSWER\nTask name: …\nSender: …\nPayload: …` 格式的消息（Failed 写 `Agent errored: …`，Interrupted 不发）。父线程运行中 → steer 进当前回合的下一个请求；空闲 → 入队（复用 async_ask 的投递形态，答复随下一回合交给模型）。投递记入 `state.subagent_delivered`，`wait_agent` 用它区分「已投递」与「未投递的终态」，避免父回合中途完成的孩子被整段超时藏住。

**存储/协议**：`Subagent` 增加 `task_name`（serde 默认，旧行按 id 寻址）；schema 已重新生成。启动恢复（重启标记 Interrupted、send 续跑、角色快照）语义不变。

**测试**：单元 29 项（新增：路径寻址/重名拒绝、wait 按名字报告且不含内容、FINAL_ANSWER 入队、send_message 不启回合、list 前缀过滤、interrupt+followup 收尾后再开新回合）；集成 `subagents`/`context_fork`/`code_mode`/`tools` 全部改到 v2 形态并通过；`fv-server --lib` 135 项通过。`tools.rs` 的注册清单、GUI `presentation.rs` 的工具家族归类同步更新；`NOTICE.md` 改记 MultiAgentV2 依据。

**与 codex 的已知分歧（有意保留）**：① `fork_turns` 默认 `none`（codex `all`）；② 完成通知对空闲父线程入队并在其下一回合交给模型（codex 默认 WakeOnAgentMessages 关闭，通知停在 mailbox）；③ 容量按「运行中」计数而非 codex 的常驻+逐出（原生无运行时逐出）；④ `send_message` 对空闲 agent 入队后，该队列会在下一次回合结束时被 drain（codex 的 queue-only 消息只在下个回合开始时被读取）——语义上等价，时机略早。全程未使用 computer use，无真实付费请求。

## 第六十一批：四处分歧全部对齐 codex

第六十批记录的四处分歧，按用户要求「改成和 codex 一样」全部对齐：

1. **`fork_turns` 默认 `all`**。不写 `fork_turns` 的 spawn 继承父会话全部保留上下文——codex 的默认；`"none"` 才是全新上下文。工具描述改为 codex 的措辞（`none` 可能让孩子缺上下文，`all` 带全部）。解析规则钉在 `fork_turns_follows_the_codex_default_of_all` 用例里。
2. **空闲父线程的 FINAL_ANSWER 不再入提示队列、不再唤醒**。新增 `ServerState.agent_mailbox`：子会话完成时若父线程空闲，通知进 mailbox 等待；`spawn_turn_inner`（所有回合启动的唯一漏斗）在回合开始时把 mailbox 内容作为 steer 推入——循环顶部的 drain 把每条都落成独立的用户消息，与该回合自己的提示进**同一个**请求。运行中的父线程仍是 steer（消息边界投递）。这正是 codex 的 mailbox + `WakeOnAgentMessages` 默认关闭 + `DeferMailboxPreemption`（「Pending mail is delivered at the next normal input boundary instead」）的组合；也不再把 agent 间通知混进用户可见的提示队列。
3. **容量改按常驻（已加载运行时）计数 + 逐出**。`room()` 数树内加载了运行时的 agent；满了就按 `updated_at` 最旧的**已收尾** agent（非 Running、无后台命令、无等人作答）逐出——只从运行时表里移除（`evict_runtime`），行、转写、排队提示都在磁盘上，下次 `runtime()` 按需重建（队列出 `queue::restore` 复原）。对应 codex `residency.rs` 的 `reserve_v2_residency_slot`（满了逐出最旧的空闲 resident）。agent 持久存活，只有常驻有界。
4. **`send_message` 对空闲 agent 进 mailbox**，不再走提示队列——下个输入边界被读取，永不自成回合（codex queue-only 原义）。运行中仍 steer（「delivered promptly」）。

**验证**：`fv-server` 全部 48 个测试目标通过（lib 137 项，新增：fork 默认解析、逐出释放名额后 followup 仍可重建运行时、FINAL_ANSWER 只进 mailbox 不进队列且随下一回合同请求交付、send_message 邮箱化并在 followup 的首个请求里出现）；`fv-protocol`/`fv-store` 与 schema 快照通过；`fv-server/fv-protocol/fv-store` all-targets 严格 Clippy 与格式检查通过；`fv-gui` 编译通过（116 项通过，唯一失败仍是并行会话的 `resources.finished` 键）。集成测试的子会话转写现在带 fork 前缀（断言改为扫全部回合）。全程未使用 computer use，无真实付费请求。


## macOS arm64 测试包与独立更新（2026-10-30）

- `native-bundles.yml` 只覆盖 Apple Silicon，先跑 workspace 测试、格式与 clippy，再打包并验证；手动触发只产出 CI artifact，只有 `native-v<workspace version>` 标签才公开预发布版本。
- native 版本独立取自 `native/Cargo.toml`。预发布保持 `prerelease=true` / `make_latest=false`，无 Electron `latest*.yml`，不会进入 Electron 正式更新通道。
- `.app` 使用独立的应用名与 bundle ID；标准 Resources 目录保存清单、技能、OfficeCLI 和许可，严格 ad-hoc 签名校验通过，OfficeCLI 的上游固定哈希保持有效。
- 关于页支持检查 native 版本、下载并验证 GitHub SHA256、解压后校验身份/版本/架构，以及退出后替换应用并重启；临时夹具覆盖替换失败回滚。后台服务从启动到监听复用同一组退出信号，修复立即重启时丢信号的竞态。
- 本地验证：Node 全量 1,995 项通过；native workspace 828 项通过、2 个子进程夹具按原设计忽略，文档测试完成；发布/打包定向测试 14 项通过；workspace clippy、格式、actionlint 和 diff 检查通过。
- 实际 release 包通过二进制版本/arm64 架构检查、严格签名、39 项资源哈希、更新器归档验证和隔离数据目录下的服务协议冒烟测试（initialize / thread/list）。本地命令为 `pnpm native:dist:mac`。
- 本节为最初本地 ad-hoc 包的验证记录，真实签名/公证 CI 验收见末节。全程未使用 Computer Use，未启动 GUI；首次 GUI 启动和公开两个 native 预发布版本后的「设置 → 关于 → 下载更新 → 重启并更新」仍需人工验收。


## native CI 的 Developer ID 签名与公证（2026-10-30）

- 复用已有五项 Apple secrets 和个人 Developer ID（与 Electron 发版相同）。可信 push 默认要求完整签名公证；PR 无私钥，手动 dispatch 默认公证、可显式关闭。只有 push native tag 才公开 Release，手动选择 tag 不会发布。
- native app 和 server 使用 Hardened Runtime、可信时间戳和明确签名身份；OfficeCLI 保留既有上游 Developer ID 签名、entitlements 与固定 SHA256，无需改写运行时资源验证。
- 公证必须返回 Accepted，并保存提交状态与 Apple 日志；随后 staple / validate app、严格签名和 Gatekeeper 检查，重新生成 zip，再验证更新器归档并计算 SHA256。
- 临时 P8 / P12 使用私有权限；always 步骤清理证书/私钥/钥匙串并恢复搜索列表，失败时保留公证诊断 artifact。
- 已用本机个人 Developer ID 实际签名 arm64 包，验证 app/server 的 runtime、时间戳和证书身份，严格签名、39 项资源哈希、更新器归档和包内 server 协议冒烟均通过。21 项定向测试（含公证拒绝/失败、票据/Gatekeeper 拒绝和密钥清理夹具）、actionlint、脚本语法和 diff 检查通过。
- 上述为接入 CI 时的本地验证记录；后续真实 CI 与下载包复核已通过，详见末节。全程未启动 GUI，尚未公开 Release。


## native 签名、公证 CI 实际验收（2026-10-30）

代码提交 `84cb8d1b86b717959ee6728eee15ffd66c8c4b26` 已推送 `gpui`，
[Native macOS preview #41032307475](https://github.com/tyuan511/fastvibe/actions/runs/41032307475)
完整通过，未创建发布标签或公开 Release。

- 云端 21 项发布/签名定向测试、828 项 Rust 测试、格式与 Clippy 全部通过；2 个子进程夹具按原设计忽略。
- arm64 release 二进制构建、证书导入、Developer ID + Hardened Runtime + 可信时间戳签名通过。
- Apple 公证提交 `e45d0ad0-ff33-4f1e-9798-2e4368fcc0af` 返回 `Accepted`、`Ready for distribution`，`statusCode: 0`、`issues: null`。
- `.app` staple / validate、严格签名、Gatekeeper、更新器归档、包内 server 的 initialize / thread/list、产物上传以及临时凭据清理均成功。发布 job 按分支运行规则跳过。
- 已取回 CI zip 并在本机重新验证 SHA256、严格签名、stapler、39 项资源哈希；Gatekeeper 返回 `accepted`、`source=Notarized Developer ID`。没有启动 GUI 或使用 Computer Use。
- CI artifact 为 `fastvibe-native-mac-arm64`；文件 `FastVibe-Native-0.1.0-mac-arm64.zip`，SHA256 为 `163b5d9cf4cb5474b03dacb3683a3c334d12d07e3b1d2ae99433c246d0d6845e`。Apple 原始状态与日志保存在同一 run 的 `fastvibe-native-notarization-mac-arm64` artifact。

首次 GUI 启动、真实线上跨版本升级和其它平台仍保留为后续验收，不将本轮静态/协议验证描述成 GUI 交互验收。
