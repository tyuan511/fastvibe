/**
 * Theme system.
 *
 * Twenty-four first-party themes — twelve light and twelve dark — modelled on
 * the most installed VS Code colour themes (GitHub, One Dark Pro, Dracula,
 * Catppuccin, Tokyo Night, Solarized, Quiet Light, …) plus the Codex desktop
 * and Claude Code palettes. Each theme is a compact
 * seed palette; the full shadcn / Base UI token set is derived from it by
 * `buildTokens`, so a theme only has to describe its intent.
 *
 * Applying a theme writes every token as an inline custom property on <html>.
 * Inline properties outrank the `.dark` fallback block in index.css, and we
 * toggle the `dark` class at the same time so Tailwind's `dark:` variants keep
 * working for the shadcn primitives.
 *
 * Light and dark are chosen independently (`lightTheme` / `darkTheme`); the
 * active one is picked by `themeMode` (explicit light, explicit dark, or system).
 */

export type ThemeKind = "light" | "dark";
export type ThemeMode = "light" | "dark" | "system";

export type ThemeId =
  // dark
  | "github-dark"
  | "one-dark-pro"
  | "dracula"
  | "tokyo-night"
  | "catppuccin-mocha"
  | "nord"
  | "night-owl"
  | "gruvbox-dark"
  | "monokai"
  | "rose-pine"
  | "codex-dark"
  | "claude-dark"
  // light
  | "github-light"
  | "one-light"
  | "catppuccin-latte"
  | "solarized-light"
  | "quiet-light"
  | "ayu-light"
  | "gruvbox-light"
  | "everforest-light"
  | "night-owl-light"
  | "rose-pine-dawn"
  | "codex-light"
  | "claude-light";

/** The raw palette a theme is built from. */
export type ThemeSeed = {
  /** Name shown in the picker. */
  label: string;
  /** Upstream theme family, shown as a subtitle. */
  source: string;
  kind: ThemeKind;
  /** App background. */
  bg: string;
  /** Primary text. */
  fg: string;
  /** Cards, popovers, dropdowns. */
  surface: string;
  /** Hairlines, dividers, input outlines. */
  border: string;
  /** Raised/secondary fill: hover, selection, chips. */
  muted: string;
  /** Secondary text. */
  mutedFg: string;
  /** Brand colour: buttons, links, focus rings. */
  accent: string;
  /** Text drawn on top of `accent`. */
  accentFg: string;
  destructive: string;
  warning: string;
  success: string;
  /** Sidebar surface; defaults to `surface`. */
  sidebar?: string;
  /** Sidebar hover/selection fill; defaults to `muted`. */
  sidebarMuted?: string;
  /** Code-block surface; defaults to `muted`. */
  codeBg?: string;
  /** Syntax highlighting for chat code fences. */
  syntax: { keyword: string; string: string; comment: string; number: string };
  /** Five chart series; defaults to the seed's syntax colours. */
  charts?: [string, string, string, string, string];
};

export type ThemeTokens = Record<string, string>;

export type ThemeDefinition = ThemeSeed & {
  id: ThemeId;
  tokens: ThemeTokens;
};

