---
name: fastvibe-review
description: 使用 fastvibe-review GitHub App 审核 tyuan511/fastvibe 的 Pull Request，以 bot 身份发布行内问题、Request changes 或 Approve，并按用户要求合并或替换旧审核。用户说“review 一下这个 PR”“有问题评论，没问题合并”“用 bot 审核”“重新审核修复后的 PR”“替换原来的审核结果”时使用；仅本地查看且不发布时同样适用。
---

# FastVibe Review

由当前主 agent 负责协调，子 agent 可负责独立审查。随附 CLI 负责 GitHub App 认证和 GitHub 操作。默认审核身份是 `fastvibe-review[bot]`，当前仓库是 `tyuan511/fastvibe`；先查询实际配置，不把这两个值当作验证结果。CLI 不会自动审查源码，也不创建 Check Run。

## Agent Team 分工

完整的 PR workflow 可以使用子 agent，但保持**一个协调者、一个写入出口**：

- **主 agent / coordinator**：拥有用户目标和流程状态；创建或更新 PR，记录当前 HEAD SHA，安排 reviewer，审阅 findings，修改代码，提交并推送，决定是否进入下一轮，最后发布 APPROVE 和执行合并。
- **子 agent / reviewer**：只接收仓库和 PR/Issue URL、审查目标与验证要求；自行从 GitHub 读取当前状态，在独立临时目录或已有只读快照中审查 diff、读取规则、运行必要验证，返回结构化 findings、验证命令和限制。它不修改主工作区，不提交、不推送、不合并。
- **bot CLI**：默认由主 agent 调用来发布 review 和 merge。若确实让 reviewer 子 agent 发布审核，也必须让它再次从 GitHub 读取当前 SHA，并禁止它执行 merge；发布前仍由主 agent 核验返回结果。
- **修复只能有一个 owner**：主 agent 驱动修复，或明确把一组文件交给一个 worker；reviewer 不得同时编辑同一组文件。修复完成后主 agent 才能提交和推送。

子 agent 的输入至少包含仓库、PR 编号或 URL、目标 Issue（如果有）、审查范围和验证要求；**不要传入主 agent 已读取的当前 SHA、审核状态、checks 或旧 findings**。输出至少包含 `reviewedHeadSha`、`verdict`、`findings[]`、`validation[]`、`limitations[]`。主 agent 丢弃 `reviewedHeadSha` 不等于它随后从 GitHub 读取到的 PR HEAD 的结果。凭据默认不传给子 agent：reviewer 只返回审核 JSON，主 agent 用自己的 App CLI 发布；这样私钥不会进入子 agent 的环境或上下文，也避免并发重复评论。

不要让多个 reviewer 同时发布同一 SHA 的正式 review。可以并行运行“代码正确性 reviewer”和“测试/回归 reviewer”，但主 agent 必须合并、去重和排序 findings 后，只发布一份 bot review。子 agent 运行期间主 agent 不应推送新的提交；若 HEAD 改变，所有旧结果都只能作为过期参考。

## 授权与结果

| 用户要求 | 执行范围 |
| --- | --- |
| “只看一下，不评论” | 读取、审查、验证，只在对话中汇报 |
| “审核 PR”“用 bot 审核并发布” | 完成审查并以 bot 发布审核；没有合并授权就不合并 |
| “有问题评论，没问题合并” | 有阻塞问题发布 Request changes；无问题且必要验证通过后 Approve 并合并，无需再问一次 |
| “替换旧审核” | 新审核发布并核验成功后，替换用户明确指定的旧审核 |

发现明确影响正确性的缺陷时用 `REQUEST_CHANGES`；完成审查、没有阻塞问题且必要验证通过时用 `APPROVE`；验证受阻或仍有关键不确定性时用 `COMMENT`，说清缺少的证据。不要把未运行的检查写成通过，不把没有 CI 当作测试通过。

本技能的示例命令都从仓库根目录执行；在临时目录审查时，使用本 SKILL.md 所在目录下脚本的绝对路径。先告知用户本次审核、发布和合并的范围，再操作。

## 完整 PR workflow：提 PR → review → 修复 → review loop → approve → merge

当用户明确要求“提 PR、让 bot 审核、按意见修复、循环直到通过、最后批准并合并”时，主 agent 才执行完整写入流程。只有“review”时不自动修改、提交、推送或合并。循环必须有上限，默认最多 5 轮；达到上限、连续两轮没有可验证进展、测试环境不可复现或出现权限/冲突问题时停下并汇报，不能无限重试。

### A. 创建或确认 PR

