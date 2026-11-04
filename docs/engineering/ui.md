# 界面、主题与桌面布局

涉及 shadcn、资源面板、窄视口、主题、字号、玻璃、滚动条、语言、路由、菜单、搜索与设置同步时阅读。

关联入口：[转写呈现](transcript.md)、[工作区与媒体](workspace-and-media.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## 桌面 renderer 的窄视口与触屏布局

> 本节约束 React renderer 的窄布局。原文中的手机浏览器、iOS 键盘及旧远程网页场景是历史背景，不代表当前 Flutter 页面的实现；手机端以 [当前手机合同](mobile.md) 为准。

Below `md` the sidebar overlays as a drawer instead of pushing (`CollapsiblePanel`), and
the right pane is not rendered at all — a 375pt screen has no room for the terminal, a diff
or the file tree, and the browser pane has no webview to drive anyway. Above `md` the three
columns are one `react-resizable-panels` group: `components/ui/resizable.tsx` (added with
`pnpm shadcn add resizable`) holds the primitives, `lib/use-resizable-panel.ts` binds one
side panel to the app's own state, and `App.tsx` owns the group. The library owns *who is
how wide*; the collapsed flags and the resting widths stay in the stores and in
`settings.json` exactly as before.

**The drawer is the whole viewport** (`100vw`), and nothing caps it. It used to take
`86vw` under a `maxWidth` of the remembered column width, which read as a defensive
ceiling and was in fact the bug: `clampSidebarWidth` scales its maximum to 40% of the
viewport, so on a 375pt screen the remembered width came back as **150** and the drawer
opened as a sliver. The ceiling is gone and the clamp now skips the viewport share on a
narrow layout entirely — the stored number is a memory of the *desktop's* column, and a
phone has no business shrinking it, least of all in a `settings.json` the desktop reads.

Three things follow from the drawer covering everything:

- **No backdrop.** There is no dimmed conversation behind it to tap. The button that used
  to be there sat under a full-screen panel and could never be reached.
- **No splitter.** The separator is not rendered when narrow: there is no edge to drag,
  it sat where a thumb scrolls the list, and its drag ended in `writeSidebarWidth` — one
  stray swipe on a phone rewrote the column width of the desktop it was connected to.
- **The sidebar's own 收起 is the only way out**, so it has to work. Every control that
  shows or hides the sidebar goes through `setSidebarCollapsed`
  (`lib/sidebar-visibility.ts`) and never writes `sidebarCollapsed` directly. Two of them
  did, and on a phone both did the wrong thing twice at once: the drawer stayed open,
  because it does not read that key, and the desktop collapsed its sidebar.

Because it covers everything, the drawer is also a place you pass *through*, not a place
you stay:

- **Picking something closes it.** Opening a chat, 新对话 (global or a project's),
  搜索 and 设置 all end in `dismissDrawer()` (`sidebar.tsx`) — what was asked for
  happens behind the drawer, so leaving it open made every tap a two-step.
- **No drag-to-reorder.** The `PointerSensor` is not registered when narrow: a thumb
  scrolling the list moves more than its 5px threshold over a row, so a scroll that began
  on a chat picked it up and reordered it. Long-press still opens the context menu.
- **Touch gets its own row rules, keyed on `pointer-coarse:`** rather than the width:
  rows grow to `h-10`, and hover-only actions (a project's ⋯ / new chat, a section's +)
  are drawn instead of `opacity-0` — an invisible button is still a tappable one.

The same two rules reach past the sidebar. **Touch** is `pointer-coarse:` in classes and
`isTouchOnly()` (`lib/platform.ts`, the same media query) in code; **width** is
`useIsNarrowViewport()`.

- Every hover-revealed control shows on touch: a message's copy / edit / retry / fork
  footer, the expand chevrons, 归档对话's row actions.
- `index.css` has one touch-only block: inputs are 16px (iOS zooms into anything smaller
  on focus and never zooms back), no tap flash, no double-tap delay, no pull-to-refresh.
  `#root` pads the safe-area top and sides; the bottom stays with `.safe-bottom`.
  The page asks for `interactive-widget=resizes-content` where it can, so on Android the keyboard
  shrinks the layout and the composer sits on top of it rather than under it.
- The composer: on touch, Enter is a newline (a soft keyboard has no Shift+Enter), and the
  project chip's folder icon is not a hidden 清除项目 — the picker grows that row instead.
- The follow-up queue reorders on touch only after a 250ms hold (`TouchSensor`), so a
  scroll starting on a row does not pick it up.
- Narrow drops the header's project prefix (it is `shrink-0` and ate the title) and the
  side-pane toggle (there is no side pane to open).
- **Settings is master/detail when narrow**: the section list is a page, a section is a
  page with 〈 设置 to go back (`listOpen`). 模型管理 uses the same single-column provider
  accordion on every viewport; expanding a row shows its configuration and models in place.
  Opening at `/settings/general` — what the sidebar does — lands on the
  list; any other deep link lands on that pane. `SettingsRow` wraps (label `basis-48`), so
  a wide select drops under its label instead of squeezing it.

The drawer's open/closed state is **local to the device** (`lib/sidebar-visibility.ts`),
not the persisted `sidebarCollapsed`: that preference lives in one `settings.json` shared
by every client of this machine, so swiping the drawer open on a phone would otherwise
collapse the sidebar on the desktop it is connected to.

`CollapsiblePanel` is the drawer only now, and it still drives **both** `x` and `width`.
Motion only writes the keys an `animate` object names and leaves the rest of what it last
wrote in place, so a branch animating only `width` inherited the drawer's
`translateX(-100%)` and parked the sidebar off-screen the moment a window crossed the
breakpoint.

The column layout the library replaced had no such trap, but it had a worse one: its
splitter listened for `mousemove` / `mouseup` on `window`, and the side pane hosts a
`<webview>`. A pointer that crossed into the guest stopped reaching the parent document,
so the drag froze mid-way — and a button released over the guest never fired `mouseup`, so
the splitter stayed welded to the cursor until the next click. The library drives its
separators with pointer events and `setPointerCapture`, which is the whole point of using
it.

## UI: shadcn Nova

- Style: **`base-nova`** (latest Nova on Base UI). Configured in `components.json`.
- Package manager is **pnpm**. Install and update primitives **only** via:

  ```bash
  pnpm shadcn add <component> -y
  ```

- Do **not** hand-write files under `src/renderer/src/components/ui/`. If a primitive already exists in shadcn (Button, Input, Textarea, Badge, Message, Bubble, Empty, Item, Alert, …), add it with the CLI and compose it.
- Product screens (chat thread, workspace chrome, tool cards) live outside `components/ui/` and **compose** shadcn primitives. Custom markup is allowed only when shadcn has no matching primitive.
- **A group part needs its group.** `DropdownMenuLabel` / `ContextMenuLabel` / `SelectLabel` are Base UI's `Menu.GroupLabel`, which throws `MenuGroupContext is missing` when rendered outside its group; the same applies to the other group-only parts. It is a **render-time** throw, so no typecheck catches it and it does not degrade gracefully — it unmounts the whole tree. That is how the composer's model menu, whose empty state drew a bare label, took FastVibe down the instant it was opened on an install with no models. Wrap every label in `DropdownMenuGroup` / `ContextMenuGroup` / whichever group the surface has.
- Wrap the tree with `TooltipProvider`.
- Select 触发器统一使用单下箭头，设置页与 MCP 表单都复用公共 Select，不保留平台原生双箭头。选项文字允许收缩并省略，右侧勾选区单独预留空间，不能用 `shrink-0` 让长名称覆盖勾选标记。生图模型菜单优先向上展开，按内容增长宽度并受视口限制。
- `vite.config.ts` exists so the shadcn CLI can detect Vite. The Electron app builds through `electron.vite.config.ts`.

## 会话资源

`AiExpandIcon` 资源入口只挂载在中间聊天区自己的标题栏右侧，不跨列、不移到右侧详情区域。右侧面板收起时，这里按「资源 → 展开面板」排列；右侧面板展开后，中间区只保留资源按钮，收起按钮属于右侧面板自己的标题行。
两个区域各有标题行，右侧面板不为跨列标题栏下移。资源面板展开或收起都保留同一个入口；右侧面板最大化时，中间区及其标题栏一起隐藏，资源入口也不迁移过去。
`ConversationResources` 内容随会话栏实际宽度切换：有足够正文留白时绝对定位常驻，同一个按钮可以收起；空间不足时点击按钮打开可在外部点击关闭的浮层。
资源面板固定为 `300px` 宽，浮层在极窄窗口内再收窄。`ResizeObserver` 同时观察会话栏和一个尺寸探针（`chatColumnDockProbe`，居中正文加两侧 `1rem` 内边距再加 `300px + 1rem` 面板留白；`50rem + 600px` 起，随消息宽度变化），所以侧栏拖动、界面字号和消息宽度都参与判断，不以整窗宽度代替。消息宽度为「最宽」时正文占满会话栏，没有可停靠的留白，面板只以浮层打开。
用户打开偏好保存在 `settings.resourcePanelOpen`（默认开启），跨会话和重启保留。宽度变化只清空临时浮窗，不改写偏好：变窄自动隐藏，重新变宽时按偏好恢复。按钮、点击外部或 Escape 的主动关闭才记为关闭；打开文件等导航动作只临时收起浮窗。窄布局不会因为恢复偏好自动弹出浮窗，仍需手动点击查看。
视觉采用单层浮层和平铺列表：分组间用细分隔线与留白，不套边框卡片，展开标题也不铺底色。
常驻与浮窗共用 `resource-surface`，保留左侧栏的内侧细边、高光和边缘反光，不加外投影。普通主题使用 `--sidebar` 底色；玻璃主题的常驻面板使用 `--glass-pane`，浮窗则使用与全局弹窗一致的 `--glass-overlay` 透明度，避免下面的正文干扰，同时模糊背后文字、不额外增强饱和度。
只在常驻面板可见或浮层展开时挂载资源读取；切换会话关闭浮层，异步文件预览返回后必须再次核对所属会话。
任务清单复用 `useConversationTodo` / `TodoRow`，显示已完成数量；展示条件与 composer 上方的面板完全一致，过时的计划两处都不画（不是画出来再打个标记）。
子代理合并转写、当前会话的运行注册表和 DAG；实时状态优先，DAG 的当前运行不能重复列出。
资源面板不展示后台任务或命令调用；命令输出仍在会话转写中查看。
资源面板不展示「最近产出」文件列表；文件产物仍从会话转写中打开。
工作区变更是仓库全部改动，不宣称由本会话产生；点击仓库通过 `openGit(cwd)` 定位审查。
环境的分支行同样打开变更视图，并额外把提交历史的分支范围切到当前分支（`openGit(cwd, "current")`）。这个请求是一次性的：面板应用后经 `onFocusHandled` 清除，所以之后用户在历史里自己选的范围不会被下一次挂载改回去。窄布局（手机）不渲染右侧面板，因此该行和仓库行一样 `disabled`。
预览：`mock.html?resources=sample|empty&theme=light|dark&lang=zh|en`。

## Provider icons

A built-in provider (内置供应商) is drawn with its own brand mark, and with a
neutral glyph when there is no brand to draw — never with nothing, so a provider
list keeps one visual rhythm. `components/provider-icon.tsx` is the only place
that decides; it is keyed by the **SDK's** provider id, so a built-in FastVibe
starts offering is already covered the day it appears.

- The marks are **vendored from LobeHub's icon set** (https://lobehub.com/icons,
  MIT), each icon's `Mono` variant only — the one drawn to work on any background.
  They are inlined `currentColor` paths rather than `<img src>`, exactly like
  `agent-brand-icon.tsx` and for the same reason: a monochrome mark that follows the
  theme beats a raster asset that pins a palette colour (see the theming rules).
- Two providers match nothing on purpose: `radius` (a pi-only gateway) and any
  `custom-…` provider, which has no brand at all. Both get the fallback glyph,
  muted so it does not read as a logo.
- It appears wherever a provider is *presented*: 设置 → 供应商's list and detail
  header, 添加供应商's 内置供应商 picker, the composer's model submenus, and
  设置 → 供应商 → 默认模型. Not in the model picker, where every row is one
  provider by definition, nor in 使用统计, which is a model breakdown.
- The mark is drawn at **14px** (`size-3.5`) *with its artwork inset* — the `viewBox`
  is grown to `-2 -2 28 28`, so a mark drawn to LobeHub's full 24-unit grid occupies
  24/28 of the box. The box matches the fallback glyph and the neighbouring rows
  (so labels do not shift), while the inset is what makes a logo and the outline
  glyph look the **same size**. Both numbers are load-bearing: a filled mark filling
  100% of a box that a Hugeicons stroke icon only fills ~92% of reads distinctly
  larger than the icon beside it, and that is what made the first pass look oversized.
  Do not "fix" either one on its own.

## Theming

The app ships light **and** dark themes; never assume light.

- `src/renderer/src/lib/themes.ts` is the single source of truth. It holds twenty-four
  first-party themes (twelve light, twelve dark) modelled on the most-installed VS
  Code themes — GitHub, One Dark Pro, Dracula, Tokyo Night, Catppuccin, Nord,
  Night Owl, Gruvbox, Monokai, Rosé Pine, Ayu, Everforest, Solarized, Quiet Light —
  plus the Codex desktop and Claude Code palettes.
  Each theme is a compact `ThemeSeed`; `buildTokens` derives the full
  shadcn / Base UI token set from it (`--background`, `--primary`, `--sidebar-*`,
  `--warning/--success/--info`, `--code-*`, …), plus `--destructive-foreground` for the text
  drawn on a filled destructive surface (the title bar's close button), which every theme wants
  the same near-white.
- `applyTheme` writes every token as an **inline** custom property on `<html>` and
  toggles the `dark` class. Inline properties outrank the `.dark` fallback block in
  `index.css`; the `dark` class keeps Tailwind `dark:` variants working. `App.tsx`
  calls `useThemeSync()` to apply the store live and to follow the OS while
  `themeMode` is `"system"`.
- Light and dark are chosen independently: `settings.lightTheme` / `settings.darkTheme`,
  with `settings.themeMode` (`light | dark | system`) picking the active one. The
  pickers live in Settings → 通用 → 外观 (`components/settings/theme-select.tsx`).
- **Never hardcode palette colours** in product code. Use semantic utilities
  (`bg-background`, `text-muted-foreground`, `border-border`, `text-warning`, …) so
  every theme works. `bg-white` is only acceptable for surfaces that are meant to be
  paper (rendered HTML/PDF previews).
- To add a theme, append a `ThemeSeed` to `SEEDS` in `themes.ts` and list its id in
  `LIGHT_THEME_IDS` / `DARK_THEME_IDS`. No CSS changes required.

## 浮动侧栏（所有主题）

Above the narrow breakpoint the sidebar, the right pane and the settings list float as
rounded panes inset 8px from the window edge, in every theme (`index.css`, Floating panes;
`[data-slot="panel-frame"]` / `.floating-pane`). A pane is the theme's `--sidebar` with its
`--sidebar-border` hairline, clipped (`overflow: hidden`) so a terminal or file tree inside
cannot square its corners. The inset is a **transparent border, never a margin** — the
panels size and animate their frame by `width`, which a margin would overflow. The traffic
lights sit at `WINDOW_BUTTON_POSITION` (`{24,24}`) to stay inside the sidebar pane's first
row, and the conversation column takes the same 8px at the top. Maximised, that column is
gone, so the two facing insets would stack into 16px; the side pane sets
`data-against-sidebar` and shifts left by one inset, and the panel's overflow clips the
transparent border, leaving the same 8px. The sidebar is not widened — its width is a
preference, and growing it would jump on maximise. Below the breakpoint the
sidebar is the full-viewport drawer and none of this applies.

## 玻璃效果（Glass）

设置 → 通用 → 外观 → **玻璃效果** (`settings.glass`, on unless `false`) draws the window over
the macOS blur, in whichever theme is active — it is a treatment of a theme, not a theme. It
is only offered where there is a blur to show (`HAS_VIBRANCY`). `src/shared/glass.ts`
(`isGlassEnabled`) is the one reading of the key both halves use, so a missing key means
"on" to Main and to the renderer alike.

- **Main derives it from settings, the renderer is not asked.** `windowIsGlass` reads the
  key, so a new window is created with `vibrancy: "under-window"` and a fully transparent
  fill, and `paintWindows` (every settings write) turns it on or off. No IPC method exists
  for it, so there is nothing for a remote client to forge.
- **`visualEffectState: "active"` is on every macOS window, and it is most of the effect.**
  macOS flattens a vibrant window to plain grey the moment it loses focus — which is how a
  glass window is usually seen, beside whatever has focus — and the option is creation-only,
  so it cannot wait for the setting. `transparent: true` is *not* needed (measured: the blur is
  identical without it) and is avoided because it costs the native window shadow.
- **The page's alpha is a balance** (`--background` 42% dark / 46% light). Lower and the
  text of whatever window is behind starts competing with the app's own; at 50–70% the page
  hides the material. Judge it over something colourful — over a white or dark window every
  setting looks like flat grey. `glassTokens` derives it from each theme's own seed, so every
  theme has a glass form with no per-theme tuning.
- **The renderer only goes translucent where there is a blur to show** (`HAS_VIBRANCY`: a
  desktop window on macOS that is actually Electron — the preview harness reports `darwin`
  too). Elsewhere every theme keeps its solid palette.
- **Floating layers are much more opaque than the panes** (`glass-overlay`: 84% dark / 90% light). Menus, popovers and
  dialogs hold the densest text on screen and float over whatever the page shows; at the 62–70% they once had, a chip or a
  paragraph behind a list read straight through it. The page's own alpha is a balance, a floating layer's is not.
- **Fills stack, so only the bottom layer is a real alpha.** `body` is transparent under
  `data-glass`, the app root paints `--background` once, and `glassTokens` makes the sidebar
  and cards tints *over* that layer. `--code-bg` stays solid, since the terminal reads it.
- **Liquid Glass is CSS on top of that blur** (`index.css`, the Liquid Glass block). Electron
  has no `NSGlassEffectView`, so the macOS 26 look is approximated: the floating panes turn
  to glass (`--glass-pane`, an inner sheen), glass edges carry a specular rim (`::after`, a
  mask-cut gradient ring; add `.glass-rim` to a bordered card for the same — it fades out
  under `:focus-within` so the focus ring drawn on that border stays whole), and
  `.overlay-surface` layers become translucent, rounder glass — so a floating layer drawn by
  hand (the selection toolbar was one) has to carry that class or it stays a solid card.
- **The rim rule rewrites `position`, so a library-positioned surface must opt out by class.**
  `html[data-glass="true"] .overlay-surface:not(.fixed, .absolute) { position: relative }` gives
  the rim something to lay out against, and it is unlayered CSS with three conditions — it
  outranks a vendor stylesheet's single attribute selector. The toast is the one surface whose
  position comes from a rule rather than a class or an inline style, so under glass sonner's
  `position: absolute` lost, every toast fell back into normal flow, and the deck became a
  column of blank cards (the ones behind the front toast hide their content on purpose). The
  toast therefore carries `absolute` in `classNames.toast` purely to be excluded; a `fixed`
  dialog and an `absolute` popover already do the same. `test/toast-stacking.test.ts` pins both
  halves, because either side alone fixes nothing and neither side fails loudly.
- **A pinned prompt cuts the reply, it does not cover it.** Elsewhere the sticky prompt's
  solid band hides what scrolls under it while matching the surface it sits on: `--thread-band`
  (message-list.tsx, defined in index.css) is the page (`--background`) in the conversation
  column and the pane fill (`--sidebar`) inside a floating pane — painted `--background` in a
  pane it read as a lighter slab behind the bubble. Under glass the row paints nothing, and
  `pinRegistryFor` masks the reply rows of the pinned turn off at the prompt's lower edge
  (`GLASS_CUT_FEATHER`), in the same read-then-write pass that decides which prompt is pinned.
  The mask follows how far sticky has moved the prompt off its own place, not `pinned`: pushed
  away by the next turn, a prompt leaves the top edge but rides out lying on its reply's last
  rows, and those must stay cut until the turn is gone.
- **The same goes for anything tucked under a card.** The follow-up queue slides 1.75rem under
  the input card and relies on the card's fill to hide that part; under glass `.composer-tray`
  is masked to the card's outline instead (`index.css`). A new panel that tucks under a
  translucent card needs its own cut.
- **Settings hides the shell instead of covering it.** The overlay is translucent like
  everything else, so while it is open `[data-shell-split]` and the browser guest layer are
  `visibility: hidden` (not unmounted). A new full-window overlay needs the same treatment.
- **The README and the marketing site show it from the browser harness.** `mock.html?desktop=1`
  paints a wallpaper, makes `#root` a floating window whose own `backdrop-filter` stands in
  for the material, and reports `simulatedVibrancy` on the bridge so `HAS_VIBRANCY` lets glass
  on — the only way a browser (or a capture) can show it. The marketing site (its own private
  repository, `tyuan511/fastvibe-services`) loads this same page in its hero iframe and takes
  its product screenshots from it; both pass `desktop=1`, and the window is concentric with
  the panes (24px radius = 8px inset + 16px pane radius), so keep the two in step.
- **The README hero is one frame of that scene cut on a diagonal** (`node
  scripts/capture-readme-hero.mjs` → `docs/images/workspace-{en,zh}.webp`): light on the left
  of the line, dark on the right. Both halves come from **one page load** — the theme is
  switched in place with the same `fastvibe-website-theme` message the site's own iframe
  answers — because the fixture is still unfolding while it settles, so two loads of one URL
  are two different moments and the seam would land on a sidebar row in one half and on
  nothing in the other. The compositing is a canvas in the browser rather than an image tool:
  Chromium is the only thing here that writes WebP, and the seam wants its antialiased clip
  anyway.

## Type scale & interface size

- **Use Tailwind's own `text-*` utilities** (`text-xs` / `text-sm` / `text-base` /
  `text-xl` / `text-2xl`), never arbitrary `text-[13px]` values. shadcn Nova's
  primitives are authored against that same scale, so product code that invents
  its own sizes drifts away from the components it composes. Conversation text is
  `text-sm`: the message body **and** everything a tool call renders (the summary
  row, output/parameter blocks, diffs, thinking, todo and question cards) so the
  transcript reads at one size. `text-xs` is for chrome — timestamps, chips,
  badges, menus, dense stats.
- The UI sans is **Instrument Sans** (bundled, OFL), set once as `--font-sans`. There is
  no font picker. Chinese is not in that face, so it falls through to the system sans
  (苹方 on macOS). Code stays `--font-mono`.
- Sizes are **rem-based** and the root font size is a setting: 通用 → 外观 →
  界面字号 writes `--ui-root-font-size` inline on `<html>`, and `html { font-size:
  var(--ui-root-font-size, 16px) }` turns that one number into an interface-wide
  scale (`applyUiFontSize` in `themes.ts`, called from `useThemeSync` and before
  mount in `main.tsx`). At the 16px default the `text-sm` body is 14px. Fixed px
  sizes do **not** follow it — prefer Tailwind spacing/`rem` (e.g. `h-3.5`, `w-70`)
  over `h-[14px]` for anything that must scale.
- Two exceptions need px by nature: xterm's `fontSize` (derived from the resolved
  root size in `side-pane-terminal.tsx`) and container-query breakpoints, which are
  written in `rem` (`min-[27.5rem]`) so they track the setting too.