function buildTokens(seed: ThemeSeed): ThemeTokens {
  const sidebar = seed.sidebar ?? seed.surface;
  const sidebarMuted = seed.sidebarMuted ?? seed.muted;
  const codeBg = seed.codeBg ?? seed.muted;
  const charts = seed.charts ?? [
    seed.accent,
    seed.syntax.keyword,
    seed.syntax.string,
    seed.syntax.number,
    seed.mutedFg,
  ];
  return {
    background: seed.bg,
    foreground: seed.fg,
    card: seed.surface,
    "card-foreground": seed.fg,
    popover: seed.surface,
    "popover-foreground": seed.fg,
    primary: seed.accent,
    "primary-foreground": seed.accentFg,
    secondary: seed.muted,
    "secondary-foreground": seed.fg,
    muted: seed.muted,
    "muted-foreground": seed.mutedFg,
    accent: seed.muted,
    "accent-foreground": seed.fg,
    destructive: seed.destructive,
    "destructive-foreground": "oklch(0.985 0 0)",
    border: seed.border,
    input: seed.border,
    ring: seed.accent,
    warning: seed.warning,
    success: seed.success,
    info: seed.accent,
    sidebar,
    "sidebar-foreground": seed.fg,
    "sidebar-border": seed.border,
    "sidebar-primary": seed.accent,
    "sidebar-primary-foreground": seed.accentFg,
    "sidebar-accent": sidebarMuted,
    "sidebar-accent-foreground": seed.fg,
    "sidebar-ring": seed.accent,
    "chart-1": charts[0],
    "chart-2": charts[1],
    "chart-3": charts[2],
    "chart-4": charts[3],
    "chart-5": charts[4],
    "code-bg": codeBg,
    "code-inline-bg": `color-mix(in oklab, ${seed.fg} 8%, transparent)`,
    "code-keyword": seed.syntax.keyword,
    "code-string": seed.syntax.string,
    "code-comment": seed.syntax.comment,
    "code-number": seed.syntax.number,
  };
}

