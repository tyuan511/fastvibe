// The explicit `.ts` is what lets `node --test` reach this module (see tsconfig.web.json):
// the bare specifier would resolve for Vite and fail for the runner, silently skipping the
// table's only guard against a typo.
import { resolveLanguage } from "./syntax-highlighter.ts";

/**
 * The glyph shown beside a fenced code block's language label.
 *
 * A reply's ```` ```py ```` fence and the `foo.py` chip in the same thread should name the
 * same thing with the same picture, so this reuses the vendored vscode-icons lookup rather
 * than a second set of marks: it hands `FileIcon` a *representative file name* for the
 * language, and `resolveFileIcon` decides the glyph.
 *
 * The table is keyed by the **canonical grammar id** — the fence word is folded through
 * `resolveLanguage` first, so `py`, `python3`, `golang` and `python` all land on `python`.
 * Keys must therefore exist in `LANGUAGE_LOADERS`, and values must be names the shipped
 * manifest actually recognises; `test/code-fence-icon.test.ts` pins both, because a typo in
 * either half degrades to a blank page silently.
 *
 * **A language with no glyph here draws no icon at all**, which is deliberate. The long tail
 * (`hurl`, `nushell`, `coq`, `typst` …) is unmapped in the icon pack too, so the alternative
 * would be a generic blank file next to a word that already says what it is — noise that
 * makes the two-thirds of fences that *do* have a mark look incidental.
 */
const LANGUAGE_FILE: Record<string, string> = {
  // Web and markup
  typescript: "x.ts",
  tsx: "x.tsx",
  javascript: "x.js",
  jsx: "x.jsx",
  json: "x.json",
  jsonc: "x.json",
  json5: "x.json5",
  jsonl: "x.jsonl",
  jsonnet: "x.jsonnet",
  hjson: "x.hjson",
  html: "x.html",
  css: "x.css",
  scss: "x.scss",
  less: "x.less",
  vue: "x.vue",
  svelte: "x.svelte",
  astro: "x.astro",
  handlebars: "x.hbs",
  twig: "x.twig",
  jinja: "x.jinja",
  liquid: "x.liquid",
  razor: "x.cshtml",
  graphql: "x.graphql",
  mermaid: "x.mmd",
  // Languages
  python: "x.py",
  ruby: "x.rb",
  coffee: "x.coffee",
  go: "x.go",
  rust: "x.rs",
  zig: "x.zig",
  java: "x.java",
  kotlin: "x.kt",
  scala: "x.scala",
  groovy: "x.groovy",
  c: "x.c",
  cpp: "x.cpp",
  "objective-c": "x.m",
  swift: "x.swift",
  csharp: "x.cs",
  fsharp: "x.fs",
  vb: "x.vb",
  php: "x.php",
  dart: "x.dart",
  elixir: "x.ex",
  erlang: "x.erl",
  perl: "x.pl",
  lua: "x.lua",
  luau: "x.luau",
  nim: "x.nim",
  haskell: "x.hs",
  ocaml: "x.ml",
  elm: "x.elm",
  clojure: "x.clj",
  racket: "x.rkt",
  julia: "x.jl",
  r: "x.r",
  pascal: "x.pas",
  prolog: "x.pro",
  crystal: "x.cr",
  d: "x.d",
  haxe: "x.hx",
  cobol: "x.cob",
  gdscript: "x.gd",
  f90: "x.f90",
  matlab: "x.matlab",
  purescript: "x.purs",
  tcl: "x.tcl",
  awk: "x.awk",
  solidity: "x.sol",
  vala: "x.vala",
  verilog: "x.v",
  "system-verilog": "x.sv",
  vhdl: "x.vhdl",
  glsl: "x.glsl",
  hlsl: "x.hlsl",
  asm: "x.asm",
  wasm: "x.wat",
  // Shell, config, data
  shellscript: "x.sh",
  shellsession: "x.sh",
  powershell: "x.ps1",
  bat: "x.bat",
  docker: "Dockerfile",
  make: "Makefile",
  cmake: "x.cmake",
  hcl: "x.hcl",
  terraform: "x.tf",
  nix: "x.nix",
  toml: "x.toml",
  yaml: "x.yaml",
  ini: "x.ini",
  dotenv: "x.env",
  reg: "x.reg",
  http: "x.http",
  xml: "x.xml",
  csv: "x.csv",
  tsv: "x.csv",
  prisma: "x.prisma",
  proto: "x.proto",
  cue: "x.cue",
  ron: "x.ron",
  sql: "x.sql",
  plsql: "x.sql",
  sparql: "x.sparql",
  kql: "x.kql",
  log: "x.log",
  diff: "x.diff",
  // Prose
  markdown: "x.md",
  asciidoc: "x.adoc",
  rst: "x.rst",
  org: "x.org",
  latex: "x.tex",
  plaintext: "x.txt",
};

/**
 * The file name to resolve an icon from for a fence's info string, or `undefined` when the
 * language has no glyph of its own. `x.` prefixes are not decoration: `resolveFileIcon`
 * matches on the extension, and a couple of names (`Dockerfile`, `Makefile`) are only known
 * to the manifest as whole file names.
 */
export function codeFenceIconName(language?: string): string | undefined {
  const word = language?.trim().toLowerCase();
  if (!word) return undefined;
  // An unknown word is not a language: `sqlite` must not borrow `sql`'s mark by prefix.
  const id = resolveLanguage(word) ?? word;
  // `hasOwn`, not a lookup — a fence may read `constructor`, and the prototype chain is
  // not a language (the same reason `resolveLanguage` checks it).
  return Object.hasOwn(LANGUAGE_FILE, id) ? LANGUAGE_FILE[id] : undefined;
}

/** Exported for the test, which walks it against the shipped manifest. */
export const CODE_FENCE_ICON_LANGUAGES = Object.keys(LANGUAGE_FILE);