1. 主 agent 先读取本地仓库和 GitHub 远端状态，确认当前分支、工作区改动范围、目标 base 分支和用户授权范围。不要替用户 stash、reset、覆盖其他工作流的改动。
2. 需要创建 PR 时，先完成用户要求的代码变更和相关验证，再用作者账号推送分支并创建 PR。GitHub App 只负责 reviewer/merge 身份；PR 作者不能是 `fastvibe-review[bot]`，否则 GitHub 不允许该 bot 自己 Approve 或 Request changes。
3. 创建后从 GitHub 读取 PR URL、编号、base/head SHA；不要把本地分支名或 push 返回值当成 PR 状态。若用户提供了已有 PR，直接从 GitHub 读取它。

常用命令：

```bash
git status --short
git branch --show-current
git push -u origin <branch>
gh pr create --base main --head <branch> --title "..." --body-file /绝对路径/pr-body.md
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs pr <PR编号或URL>
```

### B. 每轮审核

每一轮都严格执行以下顺序，不能用上一轮状态代替当前读取：

1. **主 agent 从 GitHub 读取状态**：确认 PR 仍打开、不是草稿、当前 head/base SHA、现有审核、评论、checks/statuses 和 Issue 记录。
2. **启动 reviewer 子 agent**：任务只包含 PR/Issue URL、审查目标和验证要求；子 agent 自行从 GitHub 读取最新状态。主 agent 不传当前 SHA、旧 findings 或“已经修了哪些问题”的状态判断。
3. **reviewer 审查固定的当前提交**：自行读取完整 diff 和规则，在独立临时目录运行必要验证，产出结构化结果：

   ```json
   {
     "repository": "tyuan511/fastvibe",
     "pullNumber": 2,
     "reviewedHeadSha": "完整40位SHA",
     "verdict": "request_changes",
     "findings": [{"severity":"P1","path":"...","line":12,"side":"RIGHT","body":"..."}],
     "validation": [{"command":"...","result":"passed"}],
     "limitations": []
   }
   ```

4. **主 agent 再次从 GitHub 读取状态**：只有当 GitHub 当前 head SHA 等于 reviewer 的 `reviewedHeadSha` 时，才采纳该产物。若不相等，丢弃本轮结果并重新审核；不能让 reviewer 直接决定另一个提交。
5. **主 agent 合并和去重 findings**：确认问题是当前 PR 引入且可触发；检查是否已有相同 bot 评论。主 agent 用 bot CLI 发布一份正式 review，不让多个 reviewer 并发发布同一 SHA 的 review。
6. **有阻塞问题时**：发布 `REQUEST_CHANGES`，然后主 agent 根据 findings 修复代码。修复前重新读取 GitHub，修复过程中保持一个明确的文件 owner；修复后运行相关测试，写英文提交信息，推送分支。
7. **推送后重新读取 GitHub**：等待 PR API 返回新 head SHA；记录本轮旧 SHA、新 SHA、修复提交、验证结果和 bot review URL。下一轮只能从 GitHub 新 SHA 开始，不能沿用旧 review 的通过判断。

### C. 通过后的批准和合并

当 reviewer 返回无阻塞 findings，且主 agent 从 GitHub 确认当前 SHA、验证结果和讨论状态仍有效时：

1. 主 agent 使用该 SHA 发布 `APPROVE`，再查询 GitHub 确认作者是 `fastvibe-review[bot]`、状态为 `APPROVED`、commit_id 等于当前 head。
2. 主 agent 再读取一次 PR 和 checks/statuses；HEAD、base、草稿状态或必要检查发生变化就回到下一轮，不批准旧状态。
3. 用户的原始请求明确包含合并时，执行 `merge --sha <当前GitHub HEAD> --method squash`；只说“审核”时停止在 APPROVE，不合并。
4. 合并后从 GitHub 读取 PR 的 `merged`、merge commit 和最终状态，再向用户汇报。不能把 API 请求成功或 dry-run 当成已合并。

### D. Issue/PR 状态记录

如果流程有配套 Issue，主 agent 在每轮开始和结束都读取它；必要时用 bot 评论写入带稳定标记的状态摘要，例如：

```text
<!-- fastvibe-review: pr=2 round=2 head=<sha> -->
状态：reviewing / changes-requested / fixed / approved / merged
审核：<bot review URL>
验证：<命令与结果>
```

状态评论只记录 GitHub 已确认的事实，不把它作为 PR head/checks 的替代来源。子 agent 也必须自行读取同一个 Issue/PR；主 agent 不通过直接消息把状态转交给它。

## GitHub 是唯一共享状态源

主 agent、reviewer 子 agent 和修复循环都以 GitHub PR/Issue 为事实来源。不要通过 agent mailbox、prompt 转述、共享内存或上一轮缓存传递“当前 PR 状态”。子 agent 可以把**本轮审查产物**返回给主 agent，但不能把主 agent 转述的 HEAD、审核状态或 checks 当作事实。