- 消息宽度 (设置 → 通用 → 外观, `settings.messageWidth`) is the transcript rail's
  max-width: `default` is the `max-w-3xl` (48rem) reading column, `wide` is 56rem,
  `widest` caps at 100% of the column — never beyond — so the rail's own `px-6` is
  the only margin. It applies as
  `--chat-column-max` on `<html>` (`applyChatMessageWidth` in `lib/chat-layout.ts`,
  applied live by `useThemeSync` and pre-mount in `main.tsx`), and the shared rail
  class `CHAT_COLUMN_CLASS` (`chat-column mx-auto w-full px-6`) reads it — composer,
  todo/goal/widget rows, a raised permission panel and the new-session hero all ride
  the same rail, so they move together. Assistant process rows keep their own
  `max-w-2xl` cap on purpose; the setting widens the message text, not every card.

## 滚动条（原生和 ScrollArea 画成同一根条）

`index.css` 的 `::-webkit-scrollbar` 规则（在 `@layer base` 里）给所有**原生**滚动条画上
ScrollArea 那一根：11px 轨道、2px 透明边框 → 7px 圆头、透明轨道、`--scrollbar-thumb`，
hover 变深；Windows/Linux 的步进按钮关掉（7px 的轨道放不下它们）。ScrollArea 自己的条用
`[data-slot="scroll-area-*"]` 匹配，**故意留在 layer 外**——那才是它盖过 thumb 上 `bg-border` 的理由。

