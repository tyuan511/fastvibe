---
name: find-skills
description: 帮用户寻找、评估并安装 agent 技能。当用户问「怎么做 X」「有没有做 X 的 skill」「你能做 X 吗」（X 是某个专业能力）、想扩展 agent 的能力、想找工具/模板/工作流，或提到希望某领域有帮手（设计、测试、部署等）时使用——哪怕对方没有说出「skill」这个词，只要他想要的能力很可能别人已经写好了，就该用这个技能去查一查。
---

# Find Skills

This skill helps you discover and install skills from the open agent skills ecosystem.

## 你运行在 FastVibe 里（读这一节，它改写了下面的安装命令）

This skill was written for Claude Code and other harnesses. **One thing about it is wrong here and will silently do nothing: the default install target.** Everything else works as written. Fix that one thing before you run anything.

### `-g -y` 不够，必须加 `--agent universal`

`npx skills add` 默认只装到 `claude-code` / `opencode` / `codex` 的目录（`~/.claude/skills` 等）。**FastVibe 不读那些目录**——它读的是 `~/.agents/skills`（全局）和 `<项目>/.agents/skills`（项目）。所以默认命令会报「已安装」，然后你在 FastVibe 里找不到它。

正确的写法是显式指定 universal 这个 target（已实测）：

```bash
# 全局：~/.agents/skills，这台机器上每个项目都能用
npx skills add <owner/repo@skill> -g -y --agent universal

# 项目：<当前目录>/.agents/skills，跟代码一起提交
npx skills add <owner/repo@skill> -y --agent universal
```

- `--agent universal` 是那个把落点指到 `.agents/skills` 的开关（`--agent '*'` 也会包含它，但会顺带写一堆用不上的目录）。
- 默认那三个 agent 的目录（`~/.claude/skills`、`~/.codex/skills` 等）FastVibe 一律读不到；如果用户本来就同时用 Claude Code，不加 `--agent` 也只会装到那边，对 FastVibe 仍然无效。
- **全局还是项目要问用户**，不要自己定。区别很实在：项目级在 `<仓库>/.agents/skills`，**通常会跟代码一起提交**，团队克隆下去就都有；全局则在 `~/.agents/skills`，只在这台机器上生效。参考 `skill-creator` 那一节问法。
- **装完告诉用户怎么让它生效**：技能列表在会话开始时读，新技能通常要开新会话才进工具列表；但 设置 → 技能 的刷新按钮能立刻确认它确实落地了。
- 装之前在 设置 → 技能 里看一眼有没有同名技能：**同名时用户的版本会胜出，不会报错**，所以装重复的名字等于没装。

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

If the user wants to proceed, install it **into a directory FastVibe actually reads** — the `--agent universal` flag is not optional here (see the section at the top):

```bash
npx skills add <owner/repo@skill> -g -y --agent universal
```

The `-g` flag installs globally (`~/.agents/skills`), `-y` skips confirmation prompts, and `--agent universal` is what puts it somewhere FastVibe can see. Without `-g`, the same command lands in `<cwd>/.agents/skills` for the current project instead — ask the user which of the two they want.

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
