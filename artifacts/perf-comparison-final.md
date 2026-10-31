# FastVibe 性能前后对比

基线：/Users/yuantang/code/fastvibe/artifacts/perf-before.json
改造：/Users/yuantang/code/fastvibe/artifacts/perf-after-all-nogc.json
阈值检查：通过

| 场景 | wall 前 | wall 后 | wall 变化 | CPU 前 | CPU 后 | heap Δ 前 | heap Δ 后 | RSS Δ 前 | RSS Δ 后 | event-loop 前 | event-loop 后 | 状态 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| eventbus-single-scope-10k | 62.14 | 14.54 | -76.61% | 56.62 | 15.66 | 3454328.00 B | -10809992.00 B | 163840.00 B | 4751360.00 B | — | 14.57 ms | 通过 |
| eventbus-512-scopes-hot-10k | 203.12 | 14.51 | -92.86% | 204.02 | 15.01 | 13224296.00 B | 17614560.00 B | -49152.00 B | 425984.00 B | — | 14.55 ms | 通过 |
| eventbus-4kb-payload-5k | 28.23 | 16.96 | -39.94% | 33.72 | 18.50 | 13520320.00 B | -7421464.00 B | 0.00 B | 163840.00 B | — | 16.98 ms | 通过 |
| checkpoint-capture-32-incremental | 5524.10 | 1.74 | -99.97% | 701.64 | 2.20 | 11280856.00 B | 722112.00 B | 81920.00 B | 16384.00 B | — | 1.71 ms | 通过 |
| transcript-jsonl-500-turns | 0.71 | 0.63 | -11.85% | 1.41 | 0.68 | 450824.00 B | 428376.00 B | 0.00 B | 0.00 B | — | 1.79 ms | 通过 |
| transcript-jsonl-500-turns-open | — | 1.26 | — | — | 2.16 | — | 1293200.00 B | — | 606208.00 B | — | 0.83 ms | 新增 |
| transcript-reader-append-incremental-32 | — | 1.66 | — | — | 1.95 | — | 2060344.00 B | — | 655360.00 B | — | 0.85 ms | 新增 |
| transcript-reader-append-cold-reparse-32 | — | 2.24 | — | — | 2.29 | — | 2673224.00 B | — | 1245184.00 B | — | 0.89 ms | 新增 |
| transcript-projection-300-turns | — | 0.60 | — | — | 1.65 | — | 1124600.00 B | — | 1048576.00 B | — | 1.56 ms | 新增 |
| renderer-rows-full-300-turns-120 | — | 8.69 | — | — | 8.94 | — | -15071464.00 B | — | 442368.00 B | — | 8.73 ms | 新增 |
| renderer-rows-incremental-300-turns-120 | — | 0.65 | — | — | 2.09 | — | 7021232.00 B | — | 32768.00 B | — | 0.86 ms | 新增 |
| renderer-markdown-blocks-incremental-120 | — | 2.56 | — | — | 3.95 | — | 8764200.00 B | — | 16384.00 B | — | 2.58 ms | 新增 |
| latest-only-tool-delta-5k | — | 5.27 | — | — | 15.17 | — | 7781128.00 B | — | 376832.00 B | — | 5.31 ms | 新增 |
| markdown-shiki-stream-queue-64 | — | 36.54 | — | — | 73.72 | — | 10092152.00 B | — | 8404992.00 B | — | 36.57 ms | 新增 |
| markdown-shiki-latest-only-64 | — | 32.89 | — | — | 59.47 | — | 10031520.00 B | — | 7454720.00 B | — | 32.92 ms | 新增 |

回归阈值（相对变化）：wall 20%，CPU 25%，heap 50%，RSS 100%，event-loop 20%。
负变化表示耗时或资源下降；RSS/heap 受 Node 分配器和运行顺序影响，应在同一机器上比较。

