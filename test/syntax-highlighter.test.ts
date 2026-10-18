import { test } from "node:test";
import assert from "node:assert/strict";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import {
  LANGUAGE_ALIASES,
  LANGUAGE_LOADERS,
  StreamingHighlighter,
  embeddedLanguages,
  resolveLanguage,
} from "../src/renderer/src/lib/syntax-highlighter.ts";

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, "")
    .replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

test("streamed code retains completed lines and recolors the unfinished token", async () => {
  const stream = new StreamingHighlighter("ts");
  const partial = await stream.highlight("cons");
  const keyword = await stream.highlight("const");
  assert.notEqual(partial, keyword);
  assert.match(keyword, /var\(--shiki-token-keyword\)/);

  const line = "const value = 42;\n";
  const first = await stream.highlight(line);
  const second = await stream.highlight(`${line}// next`);
  assert.equal(textOf(second), `${line}// next`);
  assert.ok(second.startsWith(first.replace("</code></pre>", "")));
  assert.match(second, /var\(--shiki-token-comment\)/);
});

test("every chunk is visible, including newlines, tabs, unicode and unfinished lines", async () => {
  const stream = new StreamingHighlighter("javascript");
  let code = "";
  for (const chunk of ["const ", "label = ", '"中文😀";', "\n", "\n", "\t", "/* open", "\n", "comment", " */", "\n"]) {
    code += chunk;
    assert.equal(textOf(await stream.highlight(code)), code);
  }
  assert.equal(textOf(await stream.highlight(code)), code, "repeated input does not duplicate tokens");
});

test("grammar state crosses chunks and completed lines", async () => {
  const stream = new StreamingHighlighter("ts");
  await stream.highlight("/* start\n");
  const html = await stream.highlight("/* start\ninside");
  assert.match(html, /style="color:var\(--shiki-token-comment\)">inside<\/span>/);
  const closed = await stream.highlight("/* start\ninside */\nconst x = 1");
  assert.match(closed, /style="color:var\(--shiki-token-keyword\)">const<\/span>/);
});

test("replacement, truncation and empty input reset the prior grammar state", async () => {
  const stream = new StreamingHighlighter("ts");
  await stream.highlight("/* open\ncomment");
  const replacement = await stream.highlight("const x = 1");
  assert.equal(textOf(replacement), "const x = 1");
  assert.match(replacement, /var\(--shiki-token-keyword\)/);
  assert.equal(textOf(await stream.highlight("const")), "const");
  assert.equal(textOf(await stream.highlight("")), "");
  assert.equal(textOf(await stream.highlight("let y = 2")), "let y = 2");
});

test("queued updates stay ordered while the grammar loads", async () => {
  const stream = new StreamingHighlighter("python");
  const codes = ["def", "def f():\n", "def f():\n    return 1", "x = 2"];
  const results = await Promise.all(codes.map((code) => stream.highlight(code)));
  assert.deepEqual(results.map(textOf), codes);
});

test("unknown languages and oversized snippets safely fall back to plain text", async () => {
  const code = '<script>alert("x")</script> & <img src=x onerror="bad()">';
  for (const language of [undefined, "not-a-language", "__proto__", "constructor"]) {
    const html = await new StreamingHighlighter(language).highlight(code);
    assert.equal(textOf(html), code);
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<img"));
  }
  const stream = new StreamingHighlighter("html");
  const large = `<${"x".repeat(120_000)}>`;
  assert.equal(textOf(await stream.highlight(large)), large);
  assert.equal(textOf(await stream.highlight("<div>ok</div>")), "<div>ok</div>");
});

