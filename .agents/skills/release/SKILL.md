---
name: release
description: 准备或发布 FastVibe 新版本：推断版本、编写带语言切换链接的中英文 release note、提交版本并按请求推 tag 触发 CI。用于发版、预览更新内容或修改发布流程；仅准备文档或流程不代表授权发布。
---

# Release

一次发版 = 版本号 + release note + tag + 远端 CI。前三步都在本机，且都在推 tag **之前**：
英文 note 写进 `docs/release/vX.Y.Z.md`，简体中文译文写进 `docs/release/vX.Y.Z_zh-CN.md`，
两份随版本提交一起进仓库。CI 打包时把英文文件当作 GitHub Release 的 body
（`release.yml` 的 `body_path`），顶部链接到中文版。发布出去的内容在 tag 存在之前
就已定稿，没有任何「等 CI 跑完再回来改 body」的步骤。

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
node .agents/skills/release/scripts/release-notes.mjs --tag vX.Y.Z --lang zh-CN
```

stdout 是草稿：按 Added / Fixed / Performance / Refactor / Docs / Build & chores 分组，
破坏性变更单独置顶，每条带提交链接和提交正文要点，末尾是 `**Full Changelog**`
compare 链接。
`--lang zh-CN` 生成中文分组和语言导航，**不翻译提交标题与正文**；两份草稿都要改写。

**草稿不能直接发布。** 它是英文提交标题 + 提交正文原文，按下面改写成人话：

- **英文正文 + 对齐的简体中文译文。** 英文正文面向国际用户，分组可用 `Added` / `Improved` /
  `Fixed` / `Performance` / `Breaking changes`；中文用「新增 / 改进 / 修复 / 性能 / 不兼容变更」。
  两份的功能、限制、兼容版本和迁移动作保持一致。英文正文里的中文引用也要翻译，语言导航
  中的「简体中文」保留。`check-release-note.mjs` 检查文件与链接，不判断正文语言或翻译质量。
- 界面文案对应各自语言的实际标签。英文中如：`用时` → "took …"、
  `始终允许` → "Always allow"、`设置 → 通用` → "Settings → General"、
  子 Agent → subagent、电脑操控 → computer control。
- 面向用户，不面向 commit：`stop the packaging globs from stripping nested runtime
  dirs` → "Fixed a crash on launch after packaging: `yaml`'s `dist/doc` was removed by
  the exclusion globs".
- 合并同一件事的多条提交；删掉纯内部改动（测试、CI 跑通、格式化）。Build & chores
  通常整节删掉，只留用户能感知的（如「升级到 Electron 44」）。
- 术语（MCP / acp / pi extension）保留原文。
- 每条一到两句，说清「改了什么、用户能感觉到什么」，不要贴 diff 细节。
- **只写桌面端产品改动。** 以 Electron 应用及其运行时为范围（`src/main`、`src/preload`、
  `src/renderer`、`src/shared`、`resources/extensions`、桌面打包与更新）。官网与云服务已经
  搬到另一个私有仓库（`tyuan511/fastvibe-services`），不在本仓库里，也不会进入 release note。
- README / 文档本身的改写不算发布内容；只有它描述了同一 tag 区间内真实交付的桌面功能时，
  才从对应代码改动提炼该功能，不能把「新增文档」写成一条更新。
- 一个提交同时包含桌面端与其他改动时必须查看 diff，只提炼桌面端部分，不能照抄提交标题或
  因为提交粒度较大而把仓库外改动带进来。若整个区间只有文档改动，正文写明「本版本无桌面端功能变更」。
- 破坏性变更放最前并写清迁移动作；`Full Changelog` 那行保留不动。

两份文件的顶部都要有语言导航，使用**绝对 URL，固定到本次 tag**。这样复制为 GitHub Release
body 或在应用内显示时也能打开，不能使用相对路径：

```markdown
**English** | [简体中文](https://github.com/tyuan511/fastvibe/blob/vX.Y.Z/docs/release/vX.Y.Z_zh-CN.md)
```

```markdown
[English](https://github.com/tyuan511/fastvibe/blob/vX.Y.Z/docs/release/vX.Y.Z.md) | **简体中文**
```

两份末尾都保留同一个 `**Full Changelog**` 链接；这个标记也用于手机 App 隐藏对比链接。
同时在 `docs/release/README.md` 的版本表中登记两种语言的链接，随版本提交一起提交。
改写结果写入 `docs/release/vX.Y.Z.md` 和 `docs/release/vX.Y.Z_zh-CN.md`，随版本提交一起提交：

```bash
mkdir -p docs/release
printf '%s\n' "<改写后的 note>" > docs/release/vX.Y.Z.md
printf '%s\n' "<对应的简体中文 note>" > docs/release/vX.Y.Z_zh-CN.md
node scripts/check-release-note.mjs --tag vX.Y.Z
```

`scripts/check-release-note.mjs` 就是 CI 里跑的那一支：检查 note 是否存在、有内容；带中文
导航或译文时，也检查配对文件和双向绝对链接。历史单语 note 仍可重跑。它**不查正文语言**。
本地先跑一次，免得推完 tag 才发现文件名写错——那时
`release.yml` 会在几十秒内失败，但 tag 已经推出去了。

检查两份 note 的内容和链接，把最终结果提供给用户审阅。只有本次请求明确要求发布，才继续
到提交版本和推送 tag；仅优化 README、release skill 或预览更新说明，到这里完成。

**给已发布版本补译文时，不移动 tag。** 旧 tag 里没有新加的中文文件，语言链接改用
`https://github.com/tyuan511/fastvibe/blob/main/docs/release/<tag>_zh-CN.md`（反向链接也用 main），
并先提交、推送两份文件，让链接可访问。只有用户要求更新线上 Release body 时，才用
`gh release edit --notes-file` 更新；先备份原文，产物不用重打：

```bash
mkdir -p "${TMPDIR:-/tmp}/fv-notes"
gh release view vX.Y.Z --json tagName,body > "${TMPDIR:-/tmp}/fv-notes/vX.Y.Z.json"
```

### 3. 写入版本号和 note 并提交

```bash
node .agents/skills/release/scripts/bump-version.mjs minor   # 或 patch/major/X.Y.Z
git add package.json docs/release/vX.Y.Z.md docs/release/vX.Y.Z_zh-CN.md docs/release/README.md
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
`-a` 与已有的 `v0.0.1` 保持一致。`release.yml` 是 mac ×2 / linux ×2 / win 的矩阵，各自
`build → stage:app → electron-builder`，把 dmg / zip / exe / AppImage / deb /
blockmap / `latest*.yml` 传到**同一个 draft Release** 上。Linux 两条腿按架构分开，产出
`FastVibe-<v>.AppImage` / `fastvibe_<v>_amd64.deb` / `latest-linux.yml` 与
`FastVibe-<v>-arm64.AppImage` / `fastvibe_<v>_arm64.deb` / `latest-linux-arm64.yml`；
`latest-linux-arm64.yml` 正是 arm64 上 electron-updater 按 `process.arch` 去取的文件名，
所以两条腿不会互相覆盖更新通道。Agent runtime 的 `fastvibe-agent-linux-*.tar.gz` 不在这里
产出，它由独立的 `agent-runtime.yml` 发布（见 `docs/agent-runtime.md`）。

**draft 是对用户不可见的窗口期，最后一步才转正。** 这些产物有 130 MB 量级，而
`latest.yml` 只有几百字节：一旦 Release 提前公开，自动更新会在用户那边立刻看到新版本，
却要等安装包传完才下载得下来。所以**每一个上传的 leg 都传进 draft**（GitHub 的 Atom feed
和 `/releases/latest` 都不列 draft，electron-updater 因此完全看不见），最后由
`publish` job 合并 `latest-mac.yml`、连同它一起上传，并在同一个调用里把 Release 转正
（action-gh-release 先传完再取消 draft）。`latest-mac.yml` 只由 `publish` 上传，
因为它是唯一一个「出现即等于宣布更新」的产物；win / linux 的 `latest*.yml` 随
leg 自己的资产一起传进 draft，安全的原因是那时 Release 还没公开。

`publish` **needs 整个 `build` 矩阵**；Agent runtime 走独立发布流程。任一条桌面打包腿失败，
Release 就停在 draft，客户端不会被通知——这是安全的失败方式，修好重跑即可。

**note 不在这里产生。** 每条 leg 都传 `body_path: docs/release/${{ github.ref_name }}.md`，
GitHub Release 的 body 就是那个 tag 上的文件内容。action-gh-release 是**整体替换** body
（会做拼接的只有 `generate_release_notes`，而它已经被删掉了），所以各条 leg 反复写的是同一份
字节，不会再出现「三条腿各生成一次、同一条 Release 堆三份 changelog」那个问题。

### 5. 等 CI

```bash
gh run list --workflow release.yml --limit 3
gh run watch <run-id> --exit-status
```

失败先看 `gh run view <run-id> --log-failed`。修好再重跑：
`gh run rerun <run-id> --failed`；若提交本身要改，那属于回滚（见下）。

注意 **`--failed` 不包含被 skip 掉的 `publish`**（GitHub 只重跑 conclusion 是 failure 的
job；因 `needs` 未满足而 skipped 的留在 skipped）。若失败让 `publish` 没跑起来，修好
前面的 job 后单独重跑它：

```bash
gh run view <run-id> --json jobs --jq '.jobs[] | select(.name=="Publish the release") | .databaseId'
gh run rerun <run-id> --job <databaseId>   # 注意要 databaseId，不是 URL 里的编号
```

或直接 `gh run rerun <run-id>`（全部重跑）。

跑完后确认 Release 已经转正：`gh release view vX.Y.Z --json isDraft` 必须是 `false`。
停在 draft 说明 `publish` 没成功，此时用户**不会**收到任何更新通知（draft 进不了
Atom feed，也没有 `latest*.yml` 可读）。

### 6. 确认 Release 的 body

body 已经由 CI 写好了，这一步只是核对，不是修补：

```bash
gh release view vX.Y.Z --json tagName,name,isDraft,isPrerelease,url,body,assets
```

```bash
gh release download vX.Y.Z --pattern 'latest*.yml' 2>/dev/null   # 可选
diff <(gh release view vX.Y.Z --json body --jq .body) docs/release/vX.Y.Z.md
```

校验 tag 对、不是 draft、上面那条 `diff` 无输出，并打开 Release 顶部的中文链接，确认对应
tag 的中文文件可读且反向链接正确；再确认产物齐全（mac 两条 dmgs/zip +
blockmap、win exe、linux 两条腿的 AppImage/deb、`latest-mac.yml` / `latest.yml` /
`latest-linux.yml` / `latest-linux-arm64.yml`）；title 是 `FastVibe vX.Y.Z`。最后把 `url` 给用户。

若 body 确实错了（语言链接缺失、漏了内容等），改的是**那条 Release**，不是重打产物：

```bash
gh release edit vX.Y.Z --notes-file docs/release/vX.Y.Z.md   # 先把文件改对再跑
```

workflow 读的是 **tag 上的**那个文件，所以在 `main` 上补一次提交不会回改已发布的 body；
下一次重跑同一条 workflow 会重新使用 tag 上的旧正文。已发布版本的修订保存在 `main`，
补译链接也指向 `main`；不要为文案修改重打已发布 tag。

## 手机 App（`app-vX.Y.Z`）

App 的 note 和桌面端同一个规则：先写进 `docs/release/app-vX.Y.Z.md` 和
`docs/release/app-vX.Y.Z_zh-CN.md`，顶部双向链接固定到 `app-vX.Y.Z` tag，再随版本提交一起推，
`mobile-android.yml` 开头跑 `check-release-note.mjs --tag app-vX.Y.Z`，发布时用
`body_path` 把它当 Release body。**App 里的「更新日志」就是这份文件**：更新弹窗显示新版本的
note，设置 → 关于 → 更新日志显示当前安装版本的 note，都按 Markdown 渲染（`**Full Changelog**`
那一行在 App 里隐藏）。

```bash
node .agents/skills/release/scripts/release-notes.mjs --tag app-vX.Y.Z   # 从上一个 app-v tag 起，只列 apps/mobile_flutter 的提交
node .agents/skills/release/scripts/release-notes.mjs --tag app-vX.Y.Z --lang zh-CN
# 改写并保存两种语言的文件，pubspec.yaml 改成 X.Y.Z+BUILD；随版本提交一起提交
node scripts/check-release-note.mjs --tag app-vX.Y.Z
git tag -a app-vX.Y.Z -m "FastVibe Mobile app-vX.Y.Z" && git push origin app-vX.Y.Z
```

改写规则同上（英文正文、中文译文、面向用户），范围换成手机 App；需要新版桌面端配合的，两份都写明
「Update your FastVibe host to **vX.Y.Z or newer** …」。

## 为什么这么排

- **note 在 bump 提交之前生成**：版本提交本身不该出现在功能列表里。脚本会过滤
  `chore: release vX.Y.Z`，但先取范围更干净。
- **note 进仓库（`docs/release/vX.Y.Z.md`）而不是留在本机**：CI 读的就是这个文件。
  它以前放在 `${TMPDIR}` 里、push 后由人 `gh release edit` 补上，那段窗口里 Release 的
  body 是 GitHub 自动生成的提交列表——用户看到的确实是错的，只是等着人去改。现在是先定稿
  再发布，没有那个窗口。
- **不自己 `gh release create`**：CI 的 leg 已经在建 draft Release，自己先建也一样，
  action-gh-release 会就地接管它。Release 的创建者和转正（`publish`）都是 CI 的事。
- **不要把某个 leg 改回 `draft: false`**：那正是「通知了更新、安装包还没传完」这个 bug
  本身。要让 Release 提前可见，唯一正确的做法是先传完再公开，而不是让先到的腿把门打开。
- **不要再引入 `generate_release_notes`**：它做的是**追加**，历史提交 `37ad9b6` /
  `a30fe01` 修的正是三条腿各追加一次、同一条 Release 堆三份 changelog 的问题。
  `body_path` 是整体替换，各条腿写同一份字节，这才是安全的。要改 release note 本身，
  同步修改 `docs/release/vX.Y.Z.md` 和 `docs/release/vX.Y.Z_zh-CN.md`。
- **每条 leg 都跑 `check-release-note.mjs`**：少了这个检查，漏写 note 的 tag 会先花二十
  分钟打包、再发布一个空 body 的 Release——那是唯一一个重跑也修不好的结果。
- **不要用 `docs/release/` 以外的位置**：`electron-builder.yml` 的 `app` staging 是白名单
  （`scripts/stage-app.mjs` 只拷 `package.json` + `out/`），所以这个目录不会进安装包。

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
| 某条腿失败，Release **停在 draft** | 客户端根本没被通知，直接 `gh run rerun --failed`（`publish` 被 skip 时用全部重跑，见第 5 步）；不用重新打 tag |
| draft 里的半个发布不想要了 | `gh release delete vX.Y.Z --cleanup-tag` 删掉 draft；它从未公开，用户侧无感 |
| 已发布但 note 写错 | 直接 `gh release edit ... --notes-file docs/release/vX.Y.Z.md` 覆盖，产物不用重打；再把这个文件改对提交到 `main`，让仓库与 Release 一致 |
| 已发布的 note 需要补中文或语言链接 | 在 `main` 保存对齐的中英文文件，使用 `blob/main` 双向链接；按用户要求备份并更新 Release body，不重打产物、不动 tag |
| tag 上的 note 缺失 / 为空 | `release.yml` 会在开头几秒里失败，Release 没建出来，客户端也就没被通知。补上 note（缺失时这必然是一个新提交）、`git push origin :refs/tags/vX.Y.Z`、重新打 tag 推 |
| 版本号推低过已发布版本 | 必须往上补一个新版本（自动更新只升不降），旧 tag 按上一条删掉 |

## 脚本

| 文件 | 用途 |
| --- | --- |
| `scripts/env.sh` | 拼 PATH（node / pnpm / gh），每条命令前 source |
| `scripts/bump-version.mjs` | 推断并写入 `package.json` 版本，`--dry-run` 只看不写 |
| `scripts/release-notes.mjs` | 由 `git log` 生成 note 草稿，`--tag` 必填（`vX.Y.Z` 或 `app-vX.Y.Z`），`--from` 可覆盖范围，`--lang zh-CN` 生成中文分组与导航 |
| `docs/release/README.md` | note 文件的约定（双语命名、语言链接、英文文件作为 Release body） |
