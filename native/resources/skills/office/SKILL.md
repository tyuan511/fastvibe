---
name: office
description: 读取、生成和修改 Word（.docx）、Excel（.xlsx）、PowerPoint（.pptx）。用户提到文档、表格、幻灯片、报告、路演或这些扩展名时使用。不处理 PDF，也不处理旧版 .doc/.xls/.ppt。
---

# Office 文档

`FASTVIBE_OFFICECLI_BIN` 是本次安装内置 OfficeCLI 的绝对路径。下面及专项技能中的 `officecli` 都表示这个程序：bash/zsh 写作 `"$FASTVIBE_OFFICECLI_BIN"`，PowerShell 写作 `& $env:FASTVIBE_OFFICECLI_BIN`，cmd 写作 `"%FASTVIBE_OFFICECLI_BIN%"`。不要用登录脚本或用户 PATH 里的同名程序替代它。变量没有设置时说明本次安装不含可用的内置资源，如实告诉用户，不尝试下载、安装或调用另一版本。

FastVibe 自带 `officecli`。读写 `.docx` / `.xlsx` / `.pptx` 都用它，不要用 python-docx、openpyxl 或别的库另起一套。

## 加载规则

一件产物只加载一个专项技能。先按格式加载，场景技能只在用户的要求明显对得上时才换用它：

| 任务 | 命令 |
| --- | --- |
| Word | `officecli load_skill word` |
| Excel | `officecli load_skill excel` |
| PowerPoint | `officecli load_skill pptx` |
| 可填写的 Word 表单 | `officecli load_skill word-form` |
| 学术论文 | `officecli load_skill academic-paper` |
| 融资路演 | `officecli load_skill pitch-deck` |
| 财务模型 | `officecli load_skill financial-model` |
| 数据看板 | `officecli load_skill data-dashboard` |
| 平滑切换的演示 | `officecli load_skill morph-ppt` |
| 带 3D 模型的演示 | `officecli load_skill morph-ppt-3d` |

属性名、枚举值拿不准时，以 `officecli help <format>` 为准（`word` → `docx`，`excel` → `xlsx`，`ppt` → `pptx`）。专项技能和 help 不一致时，help 说了算。

如果还看到名为 `officecli` 的技能，以本技能为准。那个名字是别处安装脚本写进用户目录的，会盖住同名内置技能；本技能叫 `office`，就是为了不被盖住。

## 你运行在 FastVibe 里

- 二进制随 FastVibe 发布，已经在 PATH 上。`officecli --version` 不通就如实告诉用户，**不要**尝试安装。
- **不要**执行 `curl | bash`、`officecli install`、`officecli mcp`、`officecli config`、`officecli skills install`。它们会往用户的其他工具里写配置。
- **不要**自己起 `officecli watch` / `unwatch`。它会占住 bash 工具，而且一个文件只能有一个 watch，会和侧栏抢。
- 改完要给别人读之前，跑一次 `officecli save <file>`。常驻模式每次修改都会落盘，但交付前再存一次，读到的才一定是最新的。
- 交付时给出文件的绝对路径 Markdown 链接。用户点开链接后在侧栏预览文档；不要调用不存在的 `present` 工具。
- Windows 上没有 bash。专项技能里的命令是 bash 写法：路径照样加引号（`[]` 和 `$` 是元字符），管道、`&&`、heredoc 要翻译成当前 shell 的写法。一条命令失败就停，不要把五十条拼成一个脚本。

## 预览里的选中、跳转和标记

只有这个文件正在侧栏里以实时预览打开时，才可以用下面三个命令。它们找的是侧栏已经起好的 watch，不是再起一个。自己运行 `officecli watch <file>`（不带子命令）会占住 bash，并和侧栏抢同一个文件。

- `officecli get <file> selected --json`：读用户在预览里点选的元素。路径是稳定的 `@id=` 形式，改完文件仍然有效。
- `officecli watch <file> goto <path>`：把预览滚到那个元素。
- `officecli watch <file> mark <path>`：在预览上挂一条待审的修改建议。`selected` 表示当前选中的全部元素。

文件没在侧栏实时预览里打开时不要用。xlsx 没有元素路径，这三个命令对表格没有意义。

## 检查产物

生成或大改之后看一遍结果，再交给用户。

- 有 Chrome、Edge、Chromium 或 Firefox 时，用 `officecli view <file> screenshot` 看版式。
- 没有浏览器时，用 `officecli view <file> html` 看结构，再用 `officecli view <file> issues` 看它自己报的问题。截图失败不要假装看过。
- 公式、目录、页码以 `view issues` 为准：缓存没刷新时，截图里的数字可能是旧的。