每一轮开始时，主 agent 和每个 reviewer 子 agent 都必须自行读取 GitHub：

```bash
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs status
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs pr <PR编号或URL>
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs api 'issues/<PR编号>?per_page=100&page=1'
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs api 'pulls/<PR编号>/reviews?per_page=100&page=1'
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs api 'pulls/<PR编号>/comments?per_page=100&page=1'
```

读取结果至少包括 PR state、draft、base/head SHA、文件列表完整性、审核、评论、checks、commit statuses，以及 PR 对应 Issue 的 state、labels、comments 和更新时间。若流程另有独立跟踪 Issue，也必须同时读取它；Issue 记录不替代 PR API，PR 的 head/base、审核和 checks 仍以 PR API 为准。读取失败、返回旧 SHA 或文件列表不完整时停止本轮，不凭记忆继续。

子 agent 的任务只传仓库和 PR/Issue URL、审查目标和“请自行从 GitHub 读取最新状态”；不要把主 agent 读到的 SHA 或审核结论塞进任务说明。主 agent 收到子 agent 产物后，不能直接相信其中的状态字段，必须再次从 GitHub 读取并比较 `reviewedHeadSha`。主 agent 推送修复后，必须等待远端可见，再以 GitHub 返回的新 HEAD 开启下一轮。

## 1. 验证环境与 bot 身份

需要 Node.js 22.13+、git。`gh` 用于读取完整历史以及按明确授权清理个人账号旧审核。shell 缺少工具时，可先加载本项目已有的 `.agents/skills/release/scripts/env.sh`，每次 bash 调用重新加载。

```bash
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs status
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs pr <PR编号或URL>
```

检查返回的 bot、安装、仓库范围、权限和 PR 身份是否符合目标。检查失败时说明具体原因；不要退回个人账号发布新审核。如果本机尚未配置，读取 [本地配置说明](references/setup.md)。

凭据位于 `~/.config/fastvibe/github-review/config.json` 指向的用户目录。不要读取私钥到对话、打印 JWT/installation token、提交凭据、使用 `gh auth login` 切换个人账号或向用户登录 shell 导出 token。CLI 使用明确的 `Authorization: Bearer`，按操作签发单仓库短期令牌，结束时撤销。

## 2. 固定审查版本并核查代码

1. 从 `pr` 输出记录 `repository`、`number`、`head.sha`、`base.sha`、`base.ref`、现有审核、checks/status。比较 `filesComplete` 与文件总数；列表不完整时补齐，不能只审查 API 截断的前缀。
2. 读取完整 diff，并沿调用链检查相关上下文和项目规则。只报告本 PR 引入、确实可触发的问题，避免把旧缺陷或风格偏好标成阻塞。
3. 查看现有审核，重新验证先前问题。不能因为已有 Request changes 就原样重复，也不能在同一 SHA 下重复发布同一组结果。
4. 使用独立临时目录提取固定提交进行验证。不要切换、清理、stash 或覆盖用户当前工作区；新建/绑定 worktree 仍须先取得用户同意。可以 `git fetch origin pull/<编号>/head`，核对 fetch 到的 SHA 与记录一致后，用 `git archive <已审查SHA>` 提取到临时目录。
5. 执行与改动相关的必要检查；按当前提交的 package.json、AGENTS.md 和 CI 选择命令。验证 PR 本身，不把当前工作区的未提交改动或不同依赖混进去。临时目录复用 node_modules 时核对锁文件与依赖版本；pnpm 的自动安装若试图改动外部共享目录，停止该安装，改用已核对依赖执行等价检查或在临时目录独立安装。
6. 运行 PR 代码和测试时不传入 GitHub App 写权限令牌。应用提供方密钥、App 私钥等也不应作为验证进程的环境变量。
7. 发布前重新读取 PR；HEAD 变化就审查增量并重新验证。目标分支变化影响结论时也要重新验证。

```bash
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs diff <PR编号>
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs api 'pulls/<PR编号>/reviews?per_page=100&page=1'
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs api 'pulls/<PR编号>/comments?per_page=100&page=1'
```

`api` 只提供当前仓库相对路径的 GET，不自动分页；读取历史时继续翻页直至完整，保护有回复的讨论。

每条 finding 写明严重程度、具体触发场景、错误行为与原因、最小修复方向。标题使用 `[P1] ...` / `[P2] ...`，行号锚定当前 diff 上最小的相关位置；`RIGHT` 对应新文件行，`LEFT` 对应删除行。无法锚定到 diff 的结论放进审核正文，不编造行号。

## 3. 以 bot 发布正式审核

用 write 工具生成临时 JSON 文件；不要在 shell 参数中拼多行审核正文。文件放在临时目录，不写入项目源码。