- **一个属性就能悄悄退回原生**：元素上出现 `scrollbar-width` 或 `scrollbar-color`（非 `auto`），
  Chromium 就忽略该元素的全部 `::-webkit-scrollbar` 规则，重画平台滚动条（实测 thin 11px、
  classic 15px：方的，且不上我们的色）。所以这两个属性在 renderer 源码里一处都不许出现——
  `test/scrollbar-styling.test.ts` 连 Tailwind 的 `scrollbar-thumb-*` / `scrollbar-track-*` 工具类
  一起抓，因为它们正是 `scrollbar-color` 的简写：`transcript-gutter` 里的 `scrollbar-width: thin`
  和 viewport 上的 `scrollbar-thumb-scrollbar` 就是这样把聊天区那根最显眼的条打回原形的。
- `scrollbar-gutter: stable` 单独用是安全的：它预留的是**被美化后**的宽度（实测 11px 作者宽度 →
  11px 槽），所以 `transcript-gutter` 只留 gutter 不留 width，转写与 composer 的对齐照旧。
  转写里那些限高的折叠正文（`PROCESS_BODY_CAP`，见 [转写呈现中的折叠运行过程](transcript.md)）也留：我们的条**占布局宽度**，
  不留槽的话竖条一出现就抽走 11px，行变窄、横向条闪出来，而且只在展开/收起那一瞬看得到。
  composer 的两层（`.chat-editor-layer`）同理：一层用 `scrollbar-color` 假装透明、一层被美化，
  15px 对 11px，高亮就会从文字上滑走——要透明就画透明（`::-webkit-scrollbar-thumb`）。
