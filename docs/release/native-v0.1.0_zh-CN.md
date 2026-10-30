[English](https://github.com/tyuan511/fastvibe/blob/native-v0.1.0/docs/release/native-v0.1.0.md) | **简体中文**

## 原生 macOS 测试版

- 首个独立的 Rust / GPUI 测试包，支持 macOS 14 及以上的 Apple Silicon Mac。
- 应用名为 **FastVibe Native**，可与 Electron 版并存，数据保存在独立的 `FastVibeNative` 目录。不会自动导入现有 Electron 数据。
- 包含原生智能体服务、内置技能和固定版本的 OfficeCLI 资源。
- 在**设置 → 关于**中检查原生测试版更新，下载并校验后重启安装。原生测试版使用独立更新通道，Electron 用户不会收到升级到测试版的提示。

## 测试版限制

- 发布包使用 Developer ID 签名并经过 Apple 公证。请将解压后的应用移至「应用程序」。PR 产物及手动关闭公证的构建使用 ad-hoc 签名；首次运行如被拦截，需在 macOS 安全设置中手动允许。
- 本次不提供 Windows、Linux 和 Intel Mac 包。
- 远程访问、手机适配及完整 Electron 数据迁移仍在进行中。此测试版不会替代 Electron 正式版。

**Full Changelog**: https://github.com/tyuan511/fastvibe/commits/native-v0.1.0
