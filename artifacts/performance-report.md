# FastVibe 性能评估报告

评估日期：2026-10-31

## 测量方式

统一 runner 是 [bench-performance.mjs](../scripts/bench-performance.mjs)，每个场景记录 wall time、CPU time、heap 增量、RSS 增量和 event-loop delay，并写入 Node、机器、Git commit、分支和工作树状态。报告支持通过 [compare-performance.mjs](../scripts/compare-performance.mjs) 做历史对比和阈值门禁。

最终报告使用两种模式：

- no-GC 模式与原始基线保持同一运行方式，用于 wall/CPU 回归门禁；
- `node --expose-gc` 模式单独记录 heap/RSS 趋势，避免把主动 GC 成本混入 CPU 基线。

覆盖的场景包括：

- EventBus 单 scope、512 scope 热 scope、4KB payload；
- 32 个文件逐个加入 checkpoint；
- 500 turn JSONL parse 和 TranscriptReader cold open；
- TranscriptReader append-only offset 读取与冷重解析对照；
- 300 turn transcript projection；
- renderer rows/turns/index 全量与 settled-prefix 增量对照；
- Markdown block 增量场景；
- ToolDelta latest-only queue；
- Shiki ordered queue 与 latest-only queue；
- Electron utility process 的 Main scan、utility scan 和跨进程对象 clone 对照。

## 原始基线与最终版本

下面的前后表使用 no-GC 模式的最终报告 [perf-after-all-nogc.json](./perf-after-all-nogc.json) 与原始基线 [perf-before.json](./perf-before.json)。

| 场景 | 改造前 wall | 改造后 wall | wall 变化 | 改造前 CPU | 改造后 CPU |
|---|---:|---:|---:|---:|---:|
| EventBus，单 scope，10k 事件 | 62.14ms | 14.54ms | **-76.6%** | 56.62ms | 15.66ms |
| EventBus，512 scope + 热 scope，10k 事件 | 203.12ms | 14.51ms | **-92.9%** | 204.02ms | 15.01ms |
| EventBus，4KB payload，5k 事件 | 28.23ms | 16.96ms | **-39.9%** | 33.72ms | 18.50ms |
| Checkpoint，32 个文件逐个捕获 | 5,524.10ms | 1.74ms | **-100.0%** | 701.64ms | 2.20ms |
| 500 turn JSONL parse | 0.71ms | 0.63ms | **-11.8%** | 1.41ms | 0.68ms |

最终门禁通过，没有达到默认 20% wall 或 25% CPU 回归阈值的场景。完整门禁结果见 [perf-comparison-final.md](./perf-comparison-final.md)，结构化结果见 [perf-comparison-final.json](./perf-comparison-final.json)。

## 新增场景结果

这些场景没有旧版本数据，因此报告同时提供了同一版本内部的对照：

| 场景 | 对照 | wall 结果 | CPU 结果 | 说明 |
|---|---|---:|---:|---|
| Transcript cold open，500 turn | 单次打开 | 1.26ms | 2.16ms | 小文件快速路径 |
| Transcript append，32 entries | offset 增量 | 1.66ms | 1.95ms | 相对冷重解析 2.24ms，RSS 约少 0.6MB |
| Transcript projection，300 turn | 单次 projection | 0.60ms | 1.65ms | 当前纯 projection 基准 |
| Renderer rows，300 turn × 120 flush | 全量 | 8.69ms | 8.94ms | 参考实现 |
| Renderer rows，300 turn × 120 flush | 增量 tail | **0.65ms** | 2.09ms | wall 约下降 92.5% |
| Shiki，64 个连续 snapshot | ordered | 36.54ms | 73.72ms | 所有旧 snapshot 都处理 |
| Shiki，64 个连续 snapshot | latest-only | **32.89ms** | 59.47ms | CPU 约下降 19.3%，RSS 也下降 |

完整扩展报告见 [perf-after-all-nogc.json](./perf-after-all-nogc.json)；主动 GC 内存报告见 [perf-after-all.json](./perf-after-all.json)。

## Utility process 实验

[bench-transcript-utility.mjs](../scripts/bench-transcript-utility.mjs) 处理约 2.25MB、10,000 行 JSONL：

| 场景 | wall | Main CPU | 说明 |
|---|---:|---:|---|
| Main JSONL scan | 4.07ms | 4.54ms | 同进程读取和解析 |
| utility JSONL scan | 5.35ms | 0.08ms | 解析工作移出 Main，结果只返回统计 |
| utility parse + object clone | 10.81ms | 3.23ms | 返回完整对象，包含跨进程 clone 成本 |

