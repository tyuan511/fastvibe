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

/**
 * Explicit imports keep grammars split into chunks, rather than bundling the catalog.
 *
 * A key is an id the loaded grammar answers to — the name it registers, or one of its
 * aliases — because `loadLanguage` registers a grammar under those ids and the tokenizer
 * is then asked for the key. `docker.mjs`, for instance, registers `docker` and
 * `dockerfile`, so either name colours it; a key that is neither is silently plaintext.
 * `test/syntax-highlighter.test.ts` walks this table and loads every grammar for that
 * reason.
 */
/**
 * Exported for `test/syntax-highlighter.test.ts`, which loads every grammar in it and
 * checks the key is an id the loaded grammar answers to — a wrong key costs nothing at
 * build time and shows up as a silently plain code block in the chat.
 */
export const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  // Web
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  jsonl: () => import("shiki/langs/jsonl.mjs"),
  jsonnet: () => import("shiki/langs/jsonnet.mjs"),
  hjson: () => import("shiki/langs/hjson.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  postcss: () => import("shiki/langs/postcss.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  astro: () => import("shiki/langs/astro.mjs"),
  handlebars: () => import("shiki/langs/handlebars.mjs"),
  twig: () => import("shiki/langs/twig.mjs"),
  jinja: () => import("shiki/langs/jinja.mjs"),
  pug: () => import("shiki/langs/pug.mjs"),
  liquid: () => import("shiki/langs/liquid.mjs"),
  blade: () => import("shiki/langs/blade.mjs"),
  razor: () => import("shiki/langs/razor.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  mermaid: () => import("shiki/langs/mermaid.mjs"),
  // Languages
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  coffee: () => import("shiki/langs/coffee.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  fsharp: () => import("shiki/langs/fsharp.mjs"),
  vb: () => import("shiki/langs/vb.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  raku: () => import("shiki/langs/perl6.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  luau: () => import("shiki/langs/luau.mjs"),
  nim: () => import("shiki/langs/nim.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  ocaml: () => import("shiki/langs/ocaml.mjs"),
  elm: () => import("shiki/langs/elm.mjs"),
  clojure: () => import("shiki/langs/clojure.mjs"),
  racket: () => import("shiki/langs/racket.mjs"),
  julia: () => import("shiki/langs/julia.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  pascal: () => import("shiki/langs/pascal.mjs"),
  prolog: () => import("shiki/langs/prolog.mjs"),
  crystal: () => import("shiki/langs/crystal.mjs"),
  d: () => import("shiki/langs/d.mjs"),
  haxe: () => import("shiki/langs/haxe.mjs"),
  abap: () => import("shiki/langs/abap.mjs"),
  cobol: () => import("shiki/langs/cobol.mjs"),
  gdscript: () => import("shiki/langs/gdscript.mjs"),
  scheme: () => import("shiki/langs/scheme.mjs"),
  // The grammar registers f90/f95/f03/f08/f18 under these names; `fortran` is the fence word.
  f90: () => import("shiki/langs/f90.mjs"),
  // Science
  matlab: () => import("shiki/langs/matlab.mjs"),
  wolfram: () => import("shiki/langs/wolfram.mjs"),
  purescript: () => import("shiki/langs/purescript.mjs"),
  lean4: () => import("shiki/langs/lean4.mjs"),
  coq: () => import("shiki/langs/coq.mjs"),
  tcl: () => import("shiki/langs/tcl.mjs"),
  awk: () => import("shiki/langs/awk.mjs"),
  solidity: () => import("shiki/langs/solidity.mjs"),
  v: () => import("shiki/langs/v.mjs"),
  vala: () => import("shiki/langs/vala.mjs"),
  odin: () => import("shiki/langs/odin.mjs"),
  fennel: () => import("shiki/langs/fennel.mjs"),
  asm: () => import("shiki/langs/asm.mjs"),
  wasm: () => import("shiki/langs/wasm.mjs"),
  glsl: () => import("shiki/langs/glsl.mjs"),
  wgsl: () => import("shiki/langs/wgsl.mjs"),
  hlsl: () => import("shiki/langs/hlsl.mjs"),
  verilog: () => import("shiki/langs/verilog.mjs"),
  "system-verilog": () => import("shiki/langs/system-verilog.mjs"),
  vhdl: () => import("shiki/langs/vhdl.mjs"),
  // Shell, ops, data
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  shellsession: () => import("shiki/langs/console.mjs"),
  bat: () => import("shiki/langs/bat.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  nushell: () => import("shiki/langs/nushell.mjs"),
  just: () => import("shiki/langs/just.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  cmake: () => import("shiki/langs/cmake.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  nginx: () => import("shiki/langs/nginx.mjs"),
  apache: () => import("shiki/langs/apache.mjs"),
  systemd: () => import("shiki/langs/systemd.mjs"),
  reg: () => import("shiki/langs/reg.mjs"),
  http: () => import("shiki/langs/http.mjs"),
  hurl: () => import("shiki/langs/hurl.mjs"),
  log: () => import("shiki/langs/log.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  plsql: () => import("shiki/langs/plsql.mjs"),
  sparql: () => import("shiki/langs/sparql.mjs"),
  kql: () => import("shiki/langs/kql.mjs"),
  tsp: () => import("shiki/langs/tsp.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  cue: () => import("shiki/langs/cue.mjs"),
  templ: () => import("shiki/langs/templ.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  nix: () => import("shiki/langs/nix.mjs"),
  kdl: () => import("shiki/langs/kdl.mjs"),
  ron: () => import("shiki/langs/ron.mjs"),
  csv: () => import("shiki/langs/csv.mjs"),
  tsv: () => import("shiki/langs/tsv.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  xsl: () => import("shiki/langs/xsl.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  "git-commit": () => import("shiki/langs/git-commit.mjs"),
  "git-rebase": () => import("shiki/langs/git-rebase.mjs"),
  codeowners: () => import("shiki/langs/codeowners.mjs"),
  // Prose
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  asciidoc: () => import("shiki/langs/asciidoc.mjs"),
  rst: () => import("shiki/langs/rst.mjs"),
  org: () => import("shiki/langs/org.mjs"),
  latex: () => import("shiki/langs/latex.mjs"),
  bibtex: () => import("shiki/langs/bibtex.mjs"),
  typst: () => import("shiki/langs/typst.mjs"),
};

/**
 * Names that are not a grammar's own id: the fence word a model writes and the file
 * extension Main hands over for a preview. Anything that already matches a key above
 * needs no entry — `resolveLanguage` tries the loaders first.
 *
 * Exported with the loaders so the test can check the two tables agree.
 */
export const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", es6: "javascript", node: "javascript",
  geojson: "json", ndjson: "jsonl", jsonlines: "jsonl",
  htm: "html", xhtml: "html", shtml: "html", tmpl: "html", tpl: "html", inc: "html",
  svg: "xml", rss: "xml", atom: "xml", xsd: "xml", opml: "xml", plist: "xml", xlf: "xml",
  xslt: "xsl", sass: "scss", pcss: "postcss",
  md: "markdown", mkd: "markdown", adoc: "asciidoc", tex: "latex", bib: "bibtex", typ: "typst",
  py: "python", py3: "python", ipython: "python", rb: "ruby", rakefile: "ruby", gemfile: "ruby", gemspec: "ruby",
  cakefile: "coffee", coffeescript: "coffee", golang: "go", rs: "rust", bsh: "java",
  kt: "kotlin", kts: "kotlin", sc: "scala", sbt: "scala", gy: "groovy", gvy: "groovy",
  gradle: "groovy", jenkinsfile: "groovy",
  h: "c", cc: "cpp", cxx: "cpp", "c++": "cpp", hpp: "cpp", hh: "cpp",
  objc: "objective-c", "obj-c": "objective-c", objcpp: "objective-c", mm: "objective-c",
  cs: "csharp", "c#": "csharp", fs: "fsharp", fsx: "fsharp", fsi: "fsharp", "f#": "fsharp",
  vbnet: "vb", asp: "vb", php3: "php", php4: "php", php5: "php", php7: "php", phtml: "php",
  ex: "elixir", exs: "elixir", erl: "erlang", escript: "elixir",
  p6: "raku", pl6: "raku", pm6: "raku", nqp: "raku", perl6: "raku",
  pl: "perl", pm: "perl", pod: "perl", psgi: "perl", hs: "haskell",
  clj: "clojure", cljs: "clojure", cljc: "clojure", edn: "clojure", ml: "ocaml", mli: "ocaml",
  jl: "julia", rscript: "r", rprofile: "r", sol: "solidity", fnl: "fennel",
  nasm: "asm", gas: "asm", x86: "asm", wat: "wasm", mmd: "mermaid", gql: "graphql",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", shell: "shellscript", ksh: "shellscript",
  dash: "shellscript", bashrc: "shellscript", zshrc: "shellscript",
  console: "shellsession", "shell-session": "shellsession", session: "shellsession",
  batch: "bat", cmd: "bat", dosbatch: "bat", gd: "gdscript", pas: "pascal",
  // Main hands a dotfile's own name over when there is no extension to read.
  service: "systemd", socket: "systemd", timer: "systemd", gitattributes: "codeowners",
  bash_profile: "shellscript", bash_logout: "shellscript", zprofile: "shellscript", zshenv: "shellscript",
  ps1: "powershell", ps: "powershell", psm1: "powershell", psd1: "powershell", pwsh: "powershell",
  nu: "nushell", justfile: "just", makefile: "make", gnumakefile: "make", mk: "make", ocamlmakefile: "make",
  dockerfile: "docker", containerfile: "docker", apacheconf: "apache",
  conf: "ini", cfg: "ini", properties: "ini", editorconfig: "ini", env: "dotenv",
  tf: "terraform", tfvars: "terraform", yml: "yaml", ddl: "sql", dml: "sql",
  protobuf: "proto", proto3: "proto", rej: "diff", patch: "diff",
  gitcommit: "git-commit", gitrebase: "git-rebase",
  hbs: "handlebars", mustache: "handlebars", njk: "jinja", "jinja-html": "jinja",
  jade: "pug", cshtml: "razor", mql: "kql", kusto: "kql", ttl: "sparql", turtle: "sparql",
  typespec: "tsp", octave: "matlab", mathematica: "wolfram", wl: "wolfram", lean: "lean4",
  f95: "f90", f03: "f90", f08: "f90", f18: "f90", fortran: "f90", "fortran-free-form": "f90",
  systemverilog: "system-verilog", sv: "system-verilog",
  plaintext: "plaintext", text: "plaintext", plain: "plaintext", txt: "plaintext", output: "plaintext",
};

/**
 * Grammars that colour a fenced block inside themselves by *including another
 * grammar's scope name* — and ship nothing but their own.
 *
 * Every other language in the catalog bundles the grammars it embeds in its own chunk
 * (`vue.mjs` brings css and js with it, `rst.mjs` brings thirty), so loading it is
 * enough. These three are the exception: a ```` ```html ```` fence inside a markdown
 * document stays flat until `html` is loaded as well, which is why an agent showing a
 * README in a ```` ```markdown ```` block used to print uncoloured markup. The fix is
 * to look at the fences the block actually contains and load those grammars too —
 * `markdown.mjs` alone is 65 KB of one grammar, and the catalog it can reference is 60
 * languages, so loading them all on sight would be the wrong trade.
 */
const EMBEDDING_HOSTS = new Set(["markdown", "mdx", "asciidoc"]);

/**
 * A fence's info string: up to three spaces of indent, then ``` or ~~~, then the first
 * word. Four-space indented code is a code block, not a fence, and a closing fence has
 * no word to resolve. The lookahead keeps `js` out of a `` ```js-console `` fence —
 * unknown info strings are the reader's problem, not ours.
 */
const FENCE_INFO = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.#-]+)(?=[\s{|]|$)/gm;

/** One streamed block can name many languages; past this the rest stay flat rather than fetching a catalog. */
const MAX_EMBEDDED = 8;

/** The language id to load and highlight for a name a fence or a file extension wrote. */
export function resolveLanguage(name?: string): string | undefined {
  if (!name) return undefined;
  const id = name.toLowerCase();
  if (Object.hasOwn(LANGUAGE_LOADERS, id)) return id;
  // `hasOwn`, not a lookup: a fence may read `__proto__` or `constructor`, and the
  // prototype chain is not a language.
  if (!Object.hasOwn(LANGUAGE_ALIASES, id)) return undefined;
  const alias = LANGUAGE_ALIASES[id];
  return alias === "plaintext" || Object.hasOwn(LANGUAGE_LOADERS, alias) ? alias : undefined;
}

/**
 * The languages a markdown-shaped block asks for inside its fences, in the order they
 * first appear. A grammar the host never references costs one lazy chunk and colours
 * nothing — cheaper than a second table of the scope names each host includes.
 */
export function embeddedLanguages(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(FENCE_INFO)) {
    const id = resolveLanguage(match[1]);
    if (!id || id === "plaintext" || found.includes(id)) continue;
    found.push(id);
    if (found.length === MAX_EMBEDDED) break;
  }
  return found;
}

let corePromise: Promise<HighlighterCore> | undefined;
const languagePromises = new Map<string, Promise<void>>();

async function loadOne(highlighter: HighlighterCore, id: string): Promise<void> {
  const loader = LANGUAGE_LOADERS[id];
  if (!loader) return;
  let pending = languagePromises.get(id);
  if (!pending) {
    pending = highlighter.loadLanguage(loader).catch((error: unknown) => {
      languagePromises.delete(id);
      throw error;
    });
    languagePromises.set(id, pending);
  }
  await pending;
}

async function loadHighlighter(
  language: string | undefined,
  code: string,
): Promise<{ highlighter: HighlighterCore; lang: string; embedded: string[] }> {
  corePromise ??= createHighlighterCore({
    themes: [createCssVariablesTheme({ name: THEME, variablePrefix: "--shiki-" })],
    langs: [],
    engine: createOnigurumaEngine(() => import("shiki/wasm")),
  });
  const highlighter = await corePromise;
  const lang = resolveLanguage(language) ?? "plaintext";
  // Asked for by the fence words in this block, not by the host grammar's catalogue: a
  // markdown answer is usually one language deep, not sixty.
  const embedded = EMBEDDING_HOSTS.has(lang) ? embeddedLanguages(code) : [];
  await Promise.all([loadOne(highlighter, lang), ...embedded.map((id) => loadOne(highlighter, id))]);
  return { highlighter, lang, embedded };
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
  /** The language plus the embedded grammars its fences asked for. */
  #signature = "";
  #code = "";
  #stableHtml = "";
  #pending: Promise<unknown> = Promise.resolve();
  #latestRequest = 0;
  #latestResult = wrap("");

  constructor(language?: string) {
    this.#language = language;
  }

  highlight(code: string): Promise<string> {
    // enqueue mutates grammar state: serialize even across asynchronous grammar loading.
    const result = this.#pending.then(() => this.#highlight(code));
    this.#pending = result.catch(() => undefined);
    return result;
  }

  /** Queue only the newest live snapshot; older queued snapshots resolve to the last result. */
  highlightLatest(code: string): Promise<string> {
    const request = ++this.#latestRequest;
    const result = this.#pending.then(async () => {
      if (request !== this.#latestRequest) return this.#latestResult;
      const highlighted = await this.#highlight(code);
      this.#latestResult = highlighted;
      return highlighted;
    });
    this.#pending = result.catch(() => undefined);
    return result;
  }

  async #highlight(code: string): Promise<string> {
    if (!code || code.length > MAX_CHARS) {
      // No tokenizer, and no signature to keep: the next real call must build one.
      this.#tokenizer = undefined;
      this.#signature = "";
      this.#code = "";
      this.#stableHtml = "";
      return wrap(escapeHtml(code));
    }
    const { highlighter, lang, embedded } = await loadHighlighter(this.#language, code);
    // A markdown block reveals its fences as it streams, and the grammar a line was
    // tokenized with cannot be exchanged underneath it: the block is re-tokenized from
    // the top the moment a new fence language arrives, which is once per distinct
    // language rather than once per token.
    const signature = `${lang}\u0000${embedded.join(",")}`;
    let tokenizer = this.#tokenizer;
    if (!tokenizer || signature !== this.#signature) {
      this.#signature = signature;
      tokenizer = new ShikiStreamTokenizer({ highlighter, lang, theme: THEME });
      this.#tokenizer = tokenizer;
      this.#code = "";
      this.#stableHtml = "";
    }
    if (!code.startsWith(this.#code)) {
      tokenizer.clear();
      this.#stableHtml = "";
      this.#code = "";
    }
    const { stable, unstable } = await tokenizer.enqueue(code.slice(this.#code.length));
    this.#stableHtml += renderTokens(stable);
    this.#code = code;
    return wrap(this.#stableHtml + renderTokens(unstable));
  }
}
