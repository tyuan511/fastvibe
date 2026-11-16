# FastVibe GPUI

FastVibe 正在重写为原生 GPUI 桌面客户端。新版桌面壳和可复用运行时都位于
`crates/` 下的 Rust 工作区。

## 工作区

- `crates/fastvibe-app`：GPUI 桌面应用和界面壳。
- `crates/fastvibe-core`：项目、会话、转写、Harness 和模型选择等共享逻辑。

## 开发

```bash
cargo dev
cargo check -p fastvibe-app
cargo test -p fastvibe-core
```

可选的 GPUI 加速后端：

```bash
cargo check -p fastvibe-app --features gpui-fast
```

开发环境数据库默认写入 `~/.fastvibe-app/fastvibe.db`，也可以通过
`FASTVIBE_DATA_DIR` 指定数据目录。