- 自动滚动时转写的 thumb 画成透明（`[data-autoscrolling]`，由 `@shadcn/react` 的 message scroller
  设置），这条也放在 `@layer base`、hover 规则之后：宽度不变，只是那一段时间里看不见。
- 真的要**没有**滚动条就用 `no-scrollbar`（`shadcn/tailwind.css` 提供）——那是唯一欢迎平台
  规则的地方，因为它要的是「不画」。

## 语言 / i18n

设置 → 通用 → 语言 has two independent picks, both `zh | en`:

- **界面语言** (`settings.uiLanguage`) drives every string the user reads. The
  renderer uses **i18next + react-i18next** (`src/renderer/src/lib/i18n.ts`).
  Namespaces live in `src/renderer/src/locales/{zh,en}/{common,app,chat,settings,sidepane}.json`.
  Components call `useTranslation("<ns>")`; shared lib modules call `i18n.t` at
  render/event time so they never freeze the language of module load. `applyUiLanguage`
  stamps `<html lang>` and is applied pre-mount in `main.tsx` (like the theme) and
  live via `useLanguageSync`. An existing install without the key keeps 中文; a
  brand-new install follows the OS locale (`detectSystemLanguage`).
- **AI 偏好语言** (`settings.aiLanguage`) is injected on every turn by the built-in
  `output-language` extension (`before_agent_start` appends a language requirement
  to the system prompt). Main owns the wording (`src/main/engine/ai-language.ts`)
  and writes it to `FASTVIBE_AI_LANGUAGE_PROMPT`; the extension just appends whatever
  it finds, re-read per turn so a settings change lands in a running session.
  Subagent sessions (`noExtensions`) get the same sentence via `appendSystemPrompt`.
  User-facing engine/extension copy follows `FASTVIBE_UI_LANGUAGE` (`uiText` in
  `src/main/engine/ui-text.ts`).