test("language aliases and themed colors survive the Shiki upgrade", async () => {
  const code = "const x = 1";
  assert.equal(await new StreamingHighlighter("TS").highlight(code), await new StreamingHighlighter("typescript").highlight(code));
  for (const [language, snippet] of [
    ["tsx", 'const el = <div title="hi" />'],
    ["vue", '<template><div>{{ text }}</div></template>'],
    ["bash", 'echo "$HOME"'],
    ["json", '{"key": true}'],
    ["css", ".foo { color: red; }"],
  ]) {
    const html = await new StreamingHighlighter(language).highlight(snippet);
    assert.equal(textOf(html), snippet);
    assert.match(html, /var\(--shiki-/);
  }
});

/**
 * The two language tables are a list of promises: every id offered must actually be a name
 * the loaded grammar answers to, and every alias must point at one. Neither half is checked
 * by TypeScript — a key that no grammar registers, or an alias naming a language that was
 * never added to the loaders, costs nothing at build time and shows up as a silently plain
 * code block in the chat.
 */
test("every offered language id is registered by its grammar", async () => {
  const highlighter = await createHighlighterCore({
    themes: [await import("shiki/themes/nord.mjs").then((m) => m.default)],
    langs: [],
    engine: createOnigurumaEngine(() => import("shiki/wasm")),
  });
  for (const [id, loader] of Object.entries(LANGUAGE_LOADERS)) {
    await highlighter.loadLanguage(loader);
    assert.ok(
      highlighter.getLoadedLanguages().includes(id),
      `${id}: its grammar does not answer to this id, so highlighting it falls back to plaintext`,
    );
  }
});

test("every alias names a language the module can load", () => {
  for (const [alias, id] of Object.entries(LANGUAGE_ALIASES)) {
    if (id === "plaintext") continue;
    assert.ok(Object.hasOwn(LANGUAGE_LOADERS, id), `${alias} → ${id}: no such grammar`);
    // The loaders are tried first, so an entry that names its own key is dead weight —
    // and proof the table was written by copying ids rather than by naming a real alias.
    assert.notEqual(alias, id, `${alias}: an alias that is already a language id`);
  }
});

test("the names models and file extensions actually write resolve", () => {
  // A model's fence word or a file's extension: most of these are the grammar's own alias,
  // some are only in the table above, and none may quietly fall back to plaintext. Main
  // hands the preview the bare extension whenever its own map has no entry for it.
  const names = [
    "ts", "mts", "cts", "tsx", "js", "mjs", "cjs", "jsx", "jsonc", "json5", "jsonl", "ndjson", "geojson",
    "yaml", "yml", "toml", "hcl", "tf", "tfvars", "nix", "kdl", "ron", "ini", "conf", "properties", "editorconfig", "env",
    "md", "mdx", "adoc", "asciidoc", "rst", "typ", "bib", "tex", "org", "plaintext", "text", "txt",
    "sh", "bash", "zsh", "shell-session", "console", "bat", "cmd", "ps1", "pwsh", "nu", "justfile", "nushell",
    "dockerfile", "containerfile", "makefile", "mk", "cmake", "apacheconf", "http", "hurl", "log", "reg", "systemd",
    "py", "py3", "rb", "rakefile", "gemfile", "rs", "go", "kt", "kts", "sbt", "gradle", "swift", "objc", "mm",
    "h", "hpp", "cxx", "cs", "fs", "fsharp", "vbnet", "php", "phtml", "pl", "pm", "perl6", "raku",
    "ex", "exs", "erl", "hs", "ml", "mli", "clj", "cljs", "jl", "r", "sol", "proto", "protobuf", "gql", "ddl", "plsql",
    "dart", "lua", "luau", "nim", "zig", "odin", "vala", "v", "d", "crystal", "haxe", "abap", "cobol", "f95", "fortran",
    "matlab", "octave", "mathematica", "purescript", "lean", "coq", "tcl", "awk", "wat", "wasm", "asm", "nasm",
    "glsl", "wgsl", "hlsl", "verilog", "systemverilog", "vhdl", "mmd", "mermaid", "graphql", "prisma", "kusto", "sparql", "turtle",
    "html", "htm", "xhtml", "svg", "xml", "xslt", "plist", "vue", "svelte", "astro", "razor", "cshtml", "blade", "liquid",
    "jinja", "njk", "handlebars", "hbs", "mustache", "pug", "jade", "twig", "patch", "codeowners", "xlf", "rss", "nginx",
  ];
  for (const name of names) {
    assert.ok(resolveLanguage(name), `${name}: neither a grammar id nor an alias`);
  }
  // What the catalog genuinely does not have, so a reader knows a flat block is honest here.
  assert.equal(resolveLanguage("tlaplus"), undefined);
  assert.equal(resolveLanguage("gitignore"), undefined);
});

test("a language resolves through its own id, its aliases, and not at all otherwise", () => {
  assert.equal(resolveLanguage("TypeScript"), "typescript");
  assert.equal(resolveLanguage("ts"), "typescript");
  assert.equal(resolveLanguage("dockerfile"), "docker");
  assert.equal(resolveLanguage("shell-session"), "shellsession");
  assert.equal(resolveLanguage("text"), "plaintext");
  assert.equal(resolveLanguage("definitely-not-a-language"), undefined);
  assert.equal(resolveLanguage(undefined), undefined);
  // An inherited Object property must not read as a language: these names are user input.
  assert.equal(resolveLanguage("__proto__"), undefined);
  assert.equal(resolveLanguage("constructor"), undefined);
});

/**
 * The behaviour the loader list exists for, and the reason a language list alone is not
 * enough. `markdown.mjs`, `mdx.mjs` and `asciidoc.mjs` ship one grammar each and colour a
 * fenced block by *including another grammar's scope name*, so a nested fence stays flat
 * until that grammar is loaded too — the other languages bundle what they embed.
 */
for (const host of ["markdown", "mdx", "asciidoc"]) {
  test(`${host} colours the html inside it`, async () => {
    const code = `# Title\n\n\`\`\`html\n<div class="a">hi</div>\n\`\`\`\n`;
    const html = await new StreamingHighlighter(host).highlight(code);
    assert.equal(textOf(html), code);
    // The attribute value gets a token style of its own. Without the grammar the whole line
    // is one foreground run and nothing here matches.
    assert.match(html, /--shiki-token-string-expression[^"]*">&quot;a&quot;/);
  });
}

test("a markdown block asks only for the languages its fences name", () => {
  assert.deepEqual(embeddedLanguages("prose, no fences here\n"), []);
  assert.deepEqual(embeddedLanguages("```html\n<p>x</p>\n```\n"), ["html"]);
  assert.deepEqual(
    embeddedLanguages("```py\nx = 1\n```\n```mermaid\nA-->B\n```\n```notalanguage\n```\n```text\n```\n```python\ny = 2\n```\n"),
    ["python", "mermaid"],
  );
});

test("the fence scan reads openings, not everything that looks like backticks", () => {
  const notFences = [
    "A closing fence: ```",
    "    ```js — four spaces is an indented code block, not a fence",
    "Inline `code` and a `js` mention",
    "~~~ notalanguage ~~~",
  ].join("\n");
  assert.deepEqual(embeddedLanguages(notFences), []);
  // Attributes and metadata after the info word are the grammar's problem, not ours.
  assert.deepEqual(embeddedLanguages("```js title=\"a.js\"\n1\n```"), ["javascript"]);
  assert.deepEqual(embeddedLanguages("~~~python\n1\n~~~\n"), ["python"]);
});

test("a streamed markdown block is re-tokenized when a new fence language arrives", async () => {
  const code = "# Title\n\n```html\n<div class=\"a\">hi</div>\n```\n\n```python\ndef f(x):\n    return x\n```\n";
  const stream = new StreamingHighlighter("markdown");
  // The html fence arrives first, and at that moment nothing but `html` is asked for.
  await stream.highlight(code.slice(0, code.indexOf("```python")));
  const html = await stream.highlight(code);
  assert.equal(textOf(html), code, "re-tokenizing the block loses nothing");
  assert.match(html, /--shiki-token-string-expression[^"]*">&quot;a&quot;/);
  assert.match(html, /style="color:var\(--shiki-token-keyword\)">def<\/span>/);
});
