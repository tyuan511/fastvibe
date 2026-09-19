---
name: release
description: 发布 FastVibe 新版本：按提交推断并写入 package.json 版本号、生成 release note、打 tag 推送触发远端 CI 打包、再把 release note 覆盖到 GitHub Release。用户说「发版 / 发布新版本 / 出个 release / cut a release」时使用。
---

# Release

一次发版 = 版本号 + release note + tag + 远端 CI + GitHub Release body。三步在本机
完成（版本号、note、tag），打包和创建 Release 都是 `.github/workflows/release.yml`
的活。

## 环境

FastVibe 的 agent shell 只有 `/usr/bin:/bin:...`，node / pnpm / gh 都不在 PATH 上，
而 bash 工具每次调用都是新 shell（`export` 不跨调用生效）。**每条命令都加这个前缀**：

```bash
. .agents/skills/release/scripts/env.sh
```

它把 `/opt/homebrew/bin` 和最新的 `n` 版本 node 拼进 PATH，缺工具时直接报错。

## 前置检查

```bash
git status --porcelain        # 必须为空：带着未提交改动发版会漏文件
git branch --show-current     # main
git fetch origin --tags --prune
git rev-list --left-right --count origin/main...HEAD   # 必须 0 0
pnpm typecheck
gh auth status                # 需要 repo scope
```

任何一项不过就先修，不要「发完再补」。本机**不跑** `pnpm dist`：打包交给 CI，
本地只保证 typecheck 通过。

## 步骤

### 1. 定版本号

```bash
node .agents/skills/release/scripts/bump-version.mjs --dry-run
```

无参数时按提交推断：`!` / `BREAKING CHANGE:` → major，`feat:` → minor，其余 →
patch；范围是上一个 `vX.Y.Z` tag 到 HEAD。stderr 打印
`当前 -> 新 (级别, 提交数)`，stdout 是新版本号。把推断结果给用户过一眼，再决定用
推断值还是指定 `patch|minor|major|0.2.0`。

### 2. 生成 release note 草稿并改写

```bash
node .agents/skills/release/scripts/release-notes.mjs --tag vX.Y.Z
```

stdout 是草稿：按 新增 / 修复 / 性能 / 重构 / 文档 / 构建与杂项 分组，破坏性变更单独
置顶，每条带提交链接和提交正文要点，末尾是 `**Full Changelog**` compare 链接。

**草稿不能直接发布。** 它是英文提交标题 + 提交正文原文，按下面改写成人话：

- 面向用户，不面向 commit：`stop the packaging globs from stripping nested runtime
  dirs` → 「修复打包后应用启动即崩溃：`yaml` 的 `dist/doc` 被排除规则一起删掉了」。
- 合并同一件事的多条提交；删掉纯内部改动（测试、CI 跑通、格式化）。`构建与杂项`
  通常整节删掉，只留用户能感知的（如「升级到 Electron 44」）。
- 中文书写，与 README 一致；术语（MCP / acp / pi extension）保留原文。
- 每条一到两句，说清「改了什么、用户能感觉到什么」，不要贴 diff 细节。
- **只写桌面端产品改动。** 以 Electron 应用及其运行时为范围（`src/main`、`src/preload`、
  `src/renderer`、`src/shared`、`resources/extensions`、桌面打包与更新）；官网、营销页、部署配置、
  截图素材及其专用脚本（例如 `apps/website/**`、网站构建命令）一律不进入 release note。
- README / 文档本身的改写不算发布内容；只有它描述了同一 tag 区间内真实交付的桌面功能时，
  才从对应代码改动提炼该功能，不能把「新增文档、官网或截图」写成一条更新。
- 一个提交同时包含桌面端与官网改动时必须查看 diff，只提炼桌面端部分，不能照抄提交标题或
  因为提交粒度较大而把网站改动带进来。若整个区间只有网站或文档改动，正文写明「本版本无桌面端功能变更」。
- 破坏性变更放最前并写清迁移动作；`Full Changelog` 那行保留不动。

改写结果存到仓库**外**，不要提交进仓库（release/ 是构建产物目录且被 gitignore）：

```bash
printf '%s\n' "<改写后的 note>" > "${TMPDIR:-/tmp}/fastvibe-release-vX.Y.Z.md"
```

把最终 note 念给用户确认——这一步之后就是不可逆的推送。

### 3. 写入版本号并提交

```bash
node .agents/skills/release/scripts/bump-version.mjs minor   # 或 patch/major/X.Y.Z
git add package.json
git commit -m "chore: release vX.Y.Z"
```

