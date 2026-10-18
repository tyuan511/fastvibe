/**
 * Turn a VS Code file-icon theme (`contributes.iconThemes[].path`) into the compact lookup
 * FastVibe's renderer consumes.
 *
 * This module is pure on purpose — `node --test` loads it, and `scripts/vendor-file-icons.mjs`
 * is the only thing that touches the network or the filesystem.
 *
 * The wrinkle worth knowing: **vscode-icons maps most file types by VS Code language id, not by
 * extension** (599 extensions, 1923 file names, but 558 language ids — `.ts`, `.py` and `.md` are
 * all language-only). FastVibe resolves icons from a file *name* and has no language service, so
 * folding those ids back onto their extensions is what makes `.ts` anything other than a blank
 * page. `LANGUAGE_EXTENSIONS` is that table; an id missing from it degrades to the generic file
 * glyph and is reported by the vendor script rather than silently lost.
 */

/**
 * Language id → the extensions that id is used for. Keys must be the id vscode-icons itself
 * writes (`objective-c`, not `objective-c` spelled as a JS identifier); the vendor script prints
 * every id it could not fold, so a typo shows up as a long tail rather than a wrong icon.
 *
 * Deliberately incomplete: befunge, lolcode, wurst and the rest of the exotic tail fall back to
 * the generic file glyph, exactly as they do for any file type no mapping names.
 */
