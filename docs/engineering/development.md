# 开发、依赖、发布与验证资料

涉及文档维护、常用脚本、依赖变体、安装包完整性、发布说明和测试边界时阅读。

关联入口：[发布记录规范](../release/README.md)、[发布技能](../../.agents/skills/release/SKILL.md)、[文档总索引](../README.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## 项目文档

文档入口是 [docs/README.md](../README.md)。Vivi 当前架构、运行合同与限制统一维护在
[docs/vivi-bot-implementation.md](../vivi-bot-implementation.md)，类型以 `src/shared/bot.ts` 为准；
DeepSeek 上游研究单独放在 [docs/dsh-superagent-architecture.md](../dsh-superagent-architecture.md)。
Vivi 的目标架构已确定为整体采用 DSH，完整设计与迁移要求见
[docs/vivi-dsh-architecture.md](../vivi-dsh-architecture.md)：GitHub Issue/PR 作为外部事件驱动 Vivi；
Issue → PR → Review → 修复 → CI → Merge 是首个验收场景，不以最小闭环为由省略核心领域、Effects/Outbox 或恢复机制。
该目标尚未实现，当前实现说明与目标设计须明确区分；不沿用已删除的旧审核技能流程。
已被替代的计划不作为当前需求或实现承诺；更新功能时同步现有说明，删除过时步骤与重复合同，保留研究基线和验证边界。
删除文档前提取仍有用的独有资料，并更新所有入口与脚本引用；发布记录和数据库迁移不随文档清理删除。

## Commands

```bash
pnpm sync:models    # rebuild the bundled models.dev index from upstream
pnpm dev            # sync models.dev if needed, then electron-vite
pnpm typecheck      # injected browser scripts, then both tsconfigs
pnpm test           # node's own runner over test/*.test.ts — pure modules only, no DOM
pnpm check:scripts  # only the browser page scripts (a compile error there is a
                    # `Script failed to execute` at tool-call time, not a build error)
pnpm shadcn add <component> -y

# README 首图（亮/暗斜线分割）：复用或自起 vite，需要 Chrome/Chromium 与 playwright
node scripts/capture-readme-hero.mjs

# SQLite 存储的演练与基线（都不碰正在运行的数据目录）
node scripts/drill-sqlite-import.mjs   # 复制真实 userData 到临时目录，跑一遍旧 JSON 导入并比对行数/往返
node scripts/bench-sqlite.mjs          # 检查点写入、目录 flush、启动打开 store 的耗时基线
node scripts/compare-storage-backends.mjs  # 同一份真实副本上跑「旧 store（HEAD 的真代码）vs 新 store」：耗时与每次动作落盘字节
node scripts/bench-session-open.mjs [轮数]  # 冷会话打开里「加载内置扩展」那一段：首次 vs 之后每次换 cwd 的重载（临时 agentDir，不碰真实数据）
```

## 依赖版本与安装包完整性

`undici` 和 `typebox` 在 `package.json` 里的版本**必须和 `pi-coding-agent` 自己声明的一致**
（现在是 `undici 8.10.2`、`typebox 1.3.27`；升级 pi 时一起改）。对不上时 pnpm 会把
`pi-ai` 等装成两个 peer 变体，electron-builder 的 pnpm 收集器认不出这种包，**构建不报错**，
却把它底下的依赖整片丢掉：v0.19.0 就是这样发出去的，缺 `cross-spawn`、`@anthropic-ai/sdk`
等 9 个包，启动即崩。对不上的 `typebox` 还会让每个 `pi-*` 各带一份，白白多 4 MB。

两道检查，都不需要人记得去跑：

- `scripts/check-pnpm-variants.mjs`（在 `pnpm typecheck` 里）：锁文件里 `pi-ai` / `pi-coding-agent` /
  `pi-mcp` / `pi-tui` 出现不止一个变体就失败，并列出区别。
- `scripts/check-packaged-deps.cjs`（`electron-builder.yml` 的 `afterPack`）：打出来的
  `app.asar` 里每个包声明的 `dependencies` 都得能按 Node 的规则找到，缺一个就让构建失败，
  这时还没有任何安装包或 Release。也可以对已安装的应用直接跑：
  `node scripts/check-packaged-deps.cjs /Applications/FastVibe.app/Contents/Resources/app.asar`。

升级依赖后要确认：`pnpm typecheck` 通过，并且本地 `electron-builder --dir` 的日志里没有
`cannot find path for dependency`。

## 发版与 release note

版本号写 `package.json`，英文 release note 写 `docs/release/<tag>.md`，简体中文译文写
`docs/release/<tag>_zh-CN.md`，三者在同一个 `chore: release vX.Y.Z` 提交里。两份顶部用
固定到本次 tag 的绝对 URL 双向切换语言；已发布版本补译时用 `blob/main`，不移动旧 tag。
推 `v*` tag
触发 `.github/workflows/release.yml`：每个 job 先跑 `scripts/check-release-note.mjs`
（检查文件是否存在、有内容；双语 note 还检查译文与双向链接，不判断正文语言），
打包产物上传进 draft Release，最后 `publish` job
合并 mac 清单并转正。**Release 的 body 就是那个 commit 上的英文 note 文件**
（`body_path`），不是 GitHub 自动生成的提交列表，也没有「事后 `gh release edit` 覆盖」
这个步骤。note 文件本身的约定见 `docs/release/README.md`，完整流程见
`.agents/skills/release/SKILL.md`。

**提交信息一律写英文**：`fix:` / `feat:` 这类前缀和 scope 照旧，subject 与正文也用英文。

## 主进程文案里不要出现独立的 `import`

`package.json` 是 `"type": "module"`，主进程产物是 ESM，于是 electron-vite 的
`vite:esm-shim` 会往 bundle 里补一段 `createRequire` 垫片 —— 插入位置由
**正则**（不是 AST）找出的「最后一条静态 import」决定。正则会把任意字符串字面量里
的独立单词 `import` 当成一条 import：一句 `"…compact after import"` 就让它把垫片
插进了 `parts.join("；")` 的引号中间，构建以毫无线索的
`[vite:esbuild-transpile] Unterminated string literal`（指向一个 `join("`）失败。
写主进程英文文案时避开这个词（用 `loading` / `found` 之类替代）。

## 测试

`pnpm test` —— Node 自带 runner 跑 `test/**/*.test.ts`，只测**纯模块**（无 DOM、不引 zustand/React）：
`lib/diff.ts` 的行号读取、`engine/pricing.ts` 的价格阶梯、`lib/todos.ts` 的 `n/N` 语义、
`engine/checkpoint.ts` 的捕获与还原、`engine/resume.ts` 的「能不能原地继续」、`engine/shell-locale.ts` 的
locale 选择（探测结果注入，不 spawn）。这一层抓的是运行时不变式——比如「一个未跟踪路径不能让
整批 `git checkout` 失败」、「`canResumeRun` 不能对 `continueTurn` 会拒绝的 transcript 说 true」
——typecheck 看不见它们。

## Product constraints

- Code / Office / Cowork are first-class; pi-coding-agent is the default backend.
- Office 已由 OfficeCLI 集成；其它 ACP agent 的 Host adapters (RPC/ACP) 仍应与 renderer 解耦。
- There is no built-in model provider. The user adds one (a pi built-in or any compatible endpoint, e.g. the FastVibe relay at `https://fastvibe.dev/v1`) by pasting an API key. In isolated mode FastVibe writes its own model configuration; in global mode it reads and updates the user's pi configuration. Do not mention the backend runtime in the UI.
