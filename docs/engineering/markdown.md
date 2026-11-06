# Markdown、代码与图表

涉及 Shiki、diff、Mermaid、原始 HTML 清洗和数学渲染时阅读。

关联入口：[转写呈现](transcript.md)、[界面规范](ui.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## Code highlighting

Syntax highlighting is **Shiki + `@shikijs/stream`** (`lib/syntax-highlighter.ts`,
with the React binding in `src/renderer/src/lib/highlight.ts`), used by both the
markdown code fences and the file preview — except for a diff, which is rendered
rather than highlighted (below).

- The highlighter is created lazily (`createHighlighterCore`, Oniguruma wasm engine);
  grammars are code-split and loaded on demand, so only languages actually shown are fetched.
- **A fence inside a `markdown` / `mdx` / `asciidoc` block needs its own grammar loaded.** Those
  three ship one grammar and colour an embedded block by *including another grammar's scope
  name* — unlike `vue.mjs` or `rst.mjs`, which bundle what they embed. A ```` ```html ```` inside
  a ```` ```markdown ```` answer was therefore flat: the README an agent quotes showed no markup
  colours at all. `embeddedLanguages` reads the block's fence words, loads those grammars before
  the tokenizer is built, and re-tokenizes the block from the top when a streamed answer reveals
  another one — once per distinct language, never per token. Capped at eight; a fence word the
  host grammar does not name stays flat however much is loaded — ````` ```zig ````` inside a
  ````` ```markdown ````` block is that case, and it is the grammar's limit, not ours.
- **Naming a language is decided twice, and only the pair can be tested.** Main turns a file into
  a language name (`codeLanguageOf` in `engine/file-preview.ts`), the renderer turns that name
  into a grammar, and neither half fails loudly — a forgotten extension leaves a correct file in
  plain text with nothing on screen to say why. So both maps state only what a reader would not
  guess: a `LANGUAGE_LOADERS` key must be an id the loaded grammar answers to (`docker.mjs`
  answers to `docker` *and* `dockerfile`; a key nothing registers for is silently plaintext), and
  `LANGUAGE_ALIASES` holds only names that differ from a key, since `resolveLanguage` tries the
  loaders first. Main lists only renames (`ts` → typescript, `Makefile` → make, a dotfile → its
  own name, which is what `path.extname` leaves you with), so `gd`, `pas`, `kusto` and `hurl`
  live as aliases here rather than as more lines there. `test/syntax-highlighter.test.ts` loads
  every grammar in the catalogue (about a second) and `test/file-preview-language.test.ts` walks
  the pair; both also pin the honest misses — `tlaplus`, `gitignore` — so those stay plain.
- Colors come from `createCssVariablesTheme`, mapped in `index.css` onto the app's
  `--code-*` tokens — every theme highlights correctly with no per-theme setup.
- `useHighlightedCode(code, language)` is the React entry point. Each block keeps a
  `ShikiStreamTokenizer`: completed lines retain their HTML and grammar state, and
  only the unfinished line plus appended text is tokenized. There is no trailing
  debounce to starve a continuous stream; the HTML cache is byte-bounded and keyed
  by the exact `(language, code)`. Replacing/truncating code resets the tokenizer.
- **A fenced block in a reply carries line numbers and its language's file icon**, so it reads
  like the file it is: the header's glyph is the same vscode-icons mark the change chips and
  the file tree draw, and the number column is the one `CodePreview` already uses beside a
  previewed file. `lib/code-fence-icon.ts` maps a fence's language to a *representative file
  name* (`x.ts`, `Dockerfile`) and lets `resolveFileIcon` pick the glyph — one source of marks,
  not a second set. The fence word is folded through `resolveLanguage` first, so `py`, `golang`
  and `python3` all land on a grammar id; **a language with no glyph in the table draws no icon
  at all** rather than a blank page, and `test/code-fence-icon.test.ts` fails on a key that is
  not a grammar id or a value the shipped manifest does not recognise (both degrade silently).
  - **Numbers are one `whitespace-pre` box, not one node per line.** A fence re-renders on every
    streamed flush, and a 600-line block would rebuild 600 number nodes each time to repeat
    itself. The single text node lines up because nothing here wraps (the code column is
    `overflow-x-auto`), so one logical line is one visual line at the shared `leading-5`.
    A one-line fence draws no gutter, and a ```diff fence keeps `DiffView`'s own numbers, which
    come from the hunk header rather than from counting rows.
  - **The vertical viewport and the horizontal scroller are two elements.** `overflow-x: auto`
    makes the *used* value of `overflow-y` `auto` as well, so putting `scrollClassName`
    (`max-h-72 overflow-y-auto`, the codemode script) on the same box as the x-scroller scrolls
    the code inside its own frame and leaves the numbers behind. The outer div is the y-axis,
    the inner the x-axis.
  - **`.code-shiki` is what owns the padding and the size, and it must reset both.**
    `.chat-markdown pre` gives a code block `0.75rem` of vertical padding and
    `.chat-markdown code` shrinks *every* `code` to `0.82em` — including the one Shiki nests in
    the block's own `<pre>`. A 11.5px inline box on a 14px strut measures 21px per line while
    the plain-text fallback and the gutter measure 20px, so numbers drifted off the code the
    moment the grammar resolved. `padding: 0` and `font-size: inherit` on `.code-shiki pre/code`
    (the same reset `.chat-editor .chat-editor-layer :is(pre, code)` already made for the
    composer's highlight layer) leave the card as the one that pads.
  - Preview: `mock.html?diff=1` — a ```diff fence, a multi-line ```ts fence with a blank line in
    it, and a one-line ```bash fence, in one reply.
- Markdown's `components` map must stay at module scope. Inline component functions
  remount the code block on every token, discarding the retained highlight and
  flashing plain text between highlighted frames. `pre` identifies block code,
  including empty/unlabelled single-line fences; `code` alone cannot distinguish them.
- **A diff is not highlighted, it is rendered.** `components/chat/diff-view.tsx` is the
  one renderer for every diff the app shows — a tool call's file change, a ```diff
  fence in a reply, a `.patch` preview, the right pane's git diff — and `lib/diff.ts`
  reads the line numbers out of the diff itself: `@@` hunk headers where a real
  unified diff has them, pi's baked-in `- 12   label` column where it does not (that
  format carries no headers at all). The gutter never counts rows — it used to show an
  invented index beside pi's real number — and a fragment with neither (what a model
  usually writes by hand) renders unnumbered rather than misnumbered. Shiki is out of
  the loop for these: its CSS-variables theme maps nothing for `markup.inserted` /
  `markup.deleted`, so a `diff` fence came out flat and monochrome. **A row is a row, not a
  span of prose**: each line is a `<code>`, and a ```diff fence is not a `<pre>`, so
  `.chat-markdown :not(pre) > code` (the inline chip — rounded, `--code-inline-bg`,
  0.1em/0.35em padding) used to wrap every row in a grey box, leaving the row's own tint
  visible only as a rim around it and its text shifted off the gutter. The rule excludes
  `.diff-line` (`index.css`), and `DiffView` puts that class on the row's `<code>`. Preview:
  `mock.html?diff=1`.
  **The two gutter columns are a fixed width, border included** (`GUTTER_CELL` +
  `gutterWidth`). They were `min-width` boxes that left the 1px `border-r` out of the sum, so a
  blank cell sat at the floor while a cell with a number grew past it — the rule between the
  gutter and the code stepped a pixel in and out on exactly the rows next to a change. A floor
  can always be exceeded by content, so both cells now carry the same padding *and* the same
  1px border (transparent on the first, so one line is drawn), and `overflow-hidden` stops a
  number wider than the box.
  **Every line wraps and nothing scrolls sideways**, in every surface: the transcript's
  tool cards and hover previews are narrow, and a long line that overflows puts the part
  worth reading off-screen with no hint it exists. There used to be a `wrap` prop (off by
  default, on by a 自动换行 toggle in the git pane) — the toggle was removed with it, so a
  diff is one behaviour. `whitespace-pre-wrap break-all` is what guarantees a row cannot
  be wider than its box; `overflow-x-hidden` is the promise, not the mechanism.
- The wasm engine needs `'wasm-unsafe-eval'` in the CSP `script-src` (`index.html`).

## Mermaid 图表

桌面共用的 `MarkdownView` 将 `mermaid` / `mmd` 围栏渲染成图表，普通聊天、Vivi 和 Markdown 文件预览共用。
内置技能 [`mermaid`](../../resources/skills/mermaid/SKILL.md) 经 `builtinSkillPaths()` 加载，指导 Agent 在架构、流程、调用时序、状态流转和实体关系等适合用图说明的场景优先输出 Mermaid 围栏；简单问答、统计图、UI 原型及用户指定其他工具的任务不按此触发。技能只提供提示词，不新增工具或渲染入口。
`mermaid-block.tsx` 只在原始围栏闭合后按需加载 `lib/mermaid-renderer.ts`；未闭合、语法错误或超过 24,000 字符时保留源码，复制始终复制完整源码。成功后可切换图表 / 源码。

- 渲染器串行执行 Mermaid 的配置与布局，取消或替换后的迟到结果不发布；临时 DOM 在 finally 中清理。
- 配色取 `themes.ts` 的语义 token，`useThemeId` 监听具体主题 id，同为暗色的主题切换也重新渲染。默认节点为低饱和主题色浅底与细描边、圆角，连线使用柔和中性色；关闭渐变与阴影。图表容器使用轻底色和无分隔线工具栏，时序图不重复底部参与者。
- 使用 strict 模式，锁定安全与主题配置，禁用 HTML 标签；生成 SVG 再经 DOMPurify 清理，以 data URL 图片显示，不插入应用 DOM、不绑定点击回调，不放宽 Markdown HTML 白名单或生产 CSP。SVG 用 viewBox 设置固有尺寸，避免图片默认 300px 把文字缩小。
- Mermaid 与 DOMPurify 属于 renderer 的 devDependencies，动态加载后由 Vite 打包；无需 CDN。
- 预览：`mock.html?mermaid=1&theme=light|dark`；围栏闭合规则在 `test/mermaid-source.test.ts`，实际布局与 CSP 需要浏览器验证。手机端使用独立 Markdown 渲染器。

## 回复里的原始 HTML

A reply that writes `<kbd>`, `<br/>`, `<details>` or `<div align="center">` renders it as
markup. react-markdown deliberately does **not**: it hands the `raw` nodes it parsed over as
text, so without help the reader sees the tags themselves. Two plugins and a whitelist are the
feature — `rehype-raw` reparses the document into real elements, and nothing about that is safe
on its own, so `lib/markdown-html.ts` is what decides what survives.

- **The pipeline lives in `lib/markdown-pipeline.ts`, not in `markdown-view.tsx`.** The view
  reaches i18n, the session store and the path menu, and `pnpm test` is bare node — so the
  constants that decide what a parse *means* (`REMARK_PLUGINS`, `REHYPE_PLUGINS`,
  `REHYPE_PLUGINS_WITH_HEADING_IDS`) are in a module both sides can import, and
  `test/markdown-html.test.ts` renders those exact lists instead of a copy that can drift.
  `remark-parse` / `remark-rehype` / `hast-util-to-html` are devDependencies for that one test:
  they only rebuild the processor react-markdown builds for itself (`allowDangerousHtml: true`
  is its own default) and serialise the result.
- **Order: raw → sanitize → KaTeX.** Sanitising before the typesetting is what keeps a model's
  own `<code class="language-math math-inline">` from being drawn as a formula it did not write,
  and keeps KaTeX's own output (thousands of classes and inline styles) out of reach of a schema
  written for other people's markup. The cost is that the math marker has to be on the allowlist
  *by value*, which is also what stops `class` becoming a way to apply the app's own Tailwind
  utilities (`<div class="fixed inset-0 bg-background">` is a real panel over a real window).
- **`strip` drops the content, not just the tag.** The default drops only `script`'s; every
  other unsafe element is replaced by its children, which is right for a wrapper and wrong here
  — a `<style>` block came out as a paragraph of CSS, and a dropped `<svg>` left its words
  behind.
- **`fvpath:` / `file:` / `data:image` are the app's own URLs** and must be listed in the
  schema's protocols, or a path link and a produced image silently lose their href/src — the
  sanitizer re-encodes what it allows (`fvpath:%2Fsrc%2F…`), and `markdownPath` already decodes
  it again. `data:` stays off `href`.
- **`splitMarkdownBlocks` must not cut an open tag.** The transcript parses a reply block by
  block for the sake of the stream; CommonMark lets a `<details>` block contain a blank line and
  a paragraph, and one parse stitches them back together. Cut at that blank line, the first
  half closes the element where it stands and the reader gets an empty disclosure plus a stray
  `</details>`. `markdown-blocks.ts` counts unbalanced tags the way it counts fences — a tag
  recognised only by the character after its name, so `<https://example.com>` (an autolink) and
  `a < b` are not elements. An unterminated tag costs one big block, exactly the trade an
  unterminated fence already makes.