export const LANGUAGE_EXTENSIONS = {
  actionscript: ["as"],
  ada: ["adb", "ads"],
  ansible: ["yaml"],
  apiblueprint: ["apib"],
  applescript: ["applescript"],
  asciidoc: ["adoc", "asc"],
  asm: ["asm", "s"],
  astro: ["astro"],
  autoit: ["au3"],
  ballerina: ["bal"],
  bat: ["bat", "cmd"],
  bazel: ["bazel"],
  bicep: ["bicep"],
  blade: ["blade.php"],
  c: ["c"],
  cabal: ["cabal"],
  clojure: ["clj", "cljc", "edn"],
  clojurescript: ["cljs"],
  cmake: ["cmake"],
  cobol: ["cbl", "cob"],
  coffeescript: ["coffee"],
  cpp: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
  crystal: ["cr"],
  csharp: ["cs", "csx"],
  css: ["css"],
  csv: ["csv"],
  cucumber: ["feature"],
  cuda: ["cu", "cuh"],
  cue: ["cue"],
  cython: ["pyx", "pxd", "pxi"],
  d: ["d", "di"],
  dart: ["dart"],
  dhall: ["dhall"],
  diff: ["diff", "patch"],
  dockerfile: ["dockerfile"],
  dotenv: ["env"],
  earthfile: ["earthfile"],
  elixir: ["ex", "exs"],
  elm: ["elm"],
  erlang: ["erl", "hrl"],
  es: ["es"],
  fortran: ["f", "for", "f90", "f95"],
  fsharp: ["fs", "fsi", "fsx"],
  ftl: ["ftl"],
  gdscript: ["gd"],
  glsl: ["glsl", "vert", "frag"],
  gleam: ["gleam"],
  go: ["go"],
  graphql: ["graphql", "gql"],
  groovy: ["groovy", "gvy"],
  haml: ["haml"],
  handlebars: ["handlebars", "hbs"],
  haskell: ["hs"],
  haxe: ["hx"],
  hcl: ["tf", "tfvars", "hcl"],
  hjson: ["hjson"],
  hlsl: ["hlsl"],
  html: ["html", "htm", "xhtml"],
  http: ["http"],
  ini: ["ini", "cfg", "conf"],
  io: ["io"],
  java: ["java"],
  javascript: ["js", "mjs", "cjs"],
  javascriptreact: ["jsx"],
  jinja: ["j2", "jinja"],
  json: ["json"],
  json5: ["json5"],
  jsonc: ["jsonc"],
  jsonnet: ["jsonnet", "libsonnet"],
  julia: ["jl"],
  kotlin: ["kt"],
  kotlinscript: ["kts"],
  kusto: ["kql"],
  latex: ["tex", "sty", "cls", "ltx"],
  lean4: ["lean"],
  less: ["less"],
  lex: ["l"],
  liquid: ["liquid"],
  lisp: ["lisp", "lsp", "cl"],
  lua: ["lua"],
  makefile: ["makefile", "mk"],
  markdown: ["md", "markdown"],
  matlab: ["matlab"],
  mermaid: ["mmd", "mermaid"],
  meson: ["meson"],
  metal: ["metal"],
  mjml: ["mjml"],
  mustache: ["mustache"],
  nix: ["nix"],
  nim: ["nim", "nims"],
  nunjucks: ["njk"],
  "objective-c": ["m"],
  "objective-cpp": ["mm"],
  ocaml: ["ml", "mli"],
  pascal: ["pas", "dpr"],
  perl: ["pl", "pm"],
  php: ["php", "phtml"],
  plaintext: ["txt"],
  plsql: ["pls", "pck", "pkb", "pks"],
  pony: ["pony"],
  postgres: ["pgsql"],
  powershell: ["ps1", "psm1", "psd1"],
  prisma: ["prisma"],
  prolog: ["pro"],
  properties: ["properties"],
  proto: ["proto"],
  puppet: ["pp"],
  purescript: ["purs"],
  python: ["py", "pyi"],
  qml: ["qml", "qbs"],
  qsharp: ["qs"],
  r: ["r"],
  racket: ["rkt"],
  raku: ["raku", "rakumod"],
  raml: ["raml"],
  razor: ["cshtml"],
  reason: ["re", "rei"],
  rescript: ["res", "resi"],
  restructuredtext: ["rst"],
  ruby: ["rb", "erb", "gemspec", "rake", "ru"],
  rust: ["rs"],
  SAS: ["sas"],
  sass: ["sass"],
  scala: ["scala", "sc"],
  scss: ["scss"],
  shellscript: ["sh", "bash", "zsh", "ksh"],
  slim: ["slim"],
  slint: ["slint"],
  smarty: ["tpl"],
  solidity: ["sol"],
  sparql: ["sparql", "rq"],
  sql: ["sql"],
  squirrel: ["nut"],
  stan: ["stan"],
  stylus: ["styl"],
  svelte: ["svelte"],
  swift: ["swift"],
  systemverilog: ["sv", "svh"],
  tablegen: ["td"],
  tailwindcss: ["css"],
  templ: ["templ"],
  terraform: ["tf", "tfvars"],
  tex: ["tex"],
  toml: ["toml"],
  twig: ["twig"],
  typescript: ["ts", "mts", "cts"],
  typescriptreact: ["tsx"],
  unison: ["u"],
  vb: ["vb"],
  velocity: ["vm"],
  verilog: ["v", "vh"],
  vhdl: ["vhdl", "vhd"],
  viml: ["vim"],
  vue: ["vue"],
  vyper: ["vy"],
  wasm: ["wasm"],
  wat: ["wat"],
  xml: ["xml", "xsd", "plist"],
  xslt: ["xslt"],
  yacc: ["y"],
  yaml: ["yaml", "yml"],
  yang: ["yang"],
  zig: ["zig"],
};

const ICON_SUFFIX = ".svg";

function baseName(iconPath) {
  return (iconPath ?? "").split(/[/\\]/).pop().replace(new RegExp(`\\${ICON_SUFFIX}$`), "");
}

/**
 * @param {Record<string, any>} theme a parsed VS Code icon-theme JSON
 * @param {{ languageExtensions?: Record<string, string[]> }} [options]
 * @returns {{ manifest: Record<string, any>, icons: Set<string>, skippedLanguages: string[] }}
 */