Both values are written to `settings.json` with the other prefs. Main syncs the env
vars on every settings write (`applyLanguages`) and at startup.

Do **not** hardcode user-visible copy in product components. Add a key to the matching
namespace JSON (zh value byte-identical to the original Chinese) and render it with
`t(...)`. Language picker labels (`简体中文` / `English`) stay untranslated on purpose.

## 设置里的描述只写「做什么」，不写「为什么」

A settings row is a label, one line saying what the switch does, and the control. It is
not the place to explain how the feature works: that reasoning belongs in the code's own
comments and in this file, where the next person to touch it will read it, and a pane that
repeats it reads as documentation rather than as a set of switches. `test/settings-copy.test.ts`
holds the line — every string in `settings.json` is capped (130 characters of Chinese, 150
of English; Chinese says the same thing in ~3/4 the length), and it fails on a new
paragraph before it is ever looked at on screen.

The same pass removed copy that names a *file inside the data directory* — 「写入 FastVibe
独立的数据目录，不写入你自己的 ~/.pi」, 「读取 ~/.pi、~/.claude、~/.codex 的数据」 — since
the reader does not know where `~/.pi` is or that it matters. Say what happens, not where
it is stored.

Nothing is exempt from the cap: an instruction that outgrows a row belongs in the docs, not the pane.

## Routing

`react-router` with **`HashRouter`** (wrapped in `src/renderer/src/main.tsx`). The
production renderer is loaded over `file://` via `window.loadFile`, so path-based
history has nothing to fall back to — a reload on `/settings/providers` would 404.

- `#/` — the workspace shell (sidebar + thread + composer). Always mounted.
- `#/c/<id>` — a conversation. Switching chats, new chats, and the sidebar's
  back/forward buttons walk this as real HashRouter history (mouse side buttons too).
- `#/settings/extensions` — plugin management inside Settings, directly below 技能.
  The old `#/plugins` URL redirects here.
- `#/settings/<section>` — a settings pane, rendered **over** the shell so app state
  survives. Sections come from `SETTINGS_SECTIONS` in `settings-sections.tsx`;
  `App.tsx` derives the valid set from that export, so adding a pane needs no routing change.
  Section switches `replace`; opening settings pushes, so back returns to the chat.
- Unknown or missing sections normalise to `#/settings/general` via a redirect effect
  in `App.tsx`.