- **Not affected:** the phone renders markdown with its own parser (`native Markdown renderer` in
  `apps/mobile`), so what a reply's HTML looks like there is that app's decision. No CSP
  change either — nothing here is a script or an `innerHTML`; the elements are React's own, and
  a remote image from raw markup loads for the same reason a markdown image already does (React 19
  hoists a preload link for every `<img>`, raw or not).

## Math (LaTeX)

A reply's `$…$` and `$$…$$` render as typeset math. **`lib/markdown-pipeline.ts`** mounts
**`remark-math` + `rehype-katex`** (module-level `PluggableList` constants — an
inline array would be a new identity on every streamed token and defeat the `memo`
that exists for exactly that), and `index.css` imports **`katex/dist/katex.min.css`**.
Importing from CSS rather than JS is what keeps the fonts with it: KaTeX's
`url(fonts/…)` resolves against the package, so Vite emits the twenty `.woff2` files
into the renderer bundle and the app stays offline-clean under `default-src 'self'`.
No CSP change is needed.

- **Colour is inherited, so there is nothing per-theme to do** — and nothing that
  *could* be done: KaTeX reads no custom properties of its own. It inherits `color`
  and the font stack, so every theme works untouched. The one exception is the
  error fragment, which gets `errorColor: "var(--destructive)"` from the plugin
  options. `index.css` only adds layout (a display block scrolls instead of
  stretching the bubble).