`package.json` 是版本的唯一来源：electron-builder 用产物名和 `latest*.yml` 取它，
自动更新也按它比大小，所以只能递增，不能改回去。

### 4. 打 tag 并推送

```bash
git tag -a vX.Y.Z -m "FastVibe vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

推 tag 就是触发远端 CI。tag 必须带 `v` 前缀（`release.yml` 只监听 `v*`），用
`-a` 与已有的 `v0.0.1` 保持一致。`release.yml` 是 mac / linux / win 三平台矩阵，各自
`build → stage:app → electron-builder`，把 dmg / zip / exe / AppImage / deb /
blockmap / `latest*.yml` 传到同一个 Release 上。

### 5. 等 CI

```bash
gh run list --workflow release.yml --limit 3
gh run watch <run-id> --exit-status
```

失败先看 `gh run view <run-id> --log-failed`。修好再重跑：
`gh run rerun <run-id> --failed`；若提交本身要改，那属于回滚（见下）。

### 6. 把 note 覆盖到 GitHub Release

CI 的 mac leg 用 `generate_release_notes` 创建 Release，所以 body 里是 GitHub 自动
生成的英文提交列表。等整条 run 结束后用我们的版本**整体覆盖**：

```bash
gh release edit vX.Y.Z \
  --title "FastVibe vX.Y.Z" \
  --notes-file "${TMPDIR:-/tmp}/fastvibe-release-vX.Y.Z.md"
gh release view vX.Y.Z --json tagName,name,isDraft,isPrerelease,url,assets
```

`gh release edit` 是全量替换 body，这正是要的。校验四项：tag 对、不是 draft、
note 是改写后的中文版、产物齐全（mac 两条 dmgs/zip + blockmap、win exe、linux
AppImage/deb、`latest-mac.yml` / `latest.yml` / `latest-linux.yml`）。最后把
`url` 给用户。

## 为什么这么排

- **note 在 bump 提交之前生成**：版本提交本身不该出现在功能列表里。脚本会过滤
  `chore: release vX.Y.Z`，但先取范围更干净。
- **不自己 `gh release create`**：CI 的 mac leg 已经在建 Release，且带
  `generate_release_notes: true`。若推 tag 前先建好 Release，GitHub 会把自动生成的
  notes **追加**在已有 body 后面，一次发布出现两份 changelog；自己建 draft 也一样，
  action-gh-release 会就地接管它。Release 的创建者只能是 CI，note 用 `gh release
  edit` 事后覆盖。
- **不要给 `release.yml` 加第二个 note 来源**（`body_path`、`--notes` 之类）。
  历史提交 `37ad9b6` / `a30fe01` 修的正是三条腿各生成一次 notes、同一条 Release
  堆三份 changelog 的问题，`generate_release_notes` 只留给 mac 腿。要换 note 来源就
  换这里的第 6 步，别动 workflow。
- **note 不进仓库**：它是对 tag 区间的描述，git 历史已经带着了；提交一份只会过期。

## 边界

- 只有用户明确要发版才走到第 4 步；「看看这次会发什么」到第 2 步为止，note 直接
  贴出来就好。
- 不要 `git push --tags`（会把本地所有 tag 一次推上去），只推要发的那个。
- 不要 force push `main`：tag 对应哪个提交是自动更新的依据。
- 发布前工作区里别人的未提交改动不是你的活：报告并停下，不要替用户提交或 stash 掉。

## 失败与回滚

| 情况 | 处理 |
| --- | --- |
| 还没打 tag，版本号写错 | `git reset --hard HEAD~1` 重来 |
| tag 推错 / 不该发 | `gh release delete vX.Y.Z --cleanup-tag`（同时删远端 tag），再 `git tag -d vX.Y.Z` |
| CI 全挂、Release 都没建出来 | 修好 → `git push origin :refs/tags/vX.Y.Z` 后重新打 tag 推；不要本地 `gh release create` |
| 已发布但 note 写错 | 直接 `gh release edit ... --notes-file` 覆盖，产物不用重打 |
| 版本号推低过已发布版本 | 必须往上补一个新版本（自动更新只升不降），旧 tag 按上一条删掉 |

## 脚本

| 文件 | 用途 |
| --- | --- |
| `scripts/env.sh` | 拼 PATH（node / pnpm / gh），每条命令前 source |
| `scripts/bump-version.mjs` | 推断并写入 `package.json` 版本，`--dry-run` 只看不写 |
| `scripts/release-notes.mjs` | 由 `git log` 生成 note 草稿，`--tag` 必填，`--from` 可覆盖范围 |