export function normalizeIconTheme(theme, options = {}) {
  const languageExtensions = options.languageExtensions ?? LANGUAGE_EXTENSIONS;
  const definitions = theme.iconDefinitions ?? {};
  const icons = new Set();
  /** Definition id → the icon name we ship, or null when that id names nothing on disk. */
  const nameOf = (id) => {
    const def = typeof id === "string" ? definitions[id] : id;
    const name = def?.iconPath ? baseName(def.iconPath) : "";
    if (!name) return null;
    icons.add(name);
    return name;
  };

  const fold = (source, clean) => {
    const out = {};
    for (const [key, id] of Object.entries(source ?? {})) {
      const name = nameOf(id);
      const normalized = clean ? clean(key) : key;
      if (name && normalized) out[normalized] = name;
    }
    return out;
  };

  const lower = (value) => String(value).toLowerCase();
  const bare = (value) => String(value).replace(/^\.+/, "").toLowerCase();

  /** One full set of maps: a theme (or its `light` override block) folded into lookups. */
  const build = (source) => {
    const fileExtensions = fold(source.fileExtensions, bare);
    const fileNames = fold(source.fileNames, lower);
    const folderNames = fold(source.folderNames, lower);
    const folderNamesExpanded = fold(source.folderNamesExpanded, lower);
    const skipped = foldLanguageIds(source, fileExtensions);
    return {
      fileExtensions,
      fileNames,
      folderNames,
      folderNamesExpanded,
      file: nameOf(source.file) ?? null,
      folder: nameOf(source.folder) ?? null,
      folderExpanded: nameOf(source.folderExpanded) ?? null,
      skipped,
    };
  };

  const foldLanguageIds = (source, fileExtensions) => {
    // Language ids fill the gaps only: an extension the theme maps on its own always wins.
    // Two passes, because several ids claim the same extension — `ansible` and `yaml` both want
    // `.yaml`. The id that *is* the extension name owns it: an unrelated language claiming
    // someone else's extension is a secondary mapping (Ansible files are YAML), so it fills only
    // what nobody else took.
    const skippedLanguages = [];
    const entries = Object.entries(source.languageIds ?? {});
    const ownsItsExtension = ([language]) =>
      (languageExtensions[bare(language)] ?? []).includes(bare(language));
    for (const [language, id] of [...entries].sort((a, b) => Number(ownsItsExtension(b)) - Number(ownsItsExtension(a)))) {
      const extensions = languageExtensions[language];
      if (!extensions?.length) {
        // Nothing to fold with — report it unless the id already names an extension directly.
        if (!fileExtensions[bare(language)]) skippedLanguages.push(language);
        continue;
      }
      const name = nameOf(id);
      if (!name) continue;
      for (const extension of extensions) {
        const key = bare(extension);
        if (key && !fileExtensions[key]) fileExtensions[key] = name;
      }
    }
    return skippedLanguages;
  };

  const base = build(theme);
  const manifest = {
    schema: 2,
    fileExtensions: base.fileExtensions,
    fileNames: base.fileNames,
    folderNames: base.folderNames,
    folderNamesExpanded: base.folderNamesExpanded,
    file: base.file ?? "default_file",
    folder: base.folder ?? manifest.file,
    folderExpanded: base.folderExpanded ?? base.folder ?? manifest.file,
  };

  // **vscode-icons ships a `light` block: the same mappings with different glyphs for light
  // colour themes** (a dark-on-white logo has nothing to bite into a white editor row). It is a
  // full clone of every map, so only what actually differs is kept — the renderer resolves a
  // light-theme name by trying the override and falling back to the set above.
  if (theme.light && typeof theme.light === "object") {
    const merged = { iconDefinitions: definitions };
    for (const key of ["file", "folder", "folderExpanded", "fileExtensions", "fileNames", "folderNames", "folderNamesExpanded", "languageIds"]) {
      const value = theme.light[key] ?? theme[key];
      if (value !== undefined) merged[key] = value;
    }
    const light = build(merged);
    const diffs = {};
    for (const key of ["file", "folder", "folderExpanded", "fileExtensions", "fileNames", "folderNames", "folderNamesExpanded"]) {
      if (key === "fileExtensions" || key === "fileNames" || key === "folderNames" || key === "folderNamesExpanded") {
        const kept = Object.fromEntries(
          Object.entries(light[key]).filter(([name, icon]) => manifest[key][name] !== icon),
        );
        if (Object.keys(kept).length) diffs[key] = kept;
      } else if (light[key] && light[key] !== manifest[key]) {
        diffs[key] = light[key];
      }
    }
    if (Object.keys(diffs).length) manifest.light = diffs;
    return { manifest, icons, skippedLanguages: base.skipped };
  }

  return { manifest, icons, skippedLanguages: base.skipped };
}
