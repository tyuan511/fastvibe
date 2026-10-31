# FastVibe 性能前后对比

基线：/Users/yuantang/code/fastvibe/artifacts/perf-before.json
改造：/Users/yuantang/code/fastvibe/artifacts/perf-round2-final.json
阈值检查：通过

| 场景 | wall 前 | wall 后 | wall 变化 | p95 前 | p95 后 | CPU 前 | CPU 后 | heap Δ 前 | heap Δ 后 | RSS Δ 前 | RSS Δ 后 | event-loop 前 | event-loop 后 | 状态 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| eventbus-single-scope-10k | 62.14 | 14.07 | -77.35% | — | 20.31 | 56.62 | 15.19 | 3454328.00 B | -10538624.00 B | 163840.00 B | 4620288.00 B | — | 14.11 ms | 通过 |
| eventbus-512-scopes-hot-10k | 203.12 | 14.42 | -92.90% | — | 15.79 | 204.02 | 16.27 | 13224296.00 B | 17634208.00 B | -49152.00 B | 425984.00 B | — | 14.45 ms | 通过 |
| eventbus-4kb-payload-5k | 28.23 | 21.30 | -24.56% | — | 25.08 | 33.72 | 21.36 | 13520320.00 B | -7410232.00 B | 0.00 B | 163840.00 B | — | 21.34 ms | 通过 |
| checkpoint-capture-32-incremental | 5524.10 | 5.64 | -99.90% | — | 42.19 | 701.64 | 3.67 | 11280856.00 B | 729144.00 B | 81920.00 B | 16384.00 B | — | 2.15 ms | 通过 |
| transcript-jsonl-500-turns | 0.71 | 0.67 | -6.40% | — | 0.85 | 1.41 | 0.69 | 450824.00 B | 428432.00 B | 0.00 B | 0.00 B | — | 0.71 ms | 通过 |
| transcript-jsonl-500-turns-open | — | 1.86 | — | — | 2.70 | — | 2.55 | — | 1292208.00 B | — | 589824.00 B | — | 1.01 ms | 新增 |
| transcript-reader-append-incremental-32 | — | 6.73 | — | — | 13.95 | — | 6.73 | — | 2149688.00 B | — | 622592.00 B | — | 1.03 ms | 新增 |
| transcript-reader-append-cold-reparse-32 | — | 10.30 | — | — | 18.45 | — | 6.80 | — | 2687728.00 B | — | 655360.00 B | — | 0.85 ms | 新增 |
| transcript-projection-300-turns | — | 1.38 | — | — | 4.92 | — | 2.52 | — | 1171464.00 B | — | 933888.00 B | — | 1.82 ms | 新增 |
| transcript-large-4000-turns-cold-open | — | 20.41 | — | — | 26.83 | — | 27.22 | — | -9579224.00 B | — | 1884160.00 B | — | 0.77 ms | 新增 |
| transcript-large-4000-turns-first-page | — | 0.03 | — | — | 1.40 | — | 0.11 | — | 47992.00 B | — | 0.00 B | — | 1.21 ms | 新增 |
| renderer-rows-full-300-turns-120 | — | 10.19 | — | — | 15.89 | — | 10.75 | — | -13268288.00 B | — | 1540096.00 B | — | 10.26 ms | 新增 |
| renderer-rows-incremental-300-turns-120 | — | 0.69 | — | — | 1.48 | — | 1.48 | — | 7012896.00 B | — | 16384.00 B | — | 1.51 ms | 新增 |
| renderer-stream-apply-300-turns-60x100 | — | 1.60 | — | — | 5.41 | — | 2.13 | — | 32770800.00 B | — | 16384.00 B | — | 1.62 ms | 新增 |
| renderer-stream-apply-2000-turns-60x100 | — | 7.36 | — | — | 8.57 | — | 7.53 | — | -3771760.00 B | — | 294912.00 B | — | 7.39 ms | 新增 |
| renderer-streaming-row-merge-40-roundtrips-120 | — | 6.13 | — | — | 9.55 | — | 12.16 | — | 18549992.00 B | — | 180224.00 B | — | 7.01 ms | 新增 |
| renderer-streaming-row-merge-240-roundtrips-120 | — | 36.30 | — | — | 45.12 | — | 35.85 | — | -12348424.00 B | — | 1998848.00 B | — | 36.36 ms | 新增 |
| renderer-live-markdown-48kb-every-flush | — | 3478.71 | — | — | 4040.84 | — | 3871.09 | — | 44208032.00 B | — | 98811904.00 B | — | 3478.82 ms | 新增 |
| renderer-live-markdown-48kb-bounded | — | 889.72 | — | — | 930.18 | — | 957.32 | — | 30246520.00 B | — | 2195456.00 B | — | 890.11 ms | 新增 |
| renderer-markdown-blocks-incremental-120 | — | 2.50 | — | — | 3.17 | — | 3.96 | — | 8772576.00 B | — | 0.00 B | — | 2.75 ms | 新增 |
| latest-only-tool-delta-5k | — | 7.08 | — | — | 12.95 | — | 19.53 | — | 7634952.00 B | — | 196608.00 B | — | 7.14 ms | 新增 |
| markdown-shiki-stream-queue-64 | — | 42.49 | — | — | 119.17 | — | 81.28 | — | 10462680.00 B | — | 7421952.00 B | — | 42.51 ms | 新增 |
| markdown-shiki-latest-only-64 | — | 36.45 | — | — | 37.26 | — | 56.42 | — | 9787160.00 B | — | 7421952.00 B | — | 36.48 ms | 新增 |

回归阈值（相对变化）：wall 20%，CPU 25%，heap 50%，RSS 100%，event-loop 20%，p95 50%（双方样本 ≥ 10 才参与门禁）；绝对变化小于 5 ms / 1 MB 不计为回归。
负变化表示耗时或资源下降；RSS/heap 受 Node 分配器和运行顺序影响，应在同一机器上比较。