const SEEDS: Record<ThemeId, ThemeSeed> = {
  /* ------------------------------------------------------------------ dark */

  "github-dark": {
    label: "GitHub Dark",
    source: "GitHub Theme",
    kind: "dark",
    bg: "#0d1117",
    fg: "#e6edf3",
    surface: "#161b22",
    border: "#30363d",
    muted: "#21262d",
    mutedFg: "#9198a1",
    accent: "#2f81f7",
    accentFg: "#ffffff",
    destructive: "#f85149",
    warning: "#d29922",
    success: "#3fb950",
    sidebar: "#010409",
    sidebarMuted: "#161b22",
    codeBg: "#161b22",
    syntax: { keyword: "#ff7b72", string: "#a5d6ff", comment: "#8b949e", number: "#79c0ff" },
    charts: ["#2f81f7", "#3fb950", "#d29922", "#f778ba", "#a371f7"],
  },
  "one-dark-pro": {
    label: "One Dark Pro",
    source: "One Dark Pro",
    kind: "dark",
    bg: "#282c34",
    fg: "#abb2bf",
    surface: "#21252b",
    border: "#3e4451",
    muted: "#2c313a",
    mutedFg: "#828997",
    accent: "#61afef",
    accentFg: "#1b1e24",
    destructive: "#e06c75",
    warning: "#d19a66",
    success: "#98c379",
    sidebar: "#21252b",
    sidebarMuted: "#2c313a",
    codeBg: "#21252b",
    syntax: { keyword: "#c678dd", string: "#98c379", comment: "#5c6370", number: "#d19a66" },
    charts: ["#61afef", "#98c379", "#d19a66", "#c678dd", "#56b6c2"],
  },
  dracula: {
    label: "Dracula",
    source: "Dracula Official",
    kind: "dark",
    bg: "#282a36",
    fg: "#f8f8f2",
    surface: "#21222c",
    border: "#44475a",
    muted: "#343746",
    mutedFg: "#9ea6c8",
    accent: "#bd93f9",
    accentFg: "#21222c",
    destructive: "#ff5555",
    warning: "#ffb86c",
    success: "#50fa7b",
    sidebar: "#21222c",
    sidebarMuted: "#343746",
    codeBg: "#21222c",
    syntax: { keyword: "#ff79c6", string: "#f1fa8c", comment: "#6272a4", number: "#bd93f9" },
    charts: ["#bd93f9", "#50fa7b", "#f1fa8c", "#ff79c6", "#8be9fd"],
  },
  "tokyo-night": {
    label: "Tokyo Night",
    source: "Tokyo Night",
    kind: "dark",
    bg: "#1a1b26",
    fg: "#c0caf5",
    surface: "#16161e",
    border: "#292e42",
    muted: "#24283b",
    mutedFg: "#828bb8",
    accent: "#7aa2f7",
    accentFg: "#1a1b26",
    destructive: "#f7768e",
    warning: "#e0af68",
    success: "#9ece6a",
    sidebar: "#16161e",
    sidebarMuted: "#24283b",
    codeBg: "#16161e",
    syntax: { keyword: "#bb9af7", string: "#9ece6a", comment: "#565f89", number: "#ff9e64" },
    charts: ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff"],
  },
  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    source: "Catppuccin",
    kind: "dark",
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    surface: "#181825",
    border: "#313244",
    muted: "#313244",
    mutedFg: "#a6adc8",
    accent: "#cba6f7",
    accentFg: "#1e1e2e",
    destructive: "#f38ba8",
    warning: "#fab387",
    success: "#a6e3a1",
    sidebar: "#181825",
    sidebarMuted: "#313244",
    codeBg: "#181825",
    syntax: { keyword: "#cba6f7", string: "#a6e3a1", comment: "#6c7086", number: "#fab387" },
    charts: ["#cba6f7", "#a6e3a1", "#fab387", "#89b4fa", "#f38ba8"],
  },
  nord: {
    label: "Nord",
    source: "Nord",
    kind: "dark",
    bg: "#2e3440",
    fg: "#d8dee9",
    surface: "#3b4252",
    border: "#4c566a",
    muted: "#434c5e",
    mutedFg: "#9aa5b8",
    accent: "#88c0d0",
    accentFg: "#2e3440",
    destructive: "#bf616a",
    warning: "#ebcb8b",
    success: "#a3be8c",
    // Upstream keeps the rail at the editor colour; nudge it darker so the
    // chrome still reads as a separate surface here.
    sidebar: "#292e39",
    sidebarMuted: "#3b4252",
    codeBg: "#272c36",
    syntax: { keyword: "#81a1c1", string: "#a3be8c", comment: "#616e88", number: "#b48ead" },
    charts: ["#88c0d0", "#a3be8c", "#ebcb8b", "#b48ead", "#bf616a"],
  },
  "night-owl": {
    label: "Night Owl",
    source: "Night Owl",
    kind: "dark",
    bg: "#011627",
    fg: "#d6deeb",
    surface: "#0b2942",
    border: "#1d3b53",
    muted: "#0b253a",
    mutedFg: "#7f9bb3",
    accent: "#82aaff",
    accentFg: "#011627",
    destructive: "#ef5350",
    warning: "#ecc48d",
    success: "#22da6e",
    sidebar: "#01111d",
    sidebarMuted: "#0b253a",
    codeBg: "#01111d",
    syntax: { keyword: "#c792ea", string: "#ecc48d", comment: "#637777", number: "#f78c6c" },
    charts: ["#82aaff", "#22da6e", "#ecc48d", "#c792ea", "#21c7a8"],
  },
  "gruvbox-dark": {
    label: "Gruvbox Dark",
    source: "Gruvbox",
    kind: "dark",
    bg: "#282828",
    fg: "#ebdbb2",
    surface: "#32302f",
    border: "#504945",
    muted: "#3c3836",
    mutedFg: "#a89984",
    accent: "#d79921",
    accentFg: "#282828",
    destructive: "#fb4934",
    warning: "#fabd2f",
    success: "#b8bb26",
    sidebar: "#1d2021",
    sidebarMuted: "#3c3836",
    codeBg: "#32302f",
    syntax: { keyword: "#fb4934", string: "#b8bb26", comment: "#928374", number: "#d3869b" },
    charts: ["#d79921", "#b8bb26", "#fabd2f", "#d3869b", "#83a598"],
  },
  monokai: {
    label: "Monokai",
    source: "Monokai",
    kind: "dark",
    bg: "#272822",
    fg: "#f8f8f2",
    surface: "#1e1f1c",
    border: "#49483e",
    muted: "#3e3d32",
    mutedFg: "#9d9d90",
    accent: "#ae81ff",
    accentFg: "#272822",
    destructive: "#f92672",
    warning: "#fd971f",
    success: "#a6e22e",
    sidebar: "#1e1f1c",
    sidebarMuted: "#3e3d32",
    codeBg: "#1e1f1c",
    syntax: { keyword: "#f92672", string: "#e6db74", comment: "#88846f", number: "#ae81ff" },
    charts: ["#ae81ff", "#a6e22e", "#fd971f", "#f92672", "#66d9ef"],
  },
  "rose-pine": {
    label: "Rosé Pine",
    source: "Rosé Pine",
    kind: "dark",
    bg: "#191724",
    fg: "#e0def4",
    surface: "#1f1d2e",
    border: "#403d52",
    muted: "#26233a",
    mutedFg: "#908caa",
    accent: "#ebbcba",
    accentFg: "#191724",
    destructive: "#eb6f92",
    warning: "#f6c177",
    success: "#9ccfd8",
    sidebar: "#15131f",
    sidebarMuted: "#26233a",
    codeBg: "#1f1d2e",
    syntax: { keyword: "#31748f", string: "#f6c177", comment: "#6e6a86", number: "#ebbcba" },
    charts: ["#ebbcba", "#9ccfd8", "#f6c177", "#c4a7e7", "#eb6f92"],
  },

  "codex-dark": {
    label: "Codex Dark",
    source: "Codex Desktop",
    kind: "dark",
    bg: "#181818",
    fg: "#ececec",
    surface: "#212121",
    border: "#2f2f2f",
    muted: "#2a2a2a",
    mutedFg: "#a3a3a3",
    accent: "#ececec",
    accentFg: "#0d0d0d",
    destructive: "#ff6369",
    warning: "#e0a526",
    success: "#10a37f",
    sidebar: "#121212",
    sidebarMuted: "#232323",
    codeBg: "#1f1f1f",
    syntax: { keyword: "#c792ea", string: "#7ee787", comment: "#7a7a7a", number: "#79c0ff" },
    charts: ["#339cff", "#10a37f", "#e0a526", "#c792ea", "#ff6369"],
  },
  "claude-dark": {
    label: "Claude Dark",
    source: "Claude Code",
    kind: "dark",
    bg: "#1c1c1b",
    fg: "#ececea",
    surface: "#252524",
    border: "#2f2f2d",
    muted: "#2a2a28",
    mutedFg: "#9c9a95",
    accent: "#d97757",
    accentFg: "#ffffff",
    destructive: "#ff6b80",
    warning: "#ffc107",
    success: "#4eba65",
    sidebar: "#181817",
    sidebarMuted: "#2a2a28",
    codeBg: "#222221",
    syntax: { keyword: "#e08a6b", string: "#a3b88a", comment: "#8a8984", number: "#8fb3dc" },
    charts: ["#d97757", "#6a9bcc", "#788c5d", "#e0b25b", "#9c9a95"],
  },

  /* ----------------------------------------------------------------- light */

  "github-light": {
    label: "GitHub Light",
    source: "GitHub Theme",
    kind: "light",
    bg: "#ffffff",
    fg: "#1f2328",
    surface: "#ffffff",
    border: "#d0d7de",
    muted: "#f6f8fa",
    mutedFg: "#59636e",
    accent: "#0969da",
    accentFg: "#ffffff",
    destructive: "#cf222e",
    warning: "#9a6700",
    success: "#1a7f37",
    sidebar: "#f6f8fa",
    sidebarMuted: "#eaeef2",
    codeBg: "#f6f8fa",
    syntax: { keyword: "#cf222e", string: "#0a3069", comment: "#6e7781", number: "#0550ae" },
    charts: ["#0969da", "#1a7f37", "#9a6700", "#bf3989", "#8250df"],
  },
  "one-light": {
    label: "One Light",
    source: "Atom One Light",
    kind: "light",
    bg: "#fafafa",
    fg: "#383a42",
    surface: "#ffffff",
    border: "#e5e5e6",
    muted: "#f0f0f1",
    mutedFg: "#696c77",
    accent: "#4078f2",
    accentFg: "#ffffff",
    destructive: "#e45649",
    warning: "#c18401",
    success: "#50a14f",
    sidebar: "#f0f0f1",
    sidebarMuted: "#e5e5e6",
    codeBg: "#f0f0f1",
    syntax: { keyword: "#a626a4", string: "#50a14f", comment: "#a0a1a7", number: "#986801" },
    charts: ["#4078f2", "#50a14f", "#c18401", "#a626a4", "#0184bc"],
  },
  "catppuccin-latte": {
    label: "Catppuccin Latte",
    source: "Catppuccin",
    kind: "light",
    bg: "#eff1f5",
    fg: "#4c4f69",
    surface: "#ffffff",
    border: "#ccd0da",
    muted: "#e6e9ef",
    mutedFg: "#6c6f85",
    accent: "#8839ef",
    accentFg: "#ffffff",
    destructive: "#d20f39",
    warning: "#df8e1d",
    success: "#40a02b",
    sidebar: "#e6e9ef",
    sidebarMuted: "#dce0e8",
    codeBg: "#e6e9ef",
    syntax: { keyword: "#8839ef", string: "#40a02b", comment: "#9ca0b0", number: "#fe640b" },
    charts: ["#8839ef", "#40a02b", "#fe640b", "#1e66f5", "#d20f39"],
  },
  "solarized-light": {
    label: "Solarized Light",
    source: "Solarized",
    kind: "light",
    bg: "#fdf6e3",
    fg: "#586e75",
    surface: "#eee8d5",
    border: "#d9d2c0",
    muted: "#e6dfc8",
    mutedFg: "#657b83",
    accent: "#268bd2",
    accentFg: "#fdf6e3",
    destructive: "#dc322f",
    warning: "#b58900",
    success: "#859900",
    sidebar: "#eee8d5",
    sidebarMuted: "#e0d9c2",
    codeBg: "#eee8d5",
    syntax: { keyword: "#859900", string: "#2aa198", comment: "#93a1a1", number: "#d33682" },
    charts: ["#268bd2", "#859900", "#b58900", "#d33682", "#2aa198"],
  },
  "quiet-light": {
    label: "Quiet Light",
    source: "VS Code built-in",
    kind: "light",
    bg: "#f5f5f5",
    fg: "#333333",
    surface: "#ffffff",
    border: "#e0e0e0",
    muted: "#ececec",
    mutedFg: "#737373",
    accent: "#705697",
    accentFg: "#ffffff",
    destructive: "#c5060b",
    warning: "#a05a00",
    success: "#3d7a2e",
    sidebar: "#f2f2f2",
    sidebarMuted: "#e4e4e4",
    codeBg: "#ececec",
    syntax: { keyword: "#4b83cd", string: "#448c27", comment: "#a2a2a2", number: "#aa3731" },
    charts: ["#705697", "#448c27", "#aa3731", "#4b83cd", "#b58900"],
  },
  "ayu-light": {
    label: "Ayu Light",
    source: "Ayu",
    kind: "light",
    bg: "#f8f9fa",
    fg: "#5c6166",
    surface: "#fcfcfc",
    border: "#dfe3e6",
    muted: "#eef1f2",
    mutedFg: "#787b80",
    accent: "#ffaa33",
    accentFg: "#1f2430",
    destructive: "#e65050",
    warning: "#eca944",
    success: "#6cbf43",
    sidebar: "#edf0f2",
    sidebarMuted: "#e2e7ea",
    codeBg: "#eef1f2",
    syntax: { keyword: "#fa8d3e", string: "#86b300", comment: "#9a9ea3", number: "#a37acc" },
    charts: ["#ffaa33", "#6cbf43", "#eca944", "#a37acc", "#3199e1"],
  },
  "gruvbox-light": {
    label: "Gruvbox Light",
    source: "Gruvbox",
    kind: "light",
    bg: "#fbf1c7",
    fg: "#3c3836",
    surface: "#f2e5bc",
    border: "#d5c4a1",
    muted: "#ebdbb2",
    mutedFg: "#7c6f64",
    accent: "#af3a03",
    accentFg: "#fbf1c7",
    destructive: "#9d0006",
    warning: "#b57614",
    success: "#79740e",
    sidebar: "#f2e5bc",
    sidebarMuted: "#ebdbb2",
    codeBg: "#f2e5bc",
    syntax: { keyword: "#9d0006", string: "#79740e", comment: "#928374", number: "#8f3f71" },
    charts: ["#af3a03", "#79740e", "#b57614", "#8f3f71", "#076678"],
  },
  "everforest-light": {
    label: "Everforest Light",
    source: "Everforest",
    kind: "light",
    bg: "#fdf6e3",
    fg: "#5c6a72",
    surface: "#f4f0d9",
    border: "#e0dcc7",
    muted: "#efebd4",
    mutedFg: "#829181",
    accent: "#8da101",
    accentFg: "#2d353b",
    destructive: "#f85552",
    warning: "#dfa000",
    success: "#35a77c",
    sidebar: "#f4f0d9",
    sidebarMuted: "#efebd4",
    codeBg: "#f4f0d9",
    syntax: { keyword: "#f85552", string: "#dfa000", comment: "#939f91", number: "#df69ba" },
    charts: ["#8da101", "#35a77c", "#dfa000", "#df69ba", "#3a94c5"],
  },
  "night-owl-light": {
    label: "Night Owl Light",
    source: "Night Owl",
    kind: "light",
    bg: "#fbfbfb",
    fg: "#403f53",
    surface: "#f0f0f0",
    border: "#d9d9d9",
    muted: "#eaeaea",
    mutedFg: "#7a8794",
    accent: "#2aa298",
    accentFg: "#ffffff",
    destructive: "#de3d3b",
    warning: "#e0af02",
    success: "#08916a",
    sidebar: "#f0f0f0",
    sidebarMuted: "#e0e0e0",
    codeBg: "#f0f0f0",
    syntax: { keyword: "#994cc3", string: "#4876d6", comment: "#989fb1", number: "#aa0982" },
    charts: ["#2aa298", "#08916a", "#e0af02", "#d6438a", "#288ed7"],
  },
  "rose-pine-dawn": {
    label: "Rosé Pine Dawn",
    source: "Rosé Pine",
    kind: "light",
    bg: "#faf4ed",
    fg: "#575279",
    surface: "#fffaf3",
    border: "#dfdad9",
    muted: "#f2e9e1",
    mutedFg: "#797593",
    accent: "#286983",
    accentFg: "#faf4ed",
    destructive: "#b4637a",
    warning: "#ea9d34",
    success: "#56949f",
    sidebar: "#f4ede8",
    sidebarMuted: "#f2e9e1",
    codeBg: "#f2e9e1",
    syntax: { keyword: "#286983", string: "#ea9d34", comment: "#9893a5", number: "#d7827e" },
    charts: ["#d7827e", "#56949f", "#ea9d34", "#907aa9", "#b4637a"],
  },
  "codex-light": {
    label: "Codex Light",
    source: "Codex Desktop",
    kind: "light",
    bg: "#ffffff",
    fg: "#0d0d0d",
    surface: "#ffffff",
    border: "#e5e5e5",
    muted: "#f3f3f3",
    mutedFg: "#5d5d5d",
    accent: "#0d0d0d",
    accentFg: "#ffffff",
    destructive: "#e02e2a",
    warning: "#c27c00",
    success: "#00a240",
    sidebar: "#f9f9f9",
    sidebarMuted: "#ececec",
    codeBg: "#f7f7f7",
    syntax: { keyword: "#8b3fd9", string: "#1a7f37", comment: "#8f8f8f", number: "#0969da" },
    charts: ["#0285ff", "#00a240", "#c27c00", "#8b3fd9", "#e02e2a"],
  },
  "claude-light": {
    label: "Claude Light",
    source: "Claude Code",
    kind: "light",
    bg: "#fcfbfb",
    fg: "#141413",
    surface: "#ffffff",
    border: "#ebebe8",
    muted: "#f0efec",
    mutedFg: "#858480",
    accent: "#d97757",
    accentFg: "#ffffff",
    destructive: "#ab2b3f",
    warning: "#966c1e",
    success: "#2c7a39",
    sidebar: "#fafaf8",
    sidebarMuted: "#edebe7",
    codeBg: "#f7f6f4",
    syntax: { keyword: "#c6613f", string: "#5f7a3f", comment: "#858480", number: "#3f73b0" },
    charts: ["#d97757", "#6a9bcc", "#788c5d", "#c49a3a", "#858480"],
  },
};

