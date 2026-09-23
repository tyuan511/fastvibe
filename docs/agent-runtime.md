# Agent runtime 发布与版本

Agent runtime 和桌面端是两条独立的发布线。

- 桌面端版本仍然使用 `v0.11.0` 这样的桌面版本。
- runtime 使用可读的独立版本，例如 `agent-runtime-v12`。
- 每个目标架构的包在 `manifest.json` 中包含完整的 `runtimeHash`（SHA-256）。hash 是内容指纹，不直接显示给用户。

## 去重规则

CI 先分别构建 `linux-x64` 和 `linux-arm64`，计算解包后 runtime 内容的 hash。hash 计算忽略文件修改时间、tar/gzip 元数据、pnpm 的安装索引、`manifest.json` 本身以及桌面入口未使用的构建文件，并包含目标架构与 Node fallback 的 major/minor 版本线（Node patch 更新不会制造新的 runtime release）。

随后将两个 hash 与最新的 `agent-runtime-vN` release 的 `agent-runtime.json` 比较：

- 两个架构都未变化：复用最新 runtime release，不发布新的 runtime 包；
- 任一架构变化：创建下一个可读版本（例如 `agent-runtime-v13`），并发布两个架构的包。

桌面包内只携带最终的 `agent-runtime.json`。远端 URL、远端安装目录和本地缓存都使用 runtime release id，而不是桌面版本。部署时仍会校验 manifest 的完整 hash 和目标架构，因此可读版本不会降低内容校验强度。

旧桌面版本仍然通过原来的桌面 release URL 工作；新桌面第一次连接旧 Agent 时，会把它升级到新的独立 runtime release。
