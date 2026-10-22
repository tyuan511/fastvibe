---
name: find-skills
description: 帮用户寻找、评估并安装 agent 技能。当用户问「怎么做 X」「有没有做 X 的 skill」「你能做 X 吗」（X 是某个专业能力）、想扩展 agent 的能力、想找工具/模板/工作流，或提到希望某领域有帮手（设计、测试、部署等）时使用——哪怕对方没有说出「skill」这个词，只要他想要的能力很可能别人已经写好了，就该用这个技能去查一查。
---

# Find Skills

This skill helps you discover and install skills from the open agent skills ecosystem.

## 你运行在 FastVibe 里（读这一节，它改写了下面的安装命令）

This skill was written for Claude Code and other harnesses. Two things are different here: **FastVibe 自己能搜能装**，而且下面那条 `npx` 命令的默认落点你读不到。

### 先走应用内置的那条路，不要先开终端

搜索与安装都是调用表里的方法，经 `fastvibe_config_apply` 就能用：

```text
fastvibe_config_get  { action: "overview" }              # 先看有哪些动作
fastvibe_config_apply { action: "skills.market_search",  input: { query: "react" } }
fastvibe_config_apply { action: "skills.market_install", input: { source: "vercel-labs/agent-skills", skillId: "vercel-react-best-practices" } }
```

- 搜索只回 slug、来源仓库和安装数，**没有说明文字**；要看说明就普通地读一眼 skills.sh 那个页，或者先装上看 设置 → 技能 那一行。
- 装完就生效：空闲会话会立刻重载，不必让用户开新对话。确认它落地看 设置 → 技能。
- 只能装 GitHub 的 `owner/repo`。索引里也会出裸域名来源（`developer.paddle.com` 一类），那些只能回到下面的 `npx` 或让用户在页面上自己装。
- 同名技能**不会被静默覆盖**：已有那一份不是 FastVibe 装的就会报错。要用户真的想换，才带 `overwrite: true` 重试（那只替换应用自己装的那一份）。
- 界面上同样的事在 设置 → 技能 → 「Skill 市场」，用户自己点就能完成；先把这条路告诉用户比替他点一下更合适。

### 真的要用命令行时：`--agent universal` 装到 FastVibe 读不到的地方

`npx skills add` 默认只装到 `claude-code` / `opencode` / `codex` 的目录（`~/.claude/skills` 等），**FastVibe 不读那些目录**，所以默认命令会报「已安装」而你在应用里找不到它。

但 `universal` 也不是答案：按 skills CLI 自己的 agent 表（已实测 v1.7.4），`universal` 的全局目录是 `~/.config/agents/skills`，只有 `pi` / `codex` 这类才是 `~/.agents/skills`。项目级倒都是 `<cwd>/.agents/skills`。所以：

```bash
# 全局：~/.agents/skills（这台机器上每个项目都能用）
npx skills add <owner/repo> --skill <skill-name> -g -y --agent pi

# 项目：<当前目录>/.agents/skills，跟代码一起提交
npx skills add <owner/repo> --skill <skill-name> -y --agent universal
```

- **全局还是项目要问用户**，不要自己定。项目级在 `<仓库>/.agents/skills`，**通常会跟代码一起提交**，团队克隆下去就都有；全局只在这台机器上生效。
- 装完告诉用户怎么确认：技能列表在会话开始时读，新会话才会进工具列表；设置 → 技能 的刷新按钮能立刻看到它落到了哪里。
- 装前先确认没有同名技能（`skills.market_search` 不行时用 设置 → 技能 看一眼）：**同名时用户的版本会胜出，不会报错**，所以装重复的名字等于没装。

### 其余部分照原文做

`npx skills find`、看 skills.sh 排行、查安装量/来源、装完给用户验证——这些在 FastVibe 里都成立（`find` 非交互也能跑，输出带 ANSI 颜色）。下面是原文：

## When to Use This Skill

Use this skill when the user:

- Asks "how do I do X" where X might be a common task with an existing skill
- Says "find a skill for X" or "is there a skill for X"
- Asks "can you do X" where X is a specialized capability
- Expresses interest in extending agent capabilities
- Wants to search for tools, templates, or workflows
- Mentions they wish they had help with a specific domain (design, testing, deployment, etc.)

## What is the Skills CLI?

The Skills CLI (`npx skills`) is the package manager for the open agent skills ecosystem. Skills are modular packages that extend agent capabilities with specialized knowledge, workflows, and tools.

**Key commands:**

