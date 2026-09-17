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
/** Roughly 8 MB of highlighted HTML, which is a few hundred ordinary snippets. */
const CACHE_BYTES = 8_000_000;
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

/**
 * Highlighted HTML, keyed by `(language, code)` and bounded by *bytes* rather than
 * entries.
 *
 * A plain entry count let the cache hold whatever it was given: the key repeats the
 * whole snippet and shiki's output is several times the size of its input, so a
 * hundred long blocks could sit on tens of megabytes. Keys are hashed for the same
 * reason — a transcript full of long snippets should not keep a second copy of each
 * one just to find it again.
 */
const cache = new Map<string, { html: string; bytes: number }>();
let cacheBytes = 0;

function cacheKey(code: string, language?: string): string {
  // FNV-1a over the snippet: collisions only ever mean a wrong *highlight*, and the
  // length is folded in, so two snippets would have to match in both to be confused.
  let hash = 0x811c9dc5;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${language ?? ""}\u0000${code.length}\u0000${(hash >>> 0).toString(36)}`;
}

function remember(key: string, html: string): void {
  const existing = cache.get(key);
  if (existing) cacheBytes -= existing.bytes;
  const bytes = html.length;
  cache.set(key, { html, bytes });
  cacheBytes += bytes;
  while (cacheBytes > CACHE_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheBytes -= cache.get(oldest)?.bytes ?? 0;
    cache.delete(oldest);
  }
}

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
 *
 * The previous highlight is held while the next one is computed. Clearing it on
 * every change dropped a growing code block back to unstyled `<pre>` between each
 * debounce window — a block that is streaming flickered between the two the whole
 * way down, and each swap reflowed the thread underneath it.
 */
export function useHighlightedCode(code: string, language?: string): string | null {
  const key = cacheKey(code, language);
  const [html, setHtml] = useState<string | null>(() => cache.get(key)?.html ?? null);
  useEffect(() => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      setHtml(cached.html);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      highlightCode(code, language)
        .then((result) => {
          if (!active) return;
          remember(key, result);
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
