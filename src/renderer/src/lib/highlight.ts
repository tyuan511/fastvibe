import { useEffect, useState } from "react";
import { getHighlighterCore, type HighlighterCore, type LanguageRegistration } from "shikiji/core";
import { createCssVariablesTheme } from "shikiji/theme-css-variables";
import getWasm from "shikiji/wasm";

/**
 * Syntax highlighting with shikiji. The highlighter is created lazily and each
 * grammar is code-split, so only the languages a conversation actually shows are
 * fetched. Colors come from a CSS-variables theme that maps onto the app's own
 * `--code-*` tokens, so every FastVibe theme highlights correctly for free.
 */
const THEME = "fastvibe";
const MAX_CHARS = 120_000;
const CACHE_LIMIT = 120;
const DEBOUNCE_MS = 60;

type LanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

const LOADERS: Record<string, LanguageLoader> = {
  typescript: () => import("shikiji/langs/typescript.mjs"),
  tsx: () => import("shikiji/langs/tsx.mjs"),
  javascript: () => import("shikiji/langs/javascript.mjs"),
  jsx: () => import("shikiji/langs/jsx.mjs"),
  json: () => import("shikiji/langs/json.mjs"),
  html: () => import("shikiji/langs/html.mjs"),
  css: () => import("shikiji/langs/css.mjs"),
  scss: () => import("shikiji/langs/scss.mjs"),
  less: () => import("shikiji/langs/less.mjs"),
  python: () => import("shikiji/langs/python.mjs"),
  ruby: () => import("shikiji/langs/ruby.mjs"),
  go: () => import("shikiji/langs/go.mjs"),
  rust: () => import("shikiji/langs/rust.mjs"),
  java: () => import("shikiji/langs/java.mjs"),
  kotlin: () => import("shikiji/langs/kotlin.mjs"),
  c: () => import("shikiji/langs/c.mjs"),
  cpp: () => import("shikiji/langs/cpp.mjs"),
  csharp: () => import("shikiji/langs/csharp.mjs"),
  php: () => import("shikiji/langs/php.mjs"),
  swift: () => import("shikiji/langs/swift.mjs"),
  shellscript: () => import("shikiji/langs/shellscript.mjs"),
  yaml: () => import("shikiji/langs/yaml.mjs"),
  xml: () => import("shikiji/langs/xml.mjs"),
  sql: () => import("shikiji/langs/sql.mjs"),
  toml: () => import("shikiji/langs/toml.mjs"),
  markdown: () => import("shikiji/langs/markdown.mjs"),
  diff: () => import("shikiji/langs/diff.mjs"),
  docker: () => import("shikiji/langs/docker.mjs"),
  lua: () => import("shikiji/langs/lua.mjs"),
  perl: () => import("shikiji/langs/perl.mjs"),
  dart: () => import("shikiji/langs/dart.mjs"),
  elixir: () => import("shikiji/langs/elixir.mjs"),
  vue: () => import("shikiji/langs/vue.mjs"),
  svelte: () => import("shikiji/langs/svelte.mjs"),
  graphql: () => import("shikiji/langs/graphql.mjs"),
  powershell: () => import("shikiji/langs/powershell.mjs"),
  ini: () => import("shikiji/langs/ini.mjs"),
  make: () => import("shikiji/langs/make.mjs"),
  r: () => import("shikiji/langs/r.mjs"),
  nginx: () => import("shikiji/langs/nginx.mjs"),
};

/** File extensions, short ids and shiki ids → a bundled grammar id. */
const ALIASES: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", typescript: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", javascript: "javascript",
  jsx: "jsx",
  json: "json", jsonc: "json",
  html: "html", htm: "html", svg: "xml", xml: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less",
  py: "python", python: "python",
  rb: "ruby", ruby: "ruby",
  go: "go",
  rs: "rust", rust: "rust",
  java: "java",
  kt: "kotlin", kts: "kotlin", kotlin: "kotlin",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", csharp: "csharp",
  php: "php",
  swift: "swift",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", shell: "shellscript",
  yml: "yaml", yaml: "yaml",
  sql: "sql",
  toml: "toml",
  md: "markdown", markdown: "markdown",
  diff: "diff", patch: "diff",
  dockerfile: "docker", docker: "docker",
  lua: "lua",
  pl: "perl", perl: "perl",
  dart: "dart",
  ex: "elixir", exs: "elixir", elixir: "elixir",
  vue: "vue", svelte: "svelte",
  graphql: "graphql", gql: "graphql",
  ps1: "powershell", powershell: "powershell",
  ini: "ini", conf: "ini",
  makefile: "make", make: "make",
  r: "r",
  nginx: "nginx",
};

const cache = new Map<string, string>();
const loaded = new Set<string>();
let corePromise: Promise<HighlighterCore> | null = null;

function core(): Promise<HighlighterCore> {
  corePromise ??= getHighlighterCore({
    themes: [createCssVariablesTheme({ name: THEME, variablePrefix: "--shiki-" })],
    langs: [],
    loadWasm: getWasm,
  });
  return corePromise;
}

function resolveLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const id = ALIASES[language.toLowerCase()];
  return id && LOADERS[id] ? id : undefined;
}

function escapeHtml(code: string): string {
  return code.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Highlight one snippet, returning a full `<pre class="shiki">` HTML string. */
export async function highlightCode(code: string, language?: string): Promise<string> {
  if (!code || code.length > MAX_CHARS) {
    return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
  }
  const id = resolveLanguage(language);
  const highlighter = await core();
  if (id && !loaded.has(id)) {
    await highlighter.loadLanguage(LOADERS[id]);
    loaded.add(id);
  }
  return highlighter.codeToHtml(code, { lang: id ?? "plaintext", theme: THEME });
}

/**
 * React binding for `highlightCode`. Debounced so a streaming code block is not
 * re-tokenized on every token, and cached by `(language, code)`.
 */
export function useHighlightedCode(code: string, language?: string): string | null {
  const key = `${language ?? ""}\u0000${code}`;
  const [html, setHtml] = useState<string | null>(() => cache.get(key) ?? null);
  useEffect(() => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      setHtml(cached);
      return;
    }
    setHtml(null);
    let active = true;
    const timer = window.setTimeout(() => {
      highlightCode(code, language)
        .then((result) => {
          if (!active) return;
          cache.set(key, result);
          if (cache.size > CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          setHtml(result);
        })
        .catch(() => undefined);
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [key, code, language]);
  return html;
}
