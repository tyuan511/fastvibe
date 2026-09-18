import {
  createHighlighterCore,
  createCssVariablesTheme,
  getTokenStyleObject,
  stringifyTokenStyle,
  type HighlighterCore,
  type LanguageRegistration,
  type ThemedToken,
} from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { ShikiStreamTokenizer } from "@shikijs/stream";

const THEME = "fastvibe";
const MAX_CHARS = 120_000;
type LanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

/** Explicit imports keep grammars split into chunks, rather than bundling the catalog. */
const LOADERS: Record<string, LanguageLoader> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  nginx: () => import("shiki/langs/nginx.mjs"),
};

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
  go: "go", rs: "rust", rust: "rust", java: "java",
  kt: "kotlin", kts: "kotlin", kotlin: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", csharp: "csharp", php: "php", swift: "swift",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", shell: "shellscript", shellscript: "shellscript",
  yml: "yaml", yaml: "yaml", sql: "sql", toml: "toml",
  md: "markdown", markdown: "markdown", diff: "diff", patch: "diff",
  dockerfile: "docker", docker: "docker", lua: "lua", pl: "perl", perl: "perl",
  dart: "dart", ex: "elixir", exs: "elixir", elixir: "elixir",
  vue: "vue", svelte: "svelte", graphql: "graphql", gql: "graphql",
  ps1: "powershell", powershell: "powershell", ini: "ini", conf: "ini",
  makefile: "make", make: "make", r: "r", nginx: "nginx",
};

let corePromise: Promise<HighlighterCore> | undefined;
const languagePromises = new Map<string, Promise<void>>();

async function loadHighlighter(language?: string): Promise<{ highlighter: HighlighterCore; lang: string }> {
  corePromise ??= createHighlighterCore({
    themes: [createCssVariablesTheme({ name: THEME, variablePrefix: "--shiki-" })],
    langs: [],
    engine: createOnigurumaEngine(() => import("shiki/wasm")),
  });
  const highlighter = await corePromise;
  const id = language?.toLowerCase();
  const lang = id && Object.hasOwn(ALIASES, id) ? ALIASES[id] : "plaintext";
  if (Object.hasOwn(LOADERS, lang)) {
    let pending = languagePromises.get(lang);
    if (!pending) {
      pending = highlighter.loadLanguage(LOADERS[lang]).catch((error: unknown) => {
        languagePromises.delete(lang);
        throw error;
      });
      languagePromises.set(lang, pending);
    }
    await pending;
  }
  return { highlighter, lang };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderTokens(tokens: ThemedToken[]): string {
  return tokens.map((token) => {
    const style = stringifyTokenStyle(token.htmlStyle || getTokenStyleObject(token));
    return `<span${style ? ` style="${escapeHtml(style)}"` : ""}>${escapeHtml(token.content)}</span>`;
  }).join("");
}

function wrap(body: string): string {
  return `<pre class="shiki"><code>${body}</code></pre>`;
}

/**
 * One code block's incremental tokenizer. Finished lines keep their HTML and
 * grammar state; only the unfinished line and newly appended code are tokenized.
 * No trailing debounce: a continuous stream must not starve the highlight update.
 * Replacements/truncations reset the tokenizer (editing a reply or previewing another file).
 */
export class StreamingHighlighter {
  #language: string | undefined;
  #tokenizer: ShikiStreamTokenizer | undefined;
  #code = "";
  #stableHtml = "";
  #pending: Promise<unknown> = Promise.resolve();

  constructor(language?: string) {
    this.#language = language;
  }

  highlight(code: string): Promise<string> {
    // enqueue mutates grammar state: serialize even across asynchronous grammar loading.
    const result = this.#pending.then(() => this.#highlight(code));
    this.#pending = result.catch(() => undefined);
    return result;
  }

  async #highlight(code: string): Promise<string> {
    if (!code || code.length > MAX_CHARS) {
      this.#tokenizer = undefined;
      this.#code = "";
      this.#stableHtml = "";
      return wrap(escapeHtml(code));
    }
    if (!this.#tokenizer) {
      const { highlighter, lang } = await loadHighlighter(this.#language);
      this.#tokenizer = new ShikiStreamTokenizer({ highlighter, lang, theme: THEME });
    }
    if (!code.startsWith(this.#code)) {
      this.#tokenizer.clear();
      this.#stableHtml = "";
      this.#code = "";
    }
    const { stable, unstable } = await this.#tokenizer.enqueue(code.slice(this.#code.length));
    this.#stableHtml += renderTokens(stable);
    this.#code = code;
    return wrap(this.#stableHtml + renderTokens(unstable));
  }
}