- **`throwOnError: false`, always.** A half-streamed formula is the normal case here,
  not an error: `$$\frac{1}{` must draw itself in the error colour, never throw into
  React and never log. `strict: false` for the same reason — KaTeX's warnings about
  constructs it merely tolerates are noise in a chat log.
- **`$` is not a reliable math delimiter in this app, so `lib/remark-strict-inline-math.ts`
  judges it.** `remark-math`'s default pairs any two `$` on a line, and a reply about
  shell, config or money is full of them — `$HOME/.config`, `$PATH`, `$5 到 $10` — each
  of which rendered as a garbled equation. Disabling single-dollar math is not the
  answer either (`$O(n\log n)$` is exactly what people type). The plugin keeps
  `remark-math`'s tokenizer and re-reads each node against **Pandoc's `tex_math_dollars`
  rules** — no space inside either fence, no digit right after the closing one —
  putting a rejected run back as the literal text the reader wrote. Display math
  (`$$…$$`) and fenced ` ```math ` are never touched: their fences are unambiguous.
  The rules are unit-tested in `test/markdown-math.test.ts`; a change here is a
  change to what every reply looks like, so run them.
- Code is out of scope by construction — a `$HOME` inside a fence or a code span is
  never a math node, so no shell snippet in a tool card can be eaten by this.