export const THEMES = Object.fromEntries(
  (Object.keys(SEEDS) as ThemeId[]).map((id) => [
    id,
    { ...SEEDS[id], id, tokens: buildTokens(SEEDS[id]) } satisfies ThemeDefinition,
  ]),
) as Record<ThemeId, ThemeDefinition>;

/** Picker order: most-installed first. */
export const LIGHT_THEME_IDS: ThemeId[] = [
  "github-light",
  "one-light",
  "catppuccin-latte",
  "solarized-light",
  "quiet-light",
  "ayu-light",
  "gruvbox-light",
  "everforest-light",
  "night-owl-light",
  "rose-pine-dawn",
  "codex-light",
  "claude-light",
];

export const DARK_THEME_IDS: ThemeId[] = [
  "github-dark",
  "one-dark-pro",
  "dracula",
  "tokyo-night",
  "catppuccin-mocha",
  "nord",
  "night-owl",
  "gruvbox-dark",
  "monokai",
  "rose-pine",
  "codex-dark",
  "claude-dark",
];

export const DEFAULT_LIGHT_THEME: ThemeId = "github-light";
export const DEFAULT_DARK_THEME: ThemeId = "github-dark";
export const DEFAULT_THEME_MODE: ThemeMode = "system";

/**
 * Default 界面字号 in px — the root font size. At the 16px default the body text
 * (`text-sm`, 0.875rem) renders at 14px, which is the app's intended look.
 */