```json
{
  "commit_id": "完整的40位已审查HEAD_SHA",
  "event": "REQUEST_CHANGES",
  "body": "审查结论、阻塞问题概要，以及实际执行的验证和限制。",
  "comments": [
    {
      "path": "src/example.ts",
      "line": 12,
      "side": "RIGHT",
      "body": "[P1] 具体问题标题\n\n触发场景、原因、影响和修复方向。"
    }
  ]
}
```

选择 `APPROVE` 或 `COMMENT` 时按实际情况改 event/body/comments，不能把上面的占位 SHA、路径或发现直接发布。

```bash
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs review <PR编号> --input /绝对路径/review.json --dry-run
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs review <PR编号> --input /绝对路径/review.json
```

两步顺序执行，任一步失败就停止后续写操作。CLI 会校验 HEAD、拒绝明显重复的审核；dry-run 不写 GitHub。若身份与 PR 作者相同，不能 Approve 或 Request changes，不要把 self-review 限制当成无问题。

核验发布返回的 `author`、`state`、`commitId`、URL，再查询新 review 及其评论，确认数量、作者和内容符合预期。网络超时后先查询是否已成功，不盲目重试。

## 4. 替换旧审核（仅按用户明确要求）

已提交 review 无法整条删除，也无法改作者。实际替换方式是：先发布新的 bot review，再移除指定旧 review 的行内评论，把旧 summary 改成指向新 bot review 的简短说明。时间线仍会保留旧 review 记录，完成后向用户说清楚。

按这个顺序处理：

1. 核验新 bot review 与全部行内评论已成功存在，且属于本次审查的 SHA。
2. 读取并备份目标旧 review 及其评论，核对 repo、PR、review ID、原作者；不要批量删除这个 PR 的所有个人评论。
3. 查询全部评论，检查旧评论是否收到回复。已有回复的讨论保留或按明确范围处理，不因换身份删除别人的内容。
4. 使用旧审核作者的现有认证，仅删除属于指定 review 的旧行内评论，再更新该旧 review 的正文，链接到新审核。个人账号在这里仅用于处理它自己已经发布的内容；新审核始终由 App 发布。
5. 最后重新读取 reviews/comments，确认新 bot 结果完整、旧重复评论已处理、没有删除其他讨论。部分失败时说明已完成和未完成的步骤。

现有 CLI 的 `api` 只有 GET，不能用它删除或更新。清理个人账号旧审核可使用：

```bash
# 先 gh api user 确认当前登录者就是目标旧 review 作者。
gh api --method DELETE repos/tyuan511/fastvibe/pulls/comments/<已核对的旧评论ID>
gh api --method PUT repos/tyuan511/fastvibe/pulls/<PR编号>/reviews/<旧reviewID> --input /绝对路径/replacement.json
```

`replacement.json` 只包含 `body`，例如“本条个人审核已由 [bot 正式审核](新审核URL)替换”。逐条校验、顺序执行，失败后停止；如果缺少原作者认证，保留旧记录并说明，不切换账号、冒充作者或删除其他人的评论。

## 5. 合并（仅在已授权且通过审查时）

先发布并核验同一个 SHA 的 `APPROVE`，再执行：

```bash
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs merge <PR编号> --sha <已审查的完整HEAD_SHA> --method squash --dry-run
node .agents/skills/fastvibe-review/scripts/fastvibe-review.mjs merge <PR编号> --sha <已审查的完整HEAD_SHA> --method squash
```

遵循用户指定及仓库允许的合并方式；CLI 默认 squash。合并目标默认由配置中的 `baseBranch` 决定。检查 PR 非草稿、仍打开、HEAD 未变、bot 最新有效审核批准了同一 SHA，必要检查和本地验证已经完成、阻塞讨论已处理。CLI 检查已存在的 checks/statuses 并遵守 GitHub 分支规则，但不会替你判断本地验证与讨论是否已解决。

CLI 合并前重新比较 head/base，并向 GitHub merge API 传入预期 SHA。发生冲突、权限不足或 HEAD 改变时报告实际原因，不能绕过规则或改用个人账号强行合并。检查 API 返回 `merged: true`，再读取 PR 的合并状态与提交。

## 6. 向用户汇报

回复包含：当前审查 SHA、结论、主要问题、实际验证结果、bot 审核链接、是否合并或替换旧记录。只报已经确认完成的操作，不能把 dry-run 当成发布或合并成功。

示例请求：

- “review 一下 https://github.com/tyuan511/fastvibe/pull/2，有问题评论，没问题合并。”——完整审查；按结论发布并条件合并。
- “用 bot 重新审核 PR #2，把原来的个人审核替换掉。”——复核当前 SHA，发布 bot review 后定向替换旧记录。
- “只本地看看这个 PR，不要发评论或合并。”——只读分析与验证，不执行 GitHub 写操作。