utility process 目前默认关闭，入口是独立的 [transcript-utility.ts](../src/main/utility/transcript-utility.ts)，RPC client 是 [transcript-utility.ts](../src/main/engine/transcript-utility.ts)，构建入口在 [electron.vite.config.ts](../electron.vite.config.ts:50)。它没有接入 AppServer、remote call table 或默认 TranscriptReader 路径，避免把实验性跨进程 clone 成本带入正常会话；[bench-transcript-utility.mjs](../scripts/bench-transcript-utility.mjs) 直接使用同一 utility entry 做对照。后续如果真实长转写 profile 证明 Main event-loop stall 是主要问题，再把 client 接到 main-only 的实验入口，而不是 headless agent 共享路径。

## 已实施改动

- [checkpoint.ts](../src/main/engine/checkpoint.ts) 在同一轮文件列表保持稳定前缀时只写新增 file rows，并缓存 Git repo 根目录。
- [process-manager.ts](../src/main/pi/process-manager.ts) 用消息对象到 entryId 的 WeakMap，替代 message end 时复制、reverse、扫描完整 entries。
- [event-bus.ts](../src/main/app-server/event-bus.ts) 复用 retention 中已经 clone 的 canonical payload，高频 publish 只清理当前 scope。
- [client-session.ts](../src/main/app-server/client-session.ts) 缓存事件 UTF-8 batch 字节数。
- [transcript-reader.ts](../src/main/engine/transcript-reader.ts) 对大文件使用流式 JSONL reader；append-only 文件按 byte offset 只解析新增尾部，并保留原始 entries 以正确维持 session header 语义。
- [group-parts.tsx](../src/renderer/src/lib/group-parts.tsx) 增加 settled-prefix/streaming-tail 的 rows、turns 和 index 增量 projection；compact divider 和 singleton row 用 WeakMap 复用。
- [message-list.tsx](../src/renderer/src/components/chat/message-list.tsx) 移除每次 flush 的全量 rows/turns/index 重建，TurnRail markers 也只重算受影响尾部。
- [apply-engine-event.ts](../src/renderer/src/lib/apply-engine-event.ts) 空 streamed/toolcall delta 不再无条件 clone trailing assistant。
- [syntax-highlighter.ts](../src/renderer/src/lib/syntax-highlighter.ts) 增加 `highlightLatest`；live code 使用 latest-only 队列，普通 `highlight` 仍保留有序语义。
- [test/transcript-projection.test.ts](../test/transcript-projection.test.ts) 覆盖 300 turn streaming tail、追加 turn、中段替换、compact split 和 stale index。
- [test/syntax-highlighter.test.ts](../test/syntax-highlighter.test.ts) 增加 latest-only queue 回归。

## 可持续追踪方式

每次性能改动后运行：

```bash
node scripts/bench-performance.mjs \
  --label=<label> \
  --json=artifacts/perf-<label>.json \
  --history=artifacts/perf-history.jsonl

node scripts/compare-performance.mjs \
  --before=artifacts/perf-before.json \
  --after=artifacts/perf-<label>.json \
  --json=artifacts/perf-comparison-<label>.json \
  --markdown=artifacts/perf-comparison-<label>.md \
  --history=artifacts/perf-comparison-history.jsonl
```

默认门槛是 wall +20%、CPU +25%、event-loop +20%；heap 和 RSS 会始终记录，只有两份报告都启用 `--expose-gc` 或显式传入 `--check-memory` 时才参与失败门禁。历史 JSONL 会保留每次运行的 metadata 和场景结果，便于按 commit、机器和 Node 版本追踪趋势。

## 验证结果

- `pnpm --version`：11.22.0；[全局 pnpm launcher](/Users/yuantang/Library/pnpm/bin/pnpm:39) 已连接到稳定的 Corepack pnpm。
- `pnpm typecheck`：通过。
- `pnpm build`：通过；Electron main、utility、preload、renderer 均构建成功。
- `pnpm test`：**2,044 个测试全部通过**。
- 性能改造聚焦回归：59 个测试全部通过。
- utility process 实际 Electron 对照基准成功运行。

原始文件包括 [perf-before.json](./perf-before.json)、[perf-after-all-nogc.json](./perf-after-all-nogc.json)、[perf-after-all.json](./perf-after-all.json)、[perf-utility.json](./perf-utility.json)、[perf-history.jsonl](./perf-history.jsonl) 和 [perf-comparison-history.jsonl](./perf-comparison-history.jsonl)。