export const DEFAULT_UI_FONT_SIZE = 16;
/** The 界面字号 picker's range, in px of root font size; `settings.ts` accepts the same. */
export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 20;
export const UI_FONT_SIZE_STEP = 1;

/**
 * Apply the 界面字号 setting.
 *
 * Every size in the app is a rem-based Tailwind `text-*` utility, so the root
 * font size is the single scale factor for the whole interface: at 16px the body
 * text (`text-sm`) is 14px, at 18px it is 15.75px, and every other size — captions,
 * tool output, spacing written in rem — moves with it.
 */
export function applyUiFontSize(size: number): void {
  const clamped = Math.round(Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, size)));
  document.documentElement.style.setProperty("--ui-root-font-size", `${clamped}px`);
}

export function themesFor(kind: ThemeKind): ThemeDefinition[] {
  return (kind === "dark" ? DARK_THEME_IDS : LIGHT_THEME_IDS).map((id) => THEMES[id]);
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && value in THEMES;
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export type ThemePreferences = {
  themeMode: ThemeMode;
  lightTheme: ThemeId;
  darkTheme: ThemeId;
};

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
}

/** Which concrete theme is active for the given preferences. */
export function resolveTheme(preferences: ThemePreferences, prefersDark = systemPrefersDark()): ThemeDefinition {
  const kind: ThemeKind =
    preferences.themeMode === "system" ? (prefersDark ? "dark" : "light") : preferences.themeMode;
  const id = kind === "dark" ? preferences.darkTheme : preferences.lightTheme;
  return THEMES[id] ?? THEMES[kind === "dark" ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME];
}

/** Write a theme's tokens onto <html> and toggle the Tailwind `dark` class. */
export function applyTheme(theme: ThemeDefinition): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--${name}`, value);
  }
  root.classList.toggle("dark", theme.kind === "dark");
  root.dataset.theme = theme.id;
  root.dataset.themeKind = theme.kind;
  root.style.setProperty("color-scheme", theme.kind);
}

export function applyThemePreferences(preferences: ThemePreferences): ThemeDefinition {
  const theme = resolveTheme(preferences);
  applyTheme(theme);
  return theme;
}
