---
name: release
description: 发布 FastVibe 新版本：按提交推断并写入 package.json 版本号、生成 release note 并提交到 docs/release/{version}.md、打 tag 推送触发远端 CI 打包，CI 直接用它当 GitHub Release body。用户说「发版 / 发布新版本 / 出个 release / cut a release」时使用。
---

# Release

一次发版 = 版本号 + release note + tag + 远端 CI。前三步都在本机，且都在推 tag **之前**：
note 写进 `docs/release/vX.Y.Z.md` 并随版本提交一起进仓库，CI 打包时直接把它当作
GitHub Release 的 body（`release.yml` 的 `body_path`）。所以发布出去的内容在 tag 存在之前
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
```

stdout 是草稿：按 Added / Fixed / Performance / Refactor / Docs / Build & chores 分组，
破坏性变更单独置顶，每条带提交链接和提交正文要点，末尾是 `**Full Changelog**`
compare 链接。

**草稿不能直接发布。** 它是英文提交标题 + 提交正文原文，按下面改写成人话：

- **一律用英文书写。** 这是 GitHub Release，面向国际用户，与 README 的英文部分一致，
  也是 `docs/release/*.md` 的约定。分组标题也用英文（`Added` / `Improved` / `Fixed` /
  `Performance` / `Refactor` / `Docs` / `Import` / `Other` / `Breaking changes`）。
  提交正文里原文引用的中文句子也要译过来，不能因为「是引用」就留下。**这只是写作约定，不是闸门**：
  `check-release-note.mjs` 不查语言，不因为一个正则卡住一次发布。
- 界面文案用当下的英文界面原文，不要写中文标签：`用时` → "took …"、
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
  `src/renderer`、`src/shared`、`resources/extensions`、桌面打包与更新）；官网、营销页、部署配置、
  截图素材及其专用脚本（例如 `apps/website/**`、网站构建命令）一律不进入 release note。
- README / 文档本身的改写不算发布内容；只有它描述了同一 tag 区间内真实交付的桌面功能时，
  才从对应代码改动提炼该功能，不能把「新增文档、官网或截图」写成一条更新。
- 一个提交同时包含桌面端与官网改动时必须查看 diff，只提炼桌面端部分，不能照抄提交标题或
  因为提交粒度较大而把网站改动带进来。若整个区间只有网站或文档改动，正文写明「本版本无桌面端功能变更」。
- 破坏性变更放最前并写清迁移动作；`Full Changelog` 那行保留不动。

改写结果写入 `docs/release/vX.Y.Z.md`——它是仓库的一部分，要随版本提交一起提交：

```bash
mkdir -p docs/release
printf '%s\n' "<改写后的 note>" > docs/release/vX.Y.Z.md
node scripts/check-release-note.mjs --tag vX.Y.Z   # 缺失 / 空白都会在这里拦住
```

`scripts/check-release-note.mjs` 就是 CI 里跑的那一支（只查缺失与空白，**不查语言**：note 是
给人读的文章，不该被一条正则拦住发布），本地先跑一次，免得推完 tag 才发现文件名写错——那时
`release.yml` 会在几十秒内失败，但 tag 已经推出去了。

英文约定自己守（含引用、标点），CI 不管这段：

```bash
rg -P '[\p{Han}]' docs/release/vX.Y.Z.md || echo "all English"
```

把最终 note 念给用户确认——这一步之后就是不可逆的推送。

**历史 Release 也要是英文的。** 早期版本发的中文 note 在 GitHub 上，用 `gh release edit
--notes-file` 覆盖即可，产物不用重打；覆盖前先把原文存到仓库外备份：

```bash
gh release view vX.Y.Z --json tagName,body > "${TMPDIR:-/tmp}/fv-notes/vX.Y.Z.json"
```

### 3. 写入版本号和 note 并提交

```bash
node .agents/skills/release/scripts/bump-version.mjs minor   # 或 patch/major/X.Y.Z
git add package.json docs/release/vX.Y.Z.md
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
blockmap / `latest*.yml` 传到**同一个 draft Release** 上；两条 Linux 腿另外产出
`fastvibe-agent-linux-*.tar.gz`。

**draft 是对用户不可见的窗口期，最后一步才转正。** 这些产物有 130 MB 量级，而
`latest.yml` 只有几百字节：一旦 Release 提前公开，自动更新会在用户那边立刻看到新版本，
却要等安装包传完才下载得下来。所以**每一个上传的 leg 都传进 draft**（GitHub 的 Atom feed
和 `/releases/latest` 都不列 draft，electron-updater 因此完全看不见），最后由
`publish` job 合并 `latest-mac.yml`、连同它一起上传，并在同一个调用里把 Release 转正
（action-gh-release 先传完再取消 draft）。`latest-mac.yml` 只由 `publish` 上传，
因为它是唯一一个「出现即等于宣布更新」的产物；win / linux 的 `latest*.yml` 随
leg 自己的资产一起传进 draft，安全的原因是那时 Release 还没公开。

`publish` **needs 全部 leg**（`build` 矩阵 + Agent runtime 矩阵）。任一条腿失败，
Release 就停在 draft，客户端不会被通知——这是安全的失败方式，修好重跑即可。

**note 不在这里产生。** 每条 leg 都传 `body_path: docs/release/${{ github.ref_name }}.md`，
GitHub Release 的 body 就是那个 tag 上的文件内容。action-gh-release 是**整体替换** body
（会做拼接的只有 `generate_release_notes`，而它已经被删掉了），所以四条 leg 反复写的是同一份
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

校验四项：tag 对、不是 draft、上面那条 `diff` 无输出、产物齐全（mac 两条 dmgs/zip +
blockmap、win exe、linux AppImage/deb、`latest-mac.yml` / `latest.yml` /
`latest-linux.yml`）；title 是 `FastVibe vX.Y.Z`。最后把 `url` 给用户。

若 body 确实错了（写成中文、漏了内容等），改的是**那条 Release**，不是重打产物：

```bash
gh release edit vX.Y.Z --notes-file docs/release/vX.Y.Z.md   # 先把文件改对再跑
```

workflow 读的是 **tag 上的**那个文件，所以在 `main` 上补一次提交不会回改已发布的 body；
下一次重跑同一条 workflow 也不会（它 checkout 的是 tag 对应的提交）。要两者一致，得改文件并
重打 tag（见回滚）。只想让文件别再落后于现实时，补提交到 `main` 就够了。

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
  `body_path` 是整体替换，四条腿写同一份字节，这才是安全的。要改 release note 本身，
  改 `docs/release/vX.Y.Z.md`。
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
| 已发布的 note 是中文 | 改写成英文后用同一条命令覆盖（备份原文见第 2 步）；只改 body，不重打产物、不动 tag。校验不过不拦发布，只是与你默认的英文约定不符 |
| tag 上的 note 缺失 / 为空 | `release.yml` 会在开头几秒里失败，Release 没建出来，客户端也就没被通知。补上 note（缺失时这必然是一个新提交）、`git push origin :refs/tags/vX.Y.Z`、重新打 tag 推 |
| 版本号推低过已发布版本 | 必须往上补一个新版本（自动更新只升不降），旧 tag 按上一条删掉 |

## 脚本

| 文件 | 用途 |
| --- | --- |
| `scripts/env.sh` | 拼 PATH（node / pnpm / gh），每条命令前 source |
| `scripts/bump-version.mjs` | 推断并写入 `package.json` 版本，`--dry-run` 只看不写 |
| `scripts/release-notes.mjs` | 由 `git log` 生成 note 草稿，`--tag` 必填，`--from` 可覆盖范围 |
| `docs/release/README.md` | note 文件的约定（命名、英文、它是 Release body） |