- To deep-link into a pane, `navigate("/settings/providers")`. The composer's
  「添加模型 / 管理模型」 entry uses this to reach provider configuration.
- Every pane draws its rows through `settings-group.tsx` (`SettingsGroup` /
  `SettingsRow`): a card of label + one-line description + control on the right, with a
  divider between rows. A pane that hand-rolls its own row drifts in padding, type
  scale and control alignment — 关于's cells did, and had to be rebuilt on these.

## 标题栏（Windows / Linux）

macOS insets its traffic lights into the app's own first row (`titleBarStyle: "hiddenInset"`),
so the sidebar's `h-11` row is built around them: the clearance, then 收起侧边栏 /
后退 / 前进, with the logo and wordmark on the row below. Neither of the other two has anything
to inset, and a native title bar above an app that already has a top row is two bars with one of
them empty.

So on Windows and Linux FastVibe draws the whole bar itself
(`components/layout/title-bar.tsx`): the brand, 后退 / 前进, and minimise / maximise / close —
one `h-10` row above the sidebar/main split, whose single switch is `HAS_CUSTOM_TITLE_BAR`
(`lib/platform.ts`). A bar **spanning the window**, rather than controls floated over whichever
row happens to reach the top-right corner, is what keeps the window controls out of the side
pane's tab strip: the split layout below simply starts at y=40. Its height lives in
`lib/window-chrome.ts`, because the settings overlay starts below it too (`top-10`) and the two
must not drift.

- **Every control sits on the thing it acts on.** The brand and history — the window's own
  furniture — ride the bar; 收起侧边栏 and 搜索 are the sidebar's top row, beside the panel they act
  on. 搜索 is that row's right end on **both** platforms, which is also what keeps it off the path
  a pointer takes to 最小化. macOS reaches the same arrangement from the other side: its bar is a
  traffic-light row with no room for a logo, so the brand leads the sidebar's top row there
  instead (and 收起 / 后退 / 前进 sit in the traffic-light row above it). A brand that moved
  between the two bars per platform is the one thing that would make the layouts read as
  different apps.
- **Windows' own caption metrics.** 46px of hit area per control, squared off and flush to the
  corner, a fixed px width (the OS does not scale its caption buttons with a font preference), and
  close as the only one with a colour of its own (`hover:bg-destructive`).

- **Main goes frameless.** `titleBarStyle: "hidden"` (plus `frame: false` on Linux, where the
  window manager is the unpredictable part), so the native bar is gone and ours is the only one.
  The controls are hand-drawn rather than `titleBarOverlay`'s native ones: those cannot be
  previewed in a browser, cannot follow the theme, and would land on the tab strip anyway. Main
  exposes `window:minimize` / `window:toggle-maximize` / `window:close` — each acting on the
  window that asked — plus a `window:state` push, because the OS can maximise too (snap,
  double-click, a window-manager key), so the glyph is not derivable from our own clicks.
- **The platform comes from the preload, not the user agent.** `app.platform` is a plain string on
  the bridge, read before the first paint, and the renderer reads it through
  `lib/platform.ts`.