- `npx skills find [query] [--owner <owner>]` - Search for skills interactively or by keyword, optionally scoped to a GitHub owner
- `npx skills add <package>` - Install a skill from GitHub or other sources
- `npx skills update` - Update all installed skills

**Browse skills at:** https://skills.sh/

## How to Help Users Find Skills

### Step 1: Understand What They Need

When a user asks for help with something, identify:

1. The domain (e.g., React, testing, design, deployment)
2. The specific task (e.g., writing tests, creating animations, reviewing PRs)
3. Whether this is a common enough task that a skill likely exists

### Step 2: Check the Leaderboard First

Before running a CLI search, check the [skills.sh leaderboard](https://skills.sh/) to see if a well-known skill already exists for the domain. The leaderboard ranks skills by total installs, surfacing the most popular and battle-tested options.

For example, top skills for web development include:
- `vercel-labs/agent-skills` — React, Next.js, web design (100K+ installs each)
- `anthropics/skills` — Frontend design, document processing (100K+ installs)

### Step 3: Search for Skills

If the leaderboard doesn't cover the user's need, run the find command:

```bash
npx skills find [query] [--owner <owner>]
```

For example:

- User asks "how do I make my React app faster?" → `npx skills find react performance`
- User asks "can you help me with PR reviews?" → `npx skills find pr review`
- User asks "I need to create a changelog" → `npx skills find changelog`

### Step 4: Verify Quality Before Recommending

**Do not recommend a skill based solely on search results.** Always verify:

1. **Install count** — Prefer skills with 1K+ installs. Be cautious with anything under 100.
2. **Source reputation** — Official sources (`vercel-labs`, `anthropics`, `microsoft`) are more trustworthy than unknown authors.
3. **GitHub stars** — Check the source repository. A skill from a repo with <100 stars should be treated with skepticism.

### Step 5: Present Options to the User

When you find relevant skills, present them to the user with:

1. The skill name and what it does
2. The install count and source
3. The install command they can run
4. A link to learn more at skills.sh

Example response:

```
I found a skill that might help! The "react-best-practices" skill provides
React and Next.js performance optimization guidelines from Vercel Engineering.
(185K installs)

To install it:
npx skills add vercel-labs/agent-skills@react-best-practices

Learn more: https://skills.sh/vercel-labs/agent-skills/react-best-practices
```

### Step 6: Offer to Install

**FastVibe installs this one itself** — do not reach for the terminal first:

```text
fastvibe_config_apply { action: "skills.market_install", input: { source: "<owner/repo>", skillId: "<skill-name>" } }
```

That writes the skill into the directory 设置 → 技能 owns, tells you how many files landed, reloads
the idle sessions so it is callable in this conversation, and refuses to overwrite a same-named skill
it does not own. It only works for a GitHub `owner/repo` source; for a bare host (`developer.paddle.com`
and friends) the row cannot be installed and the user has to follow their own page.

Ask **global or project** before you fall back to the CLI, and use the flags from the section at the top
(`--agent pi` for a global install FastVibe can read — `universal` writes `~/.config/agents/skills`, which
it cannot):

```bash
npx skills add <owner/repo> --skill <skill-name> -g -y --agent pi   # 全局 ~/.agents/skills
npx skills add <owner/repo> --skill <skill-name> -y --agent universal  # 项目 <cwd>/.agents/skills
```

## Common Skill Categories

When searching, consider these common categories:

| Category        | Example Queries                          |
| --------------- | ---------------------------------------- |
| Web Development | react, nextjs, typescript, css, tailwind |
| Testing         | testing, jest, playwright, e2e           |
| DevOps          | deploy, docker, kubernetes, ci-cd        |
| Documentation   | docs, readme, changelog, api-docs        |
| Code Quality    | review, lint, refactor, best-practices   |
| Design          | ui, ux, design-system, accessibility     |
| Productivity    | workflow, automation, git                |

## Tips for Effective Searches

1. **Use specific keywords**: "react testing" is better than just "testing"
2. **Try alternative terms**: If "deploy" doesn't work, try "deployment" or "ci-cd"
3. **Check popular sources**: Many skills come from `vercel-labs/agent-skills` or `ComposioHQ/awesome-claude-skills`

## When No Skills Are Found

If no relevant skills exist:

1. Acknowledge that no existing skill was found
2. Offer to help with the task directly using your general capabilities
3. Suggest the user could create their own skill with `npx skills init`

Example:

```
I searched for skills related to "xyz" but didn't find any matches.
I can still help you with this task directly! Would you like me to proceed?

If this is something you do often, you could create your own skill:
npx skills init my-xyz-skill
```