- **Chrome flags and the keyboard flag.** `HAS_TRAFFIC_LIGHTS` and `HAS_CUSTOM_TITLE_BAR` describe
  the window around the page; `IS_MAC` describes the modifier key. All three come from the host
  platform now that the renderer only runs in the desktop window. A layout inset (`pl-22` on the
  sidebar's own row, and the collapsed header's `calc(5.5rem + 8px)` — that row has no floating
  pane of its own, so it adds back the pane's transparent border) reads the chrome flags; a
  modifier label reads `IS_MAC`.
- **The sidebar always draws its top row; only its left end moves.** macOS leads it with the
  brand (its bar held that); Windows and Linux lead it with 收起侧边栏 (their bar holds the brand
  and the history instead). Where the bar exists, the sidebar's traffic-light row is not drawn at
  all.
- **The way back sits where the panel is not.** 收起侧边栏 lives *in* the sidebar's top row, so
  collapsing takes the control away with it: 展开侧边栏 therefore appears in the main header — and
  in `SidebarCollapsedChrome` when the side pane is maximized — on every platform. Both used to be
  skipped where a title bar exists, back when that bar carried the toggle itself.
- **The settings pane starts below the bar** (`TITLE_BAR_OFFSET`, `top-10`) and drops its own
traffic-light spacer: the window controls have to stay reachable from settings, and its content
must not slide under them.
- **Preview**: `mock.html?platform=win32` (`src/renderer/src/mock/preview.ts`, which also stubs
  the window API) renders the whole thing in a browser — how the layout was checked without a
  Windows machine.

## macOS 菜单栏（`src/main/app-menu.ts`）

只有 macOS 装菜单栏。Windows / Linux 的窗口是自己画的标题栏（上面那一节），原生菜单栏会盖在
那一行上，所以那两个平台仍然只有渲染层的快捷键分发器。

- **存在的理由是「设置」在 Mac 上根本没有入口。** 实测 Electron 44 的默认菜单：app 菜单只有
  About / Services / Hide / Quit，**没有 Preferences 行也没有 ⌘,**；View 里倒是带了重新加载和
  开发者工具。现在 app 菜单是 关于 FastVibe / 设置… / Services / 隐藏 / 退出，文件·视图·窗口·帮助
  都是产品自己的命令（关于、快捷键… 只是导航到设置面板，官网走 `shell.openExternal`）。
  重新加载 / 强制重新加载 / 开发者工具只在 `!app.isPackaged` 时画。
- **标签是 Main 的（`uiText`），按键是渲染层的。** 角色项保留 Electron 自己的本地化（跟随系统
  语言），自定义标签跟随 界面语言，所以 `commitSettings` / `settingsClear` 在 `applyLanguages` 之后
  调 `refreshApplicationMenu()`。窗口把 `resolveBindings()` 的结果经 `menu:sync`（`native` 能力、
  远程拒绝）交给 Main，Main 注册之后**回答它接管了哪些命令**，渲染层把那几个 id 从自己的分发器里
  跳过 —— 菜单的 accelerator 在按键到达页面前就被系统吃掉，一个命令答两次就是一个开关被拨回原地。
  没有菜单的平台（Windows / Linux / `mock.html` 预览 / 远程被拒）回答空集合，页面照旧全管。
- **录制新快捷键时菜单必须松手。** `beginShortcutRecording` / `end` 会通知监听者（`onShortcutRecordingChange`），
  于是同步发出去的是空绑定；否则正在录的那一个键会被菜单吃掉，`设置 → 快捷键` 就再也录不进任何
  已被占用的组合。
- **`chordToAccelerator` 是白名单，不是转写。** 实测 `Menu.buildFromTemplate` 对 `Cmd+Foo`、`Cmd++`、
  `Cmd+Nonexistent-Key` 一律照收并原样回显 —— 校验不存在，界面只会显示一个永远按不出来的快捷键。
  没有修饰键的 chord（裸 `escape` / `enter` / `tab`）一律返回 `null`：那是菜单里最糟的一种抢键。
- **`menu:action` 和 `window:state` 一样直接 `webContents.send`**（目标是聚焦窗口，退到第一个活着的），
  不进广播中枢：它只属于这台机器的窗口，远程端没有要它的；`remote-events.ts` 仍把它列进 `drop` 说明意图。
- 验证：`test/menu-commands.test.ts` 钉住映射表、sanitize 的取舍，以及除了 关于 / 快捷键… 之外每个菜单
  命令都必须出现在 `SHORTCUT_CATALOG` 里（否则菜单会提供一个没人能执行的条目）。

## 侧标「已完成但未读」（`Conversation.unread`）

「跑完了但没人看过」是一个事实，不是一个事件，所以它写在 catalog 行上（`fastvibe.db` 的 `conversations`），
不是渲染层的一张 Map —— 重载、重启、第二个窗口和手机都要能答同一个问题。`failedInBackground` 仍旧是
内存里的瞬时标记，因为它的说法本来就是「刚才那次异常结束没被看见」，不是一句可以活过重启的断言。

- **谁标它**：`process-manager` 在 `agent_settled` 递出 `conversation_activity` 时，如果这条会话不是屏幕上的
  那一条（`#activeId`）且结论是 `completed`，就 `catalog.markUnread(id)`。用户自己按的停止、`立即`、重复保护
  本来就不发 activity，所以也不会标；失败的会话走 `failedInBackground` 那条红色标记，两者不是一回事。
- **谁清它**：`ConversationCatalog.setActive`。打开就是读了 —— 包括「id 没变、只需要把标记摘掉」那一种，
  所以清除写在 early-return 之前（否则就是一个永远摘不掉的圆点）。
- **不碰 `updatedAt`**：`markUnread` 故意不走 `update()`。那个时间戳是 设置 → 归档对话 里的「更新时间」，
  也是自动归档等的东西；看得慢不是对会话的修改，不该把它推出这两个窗口。
- **界面上**：会话行最右侧一个 primary 小圆点，排在 等你 / 运行中 / 异常停止 之后（最低优先级：一个还
  在动、还在等人的会话不是「读者已经读完」的会话）。圆点不会丢：除了打开会话没有东西清它，所以运行标记一下
  去它就自己回来。项目文件夹行聚合同样的两个标记，**且允许同时出现**（它们来自不同会话，藏掉任何一个都是
  假信息）：里面有运行中的就画 `RunningMark`，有未读的就画圆点。
- **文件夹的标记只在收起时画**（`!open && (runningTasks > 0 || unreadTasks > 0)`）。展开着的时候，那些
  正在跑、那些没人读的会话就列在下面的行里，各自在最右列（同一个 `size-6` 列）带着自己的 spinner 和圆点，
  文件夹再来一份聚合只是把同一件事说两遍。触屏同理 —— 下面的行在那儿也照画，所以 `pointer-coarse` 不例外。
  收起时子行看不见，聚合才是文件夹行唯一能说的话。
- **与 hover 的关系**：文件夹行原本就用 `opacity-0` 预留了操作按钮的位置，所以标记是**绝对定位画在那块位置
  之上**而不是插进 flex 流 —— 行尾宽度不变，项目名不会跟着 hover 抖；hover、键盘聚焦、⋯ 菜单展开
  （`group-has-[[data-slot=dropdown-menu-trigger][aria-expanded=true]]/project:hidden`，不能只写 `has-[[aria-expanded=true]]`：
  展开/收起的 `CollapsibleTrigger` 也带这个属性，那样一个刚点过的文件夹就永远看不见标记）时标记消失，
  操作图标出现。触屏上操作按钮是常显的，所以标记 `pointer-coarse:static` 退回流里站在它们旁边 ——
  手机上照样看得见哪个文件夹有活。两个行共用一个 `size-6` 最右列，所以会话的圆点、会话的 spinner 和
  文件夹的标记读起来是一根对齐的柱子。
- **预览**：`mock.html?unread=1`（未读圆点）、`mock.html?unread=1&running=1`（同一个文件夹两种标记）。
- 手机端的行还没画这个字段（它随 catalog 已经到那边了，只是 Rust core 侧不认识）。
- **macOS Dock 角标**：`main/dock-badge.ts` 在 app ready 后读取 gateway 的聚合快照，并观察
  `workspace:changed` 广播，按 `unread === true` 的普通会话去重计数（本地与已绑定远程项目都包含）。
  打开、删除、移除远程绑定后随 catalog 自动减少，零用 `app.dock.setBadge("")` 清除；重启从持久化
  catalog 恢复，不依赖通知事件或系统通知开关，也不因窗口获得焦点就清空。退出时移除观察者。

## 顶层错误边界

`components/error-boundary.tsx` 包在 `main.tsx` 的最外层。渲染期抛错会卸载 React 拥有的
整棵树，而这个项目真的发生过：空模型列表下把 group label 画在 group 之外，Base UI 抛
`MenuGroupContext is missing`，整个窗口变白；typecheck 看不见（它是运行时不变式，不是类型错），
子树也拦不住。边界只做两件有用的事：说清楚出了什么错（含报错文本），以及给一条出路
（重新加载界面；会话与运行都在 Main，重载不丢东西）。错误也写进 `logs/renderer.log`
（`logError`）——React 接管的抛出不会到 `window.onerror`，否则最重要的那次崩溃反而查不到。

## 侧边搜索（命令面板）

侧边栏的 搜索 按钮与 `mod+k` 打开同一个命令面板（`components/layout/command-palette.tsx`），
它一次搜四样东西：会话正文、会话标题/预览/项目名、快捷操作、设置页。

- **正文命中由 Main 提供，标题与预览在渲染层匹配。** `conversations:search` →
  `engine/conversation-search.ts` 逐个读 `sessionFile`，只取 `type: "message"` 行里所有
  `text` 字段（用户消息、回复正文、工具输出；thinking、系统提示与记忆引用块不在内——读者从来没见过
  那些 id，搜到它们只会出一条没来由的命中），返回第一处命中
  附近的摘要。标题/预览/项目名是渲染层拿 catalog 本地匹配的——刚发出的提示词只有 `preview`，
  转写搜索对它还没话说。两路取并集。
- **命中要看得见，这就是 `lib/search-highlight.ts` 存在的理由。** 结果行把关键词画在标题里、
  也画在第二行摘要里（`<mark>` + `bg-warning/30`，不用实心色块：菜单行上的实心高亮会被读成选中）。
  匹配规则与搜索本身同一套：**字面量、大小写不敏感**，所以 `foo.bar` 是那个字符串而不是正则；
  折叠后长度变化的字符（土耳其语 `İ`）直接退化为纯文本，否则索引会整体错位。摘要最多标 3 处——
  单字符查询几乎是每一行的子串，标满就等于把整行涂掉。
- **摘要一律绕开命中处裁切。** Main 已经裁好它那一份；渲染层自己匹配 `preview` 时必须
  用同一个 `clipSnippet`（前 24 / 后 40 字符），否则命中落在预览中段时，画面上就是开头四十个字、
  里面什么都没标。
- **没输入时**只列最近 9 条有 preview 的未归档会话，并带 `mod+1…9` 快捷键；输入后标题命中
  与正文命中混在一起，第二行优先给摘要（那是唯一能看见「为什么命中」的地方），没有摘要才退回项目名。
- 大转写按行读取，不按文件大小跳过；按文件大小和修改时间只重建变化会话的搜索索引，缓存受字符数与行数上限约束，按会话最近更新时间优先准入，冷文件扫描不淘汰更近期的缓存；超限文件只保留当前查询摘要和分支链接。另有有界查询备忘：文件未变时复用相同查询及无命中查询的收窄结果。
- 后端不在归档过滤之前截断命中数；界面可选择「包括已归档对话」，按更新时间排列。命中携带可见消息的 `entryId`（工具输出指向所属回复），跳转复用 `stores/transcript-navigation.ts` 和虚拟列表的消息定位。
- 搜索只沿当前分支读取正文；仍是大小写不敏感的字面子串，不做分词。

## 设置跨窗口同步

偏好写在一份 `settings.json`，但每个窗口各持一份启动时读的内存副本。一处写入后 Main 发
`settings:changed`（`broadcast(..., { except: origin })`，不回传给发起者），接收方的
`applyRemote` 只写 localStorage、**不回写磁盘**——回写会让两个窗口永远互相同步。
「恢复默认」（`settings:clear`）也算一次写入，同样要广播，否则另一个窗口会继续用旧副本
并在下次保存时把刚清掉的值写回去。

**`settings:set` 收到的是整份快照，所以不属于客户端的键不能从快照里取。** 每个窗口保存的都是启动时读到的
那一份，天然是旧的。`proxy*` 和 `remote*` 各有自己的方法写入，`mergeClientSettings`（`shared/settings-merge.ts`）
让这两组键只从文件取：`remote:start` 把 `remoteEnabled` 写进文件时窗口并不知道，下一次无关的保存（拖一下侧栏
就是一次）曾把开关写回窗口打开时的值——监听还在跑所以没人察觉，下次启动（通常是更新之后）远程访问就是关的。
`settings:clear`（恢复默认）同样保留 `remote*`；`remote:start` / `remote:stop` 的写入走 `queueSettingsWrite`，
否则会落在一次保存的「读文件 → await → 写文件」中间被盖掉。新增一个由 Main 自己方法管理的设置键时，照这个办。

## 会话自动归档（`src/shared/auto-archive.ts`）

归档是本地偏好（`settings.archivedConversations`），不是引擎状态；自动归档也活在渲染层：
`lib/auto-archive.ts` 的 `sweepAutoArchive` 读一次 store 里的会话列表和 `settings.autoArchiveDays`，
按 `@shared/auto-archive` 的纯规则算出该归档的 id，再走用户手动归档那条 `archiveConversations`。
规则单独放一个模块，是为了让它能像其它纯逻辑一样被单测枚举，而不是在界面上被发现。

- **时间看 `updatedAt`，不看 `createdAt`。** 它是 catalog 的「最后变动」，提示词预览、改名、绑定项目、
  打开会话都会刷新，也正是归档面板展示的「更新时间」：30 天前建、昨天还在用的会话不是陈旧的。
- **五种会话不碰**（`staleConversationIds`）：辅助对话（在右侧面板，不属于侧栏）、没有 preview 的空草稿
  （新对话要复用它）、正在跑的（把忙着的会话藏到用户够不到的行后面，正是手动归档那条路刻意避开的）、
  当前打开的（行消失会让打开的会话在侧栏无迹可寻）、置顶的（置顶就是「留在我看得见的地方」，
  而置顶在 localStorage 里，所以读取它的 `lib/pinned.ts` 从侧栏组件里提了出来）。
  边界是 `< cutoff`：正好 N 天算还在窗口内。
- **调度在 `App.tsx`**：workspace 加载完跑一次，之后每小时一次，覆盖应用一直开着跨过门槛的情况；
  effect 以时间设置为依赖，所以在 设置 → 归档对话 里把时间改小会立刻扫一次。
  一批只提示一次，带和手动归档一样的「撤销」——会话从用户正在看的列表里消失不该无声无息，
  去处是 设置 → 归档对话。撤销只还原本批 id，不碰以后新归档的。
- **设置是 `autoArchiveDays`，默认 30，`0` 是永不；可选 3、7、14、30、90、180 或 365 天。** 选单在 设置 → 归档对话；手机写的
  `settings:set` 是部分快照，这个键不会被它清掉。
- **不做的**：没有后台服务，应用没运行时什么都不会发生；原生移动端还没有这个设置项。
